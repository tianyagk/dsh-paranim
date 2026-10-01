/**
 * dsh-paranim — 引擎规则层（纯函数，不依赖任何运行时）。
 *
 * 这里回答一个问题：**一个智能体声明了动作之后，世界发生什么？**
 * 输入是纯数据（沙盒 + 运行态 + 动作），输出是纯数据（事件 + 判定 + 状态改动），
 * 因此 host 与 client 都能引用，也能脱离运行时单测。
 *
 * 设计立场：世界状态由动作**显式声明**的 `mutations` 驱动，而不是引擎事后比对
 * 新旧快照去猜。猜出来的 diff 无法区分"发生过的动作"与"巧合状态相同"，复盘
 * 会失真；显式声明让每条状态变化都能追到是谁、哪一步、用什么权限做的。
 */

import {
  ATTR_EN,
  DEFAULT_DIFFICULTY,
  DIFFICULTY_LADDER,
  ACTION_LABEL,
  adjudicate,
  difficultyOf,
  isActionKind,
  isAttrId,
  normalizeAttrs,
  resolveCheck,
  shortId,
  toStateValue,
  type AgentAction,
  type AgentActionKind,
  type AttrId,
  type CheckMod,
  type MemoryEntry,
  type RollRecord,
  type RunAgent,
  type RunState,
  type Sandbox,
  type StateValue,
  type WorldEvent,
  type WorldObject,
} from './model.ts'
import { objectsOf, passAt, positionOfObjectId, setObjectState } from './tilemap.ts'

/** 判定用的随机源；注入以便测试确定化。 */
export interface Rng {
  /** 返回 1..6 的整数。 */
  d6(): number
}

export const realRng: Rng = {
  d6: () => 1 + Math.floor(Math.random() * 6),
}

/** 固定的随机源（单测用）。 */
export function seqRng(values: readonly number[]): Rng {
  let i = 0
  return {
    d6: () => {
      const v = values[i % values.length]
      i += 1
      return v
    },
  }
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  return Math.round(Math.hypot(ax - bx, ay - by))
}

/** 找出坐标所在的地标（含边界，取面积最小者＝最具体的那一个）。 */
export function placeAt(sandbox: Sandbox, x: number, y: number): WorldObject | undefined {
  let best: WorldObject | undefined
  let bestArea = Number.POSITIVE_INFINITY
  for (const place of sandbox.places) {
    const w = typeof place.w === 'number' ? place.w : 0
    const h = typeof place.h === 'number' ? place.h : 0
    const inside = x >= place.x - w / 2 && x <= place.x + w / 2 && y >= place.y - h / 2 && y <= place.y + h / 2
    if (!inside) continue
    const area = Math.max(1, w * h)
    if (area < bestArea) {
      best = place
      bestArea = area
    }
  }
  return best
}

/**
 * 按 id 找"一个东西"：地标（WorldObject）或格子上的物件（TileObject）。
 *
 * 两者的形状不同但引擎只关心 name/x/y/state，所以统一成一个宽视图。
 * 物件 id 形如 obj:x,y，由格坐标反解——状态就挂在那格上，永不错位。
 */
export function findObject(
  sandbox: Sandbox,
  id: string | undefined,
): { name: string; x: number; y: number; state: Record<string, unknown>; id: string; desc?: string; color?: string; interactive?: boolean; lastEditedBy?: string; lastEditedAt?: number } | undefined {
  if (id === undefined || id === '') return undefined
  const place = sandbox.places.find((p) => p.id === id)
  if (place !== undefined) return place
  const tileObj = objectsOf(sandbox.map).find((o) => o.id === id)
  return tileObj
}

function findAgent(run: RunState, id: string | undefined): RunAgent | undefined {
  if (id === undefined || id === '') return undefined
  return run.agents.find((a) => a.id === id)
}

// ── 移动边界（三个图层一起决定）──────────────────────────────────────────
//
// 换到瓦片模型之后，这一节比上一版短得多——因为它要回答的问题变简单了：
// **"这一格是什么"现在有唯一答案**。旧版里建筑是矩形反推出来的，于是要特判
// 两栋楼重叠、房间互相嵌套、一栋的门正好压在邻居墙上……那些都不是真实世界
// 的规则，是数据模型的缺陷泄漏到了判定里。

/**
 * 目标格能不能进。
 *
 * 通行性完全来自图集里**人标过的**注释（见 TileNote.pass），所以"这里画的是
 * 水"与"这里过不去"是同一份数据，不会出现画了水却能走过去的错位。
 */
/**
 * 站在地图上的人。
 *
 * 智能体是**不可穿透**的：一格只能站一个人。这不只是观感问题——两人重合
 * 之后，之后所有基于"谁在哪"的判断（谁离这个东西近、谁先够得着、谁在场）
 * 都会同时命中两个人，而那种错误一点都不显眼。
 */
export interface Occupancy {
  cells: ReadonlyArray<{ id: string; x: number; y: number }>
  /** 移动者自己：它正站在自己那一格上，不该把自己挡住。 */
  except?: string
}

export function canEnter(
  sandbox: Sandbox,
  x: number,
  y: number,
  occupied?: Occupancy,
): { ok: boolean; reason?: string } {
  if (x < 0 || y < 0 || x >= sandbox.map.width || y >= sandbox.map.height) {
    return { ok: false, reason: '在地图之外' }
  }
  const pass = passAt(sandbox.map, x, y)
  if (pass === 'block') return { ok: false, reason: '被墙或障碍挡住' }
  if (pass === 'water') return { ok: false, reason: '是一片水面' }
  if (pass === 'lava') return { ok: false, reason: '是滚烫的岩浆' }
  if (occupied !== undefined) {
    const other = occupied.cells.find((c) => c.id !== occupied.except && c.x === x && c.y === y)
    if (other !== undefined) return { ok: false, reason: '已经有人站在那儿' }
  }
  return { ok: true }
}

/**
 * 沿途每一格能不能走。
 *
 * 上一步把"走近处"改成直接到达（不再掷骰）之后，**只查落点**就出事了：
 * 中间隔着一堵墙也能一步迈过去。用户看到的正是"行动和身边的环境无关"——
 * 因为地形实际上不参与判定，只有目的地那一格算数。
 *
 * 这里按直线插值把沿途走一遍。不做真正的寻路（那要引一套图算法，而沙盒
 * 的地形简单、直线上有墙时玩家本来也会换个方向），但"隔着墙走不过去"
 * 这条必须是硬的——它就是墙存在的意义。
 */
export function pathBlocked(
  sandbox: Sandbox,
  from: { x: number; y: number },
  to: { x: number; y: number },
  occupied?: Occupancy,
): string | undefined {
  const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y))
  if (steps === 0) return undefined
  for (let i = 1; i <= steps; i += 1) {
    const x = Math.round(from.x + ((to.x - from.x) * i) / steps)
    const y = Math.round(from.y + ((to.y - from.y) * i) / steps)
    const r = canEnter(sandbox, x, y, occupied)
    if (!r.ok) return `途中 (${x},${y}) ${r.reason}`
  }
  return undefined
}


/**
 * 目标格进不去时，在附近找一格能站的（由近及远）。
 *
 * 地标坐标是**逻辑位置**（"咖啡馆在哪儿"），不一定正好落在一格能站的地面上——
 * 它可能压在柜台上、墙上，或者正好是门口那一格。"我要去咖啡馆"这个意图是
 * 合理的，不该因为落点差一格就整个失败，所以退到最近能站的格子。
 */
export function nearestOpen(sandbox: Sandbox, x: number, y: number, radius = 4, occupied?: Occupancy): { x: number; y: number } | undefined {
  if (canEnter(sandbox, x, y, occupied).ok) return { x, y }
  let best: { x: number; y: number } | undefined
  let bestD = Number.POSITIVE_INFINITY
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const nx = x + dx
      const ny = y + dy
      if (!canEnter(sandbox, nx, ny, occupied).ok) continue
      const d = dx * dx + dy * dy
      if (d < bestD) { bestD = d; best = { x: nx, y: ny } }
    }
  }
  return best
}

type SizeAware = { w?: number; h?: number }

/**
 * 移动难度：距离越远越难，目标地标拥挤或要穿过整张图时更难。
 * 十几格的短途是「容易」，跨镇是「艰难」，这给"去哪儿"这件事本身制造张力。
 */
/**
 * 多近算"日常走动"。
 *
 * 用户反馈："每次行动都要进行属性检定"——走过去看看、在屋里挪两步这种事
 * 没有失败的意义，每次都赌一把只会把推演变成骰子表演，而且"判定成功"
 * 这个结果本身也不再传达任何信息。
 *
 * 只有**有挑战性的行动**才掷骰：长途赶路、跨镇、有人阻拦、明确要判定的
 * 动作（take/check/flee）、以及改动别人东西时的阻力。走近处不掷。
 */
export const TRIVIAL_MOVE_DIST = 6

/** 这次移动值不值得掷骰。 */
export function moveNeedsCheck(dist: number): boolean {
  return dist > TRIVIAL_MOVE_DIST
}

export function moveDifficulty(dist: number): { step: (typeof DIFFICULTY_LADDER)[number]; mods: CheckMod[] } {
  const mods: CheckMod[] = []
  let step = DIFFICULTY_LADDER[1] // 容易 9
  if (dist > 60) step = DIFFICULTY_LADDER[4] // 艰难 15
  else if (dist > 35) step = DIFFICULTY_LADDER[3] // 棘手 13
  else if (dist > 15) step = DIFFICULTY_LADDER[2] // 常规 11
  if (dist > 35) mods.push({ label: `长途 ${dist} 格`, value: 1 })
  if (dist <= 3) mods.push({ label: '就在旁边', value: 1 })
  return { step, mods }
}

/** 依据动作里的难度档位解析目标数；缺省用常规。 */
function difficultyFromAction(action: AgentAction): number {
  if (action.difficultyId === undefined || action.difficultyId === '') return DEFAULT_DIFFICULTY
  return difficultyOf(action.difficultyId).value
}

interface ActionContext {
  sandbox: Sandbox
  run: RunState
  agent: RunAgent
  rng: Rng
  /** 该步的时间戳。 */
  ts: number
  /**
   * 玩家（或 GM 工具）代下的改动：跳过硬性距离校验。
   * 智能体自己改物体时**必须**在够得着的范围内，否则会退回判定。
   */
  operator?: 'agent' | 'gm'
}

interface ActionOutcome {
  /** 进入公共事件流的条目。 */
  events: WorldEvent[]
  /** 该智能体的私有记忆。 */
  memory: MemoryEntry[]
  /** 属性到属性对抗的结果（攻击/挣脱）。 */
  rolls: RollRecord[]
  /** 该智能体的新坐标（未移动则与原来相同）。 */
  x: number
  y: number
  /** 状态改动（已应用，也记进事件）。 */
  mutations: Array<{ objectId: string; key: string; before: StateValue; after: StateValue }>
  /** 是否因为失败而没有产生任何公共事件（空步）。 */
  empty: boolean
}

function mkEvent(partial: Omit<WorldEvent, 'id' | 'ts' | 'tick'> & { tick?: number }, run: RunState, ts: number): WorldEvent {
  return {
    id: shortId('ev'),
    tick: partial.tick ?? run.tick,
    ts,
    kind: partial.kind,
    actor: partial.actor,
    actorName: partial.actorName,
    text: partial.text,
    targetId: partial.targetId,
    targetAgentId: partial.targetAgentId,
    from: partial.from,
    to: partial.to,
    mutations: partial.mutations,
    roll: partial.roll,
  }
}

/**
 * 落一条状态改动。
 *
 * 物件的状态挂在 object 层的格子上（setObjectState 直写那格），所以不存在
 * "改了临时副本、写不回地图"的问题——旧版 objectsOf 返回的是新数组，
 * 直接在上面临时对象上改等于白改，这类错只能在运行时暴露，所以这里
 * 刻意只走 setObjectState 这一条路。
 */
function applyMutation(
  sandbox: Sandbox,
  objectId: string,
  key: string,
  value: StateValue,
): { objectId: string; key: string; before: StateValue; after: StateValue } | undefined {
  const target = findObject(sandbox, objectId)
  if (target === undefined) return undefined
  const pos = positionOfObjectId(objectId)
  const isTile = pos !== undefined
  const before = (target.state[key] ?? null) as StateValue
  const after = value
  if (before === after) return undefined
  if (isTile) {
    setObjectState(sandbox.map, pos.x, pos.y, { [key]: value })
  } else {
    // 地标：WorldObject 的 state 直接改
    if (after === null) delete target.state[key]
    else target.state[key] = after
  }
  return { objectId, key, before, after }
}

/** 附近 4 格内的智能体（用于取用/攻击前的可达性判断）。 */
function nearAgents(run: RunState, agent: RunAgent, radius: number): RunAgent[] {
  return run.agents.filter((other) => other.id !== agent.id && distance(other.x, other.y, agent.x, agent.y) <= radius)
}

/**
 * 解析一个动作。
 *
 * 规则要点：
 *  - `wait` / `observe` 不掷骰（无失败可能且失败无代价，掷骰只是噪音）；
 *  - 移动必须掷骰（DEX）——"能不能顺利到那儿"是剧情的一部分；
 *  - `check` 是模型自己声明的尝试，按它给的属性与难度掷；
 *  - `attack` / `opposed` 走双方对抗（默认 STR / POW）；
 *  - 状态改动：agent 本人操作要求 4 格内且过一次 DEX 判定，gm 直接生效。
 */
export function resolveAction(action: AgentAction, ctx: ActionContext): ActionOutcome {
  const { sandbox, run, agent, rng, ts } = ctx
  const kind: AgentActionKind = isActionKind(action.kind) ? action.kind : 'wait'
  const events: WorldEvent[] = []
  const memory: MemoryEntry[] = []
  const rolls: RollRecord[] = []
  const mutations: ActionOutcome['mutations'] = []
  let x = agent.x
  let y = agent.y
  let empty = false

  const actionText = typeof action.text === 'string' && action.text.trim() !== '' ? action.text.trim() : ACTION_LABEL[kind]
  const thought = typeof action.thought === 'string' ? action.thought.trim() : ''
  if (thought !== '') {
    memory.push({ tick: run.tick, kind: 'thought', text: thought, ts })
  }

  // ── 状态改动先行（移动的落点不该影响"顺手把灯关上"这类动作）─────────────
  if (Array.isArray(action.mutations)) {
    for (const raw of action.mutations.slice(0, 8)) {
      if (raw === null || typeof raw !== 'object') continue
      const objectId = String((raw as { objectId?: unknown }).objectId ?? '')
      const key = String((raw as { key?: unknown }).key ?? '').trim()
      if (objectId === '' || key === '') continue
      const value = toStateValue((raw as { value?: unknown }).value)
      if (value === undefined) continue
      const target = findObject(sandbox, objectId)
      if (target === undefined) continue

      if (ctx.operator !== 'gm') {
        const dist = distance(agent.x, agent.y, target.x, target.y)
        if (dist > 4) {
          memory.push({
            tick: run.tick,
            kind: 'event',
            text: `想改动「${target.name}」却够不着（它在 ${dist} 格外，手伸不到）。`,
            ts,
          })
          continue
        }
        // 改动别人的东西是有阻力的：手不够巧就改不动（设施/载具尤其如此）。
        const attr: AttrId = 'dex'
        const roll = resolveCheck({
          roll: rng.d6(),
          attr,
          attrValue: agent.attrs[attr],
          difficulty: 9,
          mods: [{ label: '就地动手', value: 0 }],
          actorName: agent.name,
          action: `改动「${target.name}」`,
        })
        rolls.push({
          actor: agent.id,
          action: `改动「${target.name}」`,
          kind: 'check',
          roll: roll.roll,
          attr: roll.attr,
          attrValue: roll.attrValue,
          modifier: roll.modifier,
          total: roll.total,
          difficulty: roll.difficulty,
          outcome: roll.outcome,
          ok: roll.ok,
          decisive: roll.decisive,
          text: roll.text,
        })
        events.push(
          mkEvent(
            { kind: 'roll', actor: agent.id, actorName: agent.name, text: roll.text, targetId: target.id, roll: rolls[rolls.length - 1] },
            run,
            ts,
          ),
        )
        if (!roll.ok) continue
      }

      const record = applyMutation(sandbox, objectId, key, value)
      if (record === undefined) continue
      mutations.push(record)
      const text = `${agent.name}把「${target.name}」的「${key}」改为「${record.after === null ? '（清除）' : String(record.after)}」。`
      events.push(mkEvent({ kind: 'mutate', actor: agent.id, actorName: agent.name, text, targetId: objectId, mutations: [record] }, run, ts))
      memory.push({ tick: run.tick, kind: 'event', text, ts })
    }
  }

  // 动作正文的清洗规则，只写一处。
  //
  // 模型返回的 text 常常自带主语与句末标点（"沈砚伸手抵住餐桌边缘。"），
  // 而事件本身已经单独存了 actorName；再拼一次名字、再补一个句号，
  // 就会得到"沈砚沈砚伸手…。。"这种既重复又难看的正文（实测确实如此）。
  const actionTextOf = (text: string): string => {
    let out = text.trim()
    // 模型给的正文**通常不带主语**（"站在空旷处，伸手抵住餐桌边缘"），
    // 少数时候会自己带上（"沈砚伸手…"）。所以这里只负责把主语剥掉，
    // 补不补由下面句式化函数统一决定——两边都补就会得到"沈砚沈砚…"（实测踩过）。
    if (out.startsWith(agent.name)) out = out.slice(agent.name.length).replace(/^[，,、：:]+/, '').trim()
    // 去掉句末标点：正文后面统一由一个句式化函数补句号，否则会出现"…。。"
    out = out.replace(/[。．.!！?？；;，,]+$/u, '').trim()
    return out === '' ? '动了动' : out
  }

  /**
   * 句式化：**只在这里补主语与句号**。
   *
   * 事件单独存了 actorName，正文再说一遍名字是冗余的——但直接不补又会让"站在空旷处…"
   * 这类句子没有主语的落点。折中规则是：正文里已经出现名字就原样用，否则补一次。
   */
  const narrate = (text: string): string => {
    const body = actionTextOf(text)
    return body.startsWith(agent.name) ? `${body}。` : `${agent.name}${body}。`
  }

  switch (kind) {
    case 'wait': {
      events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: `${agent.name}停下来${actionText === ACTION_LABEL.wait ? '观察了一下四周' : `：${actionTextOf(actionText)}`}。` }, run, ts))
      break
    }
    case 'observe': {
      events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: narrate(actionText) }, run, ts))
      break
    }
    case 'move': {
      const targetObj = findObject(sandbox, action.objectId ?? action.placeId)
      const tx = targetObj !== undefined ? targetObj.x : Number(action.x)
      const ty = targetObj !== undefined ? targetObj.y : Number(action.y)
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) {
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: `${agent.name}想动身，却没说清要去哪儿。` }, run, ts))
        break
      }
      const dist = distance(agent.x, agent.y, tx, ty)
      /**
       * 目标在屋子里时,把落点收到最近的门口。
       *
       * 地标坐标是**建筑中心**,而中心在室内——直接走过去等于穿墙。
       * 但"我要去咖啡馆"这个意图本身是合理的,人不该因为坐标语义就被卡在门外。
       * 所以先走到门口,进门那一步由引擎在下一 tick 继续完成。
       */
      const target = nearestOpen(sandbox, Math.round(tx), Math.round(ty), 4, { cells: run.agents, except: agent.id })
      const goalX = target?.x ?? Math.round(tx)
      const goalY = target?.y ?? Math.round(ty)
      /**
       * 连目标附近都找不到能站的格子时，才算"过不去"。
       *
       * 判定**先于掷骰**：撞墙不是运气不好，是物理上过不去；反过来做（先掷
       * 成功再判墙）会出现"判定大成功却撞墙"的荒唐结果。
       * 提示改成指方向而不是指"门"——瓦片模型下门是普通一格，是否可通行由
       * 它的注释决定，没必要在这里特判"最近的门在哪"。
       */
      /**
       * 先查沿途、再查落点。只看落点的话，智能体会直接穿墙走到隔壁房间——
       * 那正是"行动与身边环境无关"的观感来源。
       */
      /**
       * 智能体彼此是不可穿透的：把在场的人（除自己）算进通行性，
       * 于是"目标格有人"和"路上有人"都会被挡住。
       */
      const occupied = { cells: run.agents, except: agent.id }
      const blockedOnTheWay = pathBlocked(sandbox, { x: agent.x, y: agent.y }, { x: goalX, y: goalY }, occupied)
      if (blockedOnTheWay !== undefined) {
        const text = `${agent.name}想往${targetObj?.name ?? `(${Math.round(tx)},${Math.round(ty)})`}去，${blockedOnTheWay}——过不去。`
        events.push(mkEvent({ kind: 'move', actor: agent.id, actorName: agent.name, text, from: { x: agent.x, y: agent.y }, to: { x: agent.x, y: agent.y } }, run, ts))
        memory.push({ tick: run.tick, kind: 'event', text, ts })
        break
      }
      if (!canEnter(sandbox, goalX, goalY, occupied).ok) {
        const text = `${agent.name}想去${targetObj?.name ?? `(${Math.round(tx)},${Math.round(ty)})`}，但那一带过不去。`
        events.push(mkEvent({ kind: 'move', actor: agent.id, actorName: agent.name, text, from: { x: agent.x, y: agent.y }, to: { x: agent.x, y: agent.y } }, run, ts))
        memory.push({ tick: run.tick, kind: 'event', text, ts })
        break
      }
      /**
       * 日常走动不掷骰：走近处是"抬脚就到"，没有失败的可能，硬掷一次
       * 只会让每次行动都变成赌博（用户明确反馈过这一点）。
       */
      if (!moveNeedsCheck(dist)) {
        x = goalX
        y = goalY
        const where = targetObj !== undefined ? targetObj.name : placeAt(sandbox, x, y)?.name ?? `(${x},${y})`
        const text = `${agent.name}走到${where}。`
        events.push(mkEvent({ kind: 'move', actor: agent.id, actorName: agent.name, text, from: { x: agent.x, y: agent.y }, to: { x, y }, targetId: targetObj?.id }, run, ts))
        memory.push({ tick: run.tick, kind: 'action', text, ts })
        break
      }
      const { step, mods } = moveDifficulty(dist)
      const roll = resolveCheck({
        roll: rng.d6(),
        attr: 'dex',
        attrValue: agent.attrs.dex,
        difficulty: step.value,
        mods,
        actorName: agent.name,
        action: targetObj !== undefined ? `前往${targetObj.name}` : '赶路',
      })
      const record: RollRecord = {
        actor: agent.id,
        action: roll.text,
        kind: 'check',
        roll: roll.roll,
        attr: roll.attr,
        attrValue: roll.attrValue,
        modifier: roll.modifier,
        total: roll.total,
        difficulty: roll.difficulty,
        outcome: roll.outcome,
        ok: roll.ok,
        decisive: roll.decisive,
        text: roll.text,
      }
      rolls.push(record)
      events.push(mkEvent({ kind: 'roll', actor: agent.id, actorName: agent.name, text: roll.text, roll: record }, run, ts))
      if (roll.ok) {
        x = goalX
        y = goalY
        const place = placeAt(sandbox, x, y)
        const where = targetObj !== undefined ? targetObj.name : place?.name ?? `(${x},${y})`
        const detail = roll.outcome === 'critical' ? `一路顺畅，还比预计早到。` : `顺利抵达。`
        const text = `${agent.name}${actionText === ACTION_LABEL.move ? `前往${where}` : actionText}，${detail}`
        events.push(mkEvent({ kind: 'move', actor: agent.id, actorName: agent.name, text, from: { x: agent.x, y: agent.y }, to: { x, y }, targetId: targetObj?.id }, run, ts))
        memory.push({ tick: run.tick, kind: 'action', text, ts })
      } else {
        // 失败不写成"什么都没发生"：给出代价（耗时/受阻）与新处境。
        const cost = roll.outcome === 'critical-failure' ? '路上出了岔子，耗掉了大半天，只能原地再想办法。' : '半路被耽搁，没能走到，天光已经暗了一分。'
        const text = `${agent.name}没能顺利前往目的地——${cost}`
        events.push(mkEvent({ kind: 'move', actor: agent.id, actorName: agent.name, text, from: { x: agent.x, y: agent.y }, to: { x: agent.x, y: agent.y }, roll: record }, run, ts))
        memory.push({ tick: run.tick, kind: 'event', text, ts })
      }
      break
    }
    case 'say': {
      const other = findAgent(run, action.targetAgentId)
      const line = typeof action.say === 'string' && action.say.trim() !== '' ? action.say.trim() : actionText
      const text = other !== undefined ? `${agent.name}对${other.name}说：「${line}」` : `${agent.name}开口：「${line}」`
      events.push(mkEvent({ kind: 'say', actor: agent.id, actorName: agent.name, text, targetAgentId: other?.id }, run, ts))
      memory.push({ tick: run.tick, kind: 'speech', text, ts })
      // 好感度：外貌与意志决定第一印象的方向（APP 高的人更容易被愿意听）。
      if (other !== undefined) {
        const delta = Math.round((agent.attrs.app - 7) / 2) + (agent.attrs.pow >= 8 ? 1 : 0)
        bumpRelation(run, agent.id, other.id, delta)
      }
      break
    }
    case 'give': {
      const other = findAgent(run, action.targetAgentId)
      const item = actionText
      if (other !== undefined) {
        const text = `${agent.name}把${item}交给${other.name}。`
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text, targetAgentId: other.id }, run, ts))
        bumpRelation(run, agent.id, other.id, 3)
      } else {
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: narrate(actionText) }, run, ts))
      }
      break
    }
    case 'take': {
      const target = findObject(sandbox, action.objectId)
      const label = target !== undefined ? target.name : actionText
      if (target !== undefined && distance(agent.x, agent.y, target.x, target.y) > 4) {
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: `${agent.name}伸手去拿${label}，却隔着太远。` }, run, ts))
        break
      }
      const roll = resolveCheck({
        roll: rng.d6(),
        attr: 'dex',
        attrValue: agent.attrs.dex,
        difficulty: 9,
        actorName: agent.name,
        action: `取用${label}`,
      })
      const record = toRollRecord(agent.id, roll.text, roll)
      rolls.push(record)
      if (roll.ok) {
        agent.inventory = [...agent.inventory, label].slice(0, 24)
        const text = `${agent.name}收起了${label}。`
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text, targetId: target?.id, roll: record }, run, ts))
        memory.push({ tick: run.tick, kind: 'action', text, ts })
      } else {
        const text = `${agent.name}手一滑，${label}没拿到。`
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text, targetId: target?.id, roll: record }, run, ts))
      }
      break
    }
    case 'check': {
      const attr: AttrId = isAttrId(action.attr) ? action.attr : 'int'
      const roll = resolveCheck({
        roll: rng.d6(),
        attr,
        attrValue: agent.attrs[attr],
        difficulty: difficultyFromAction(action),
        actorName: agent.name,
        action: actionText,
      })
      const record = toRollRecord(agent.id, actionText, roll)
      rolls.push(record)
      events.push(mkEvent({ kind: 'roll', actor: agent.id, actorName: agent.name, text: roll.text, roll: record }, run, ts))
      const detail = roll.ok
        ? roll.outcome === 'critical'
          ? `${agent.name}${actionText}，而且做得比预想更好。`
          : `${agent.name}${actionText}，成了。`
        : roll.outcome === 'critical-failure'
          ? `${agent.name}${actionText}，砸了锅，还惹出新的麻烦。`
          : `${agent.name}${actionText}，没成，只留下一点难堪。`
      events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: detail, roll: record }, run, ts))
      memory.push({ tick: run.tick, kind: 'action', text: detail, ts })
      break
    }
    case 'attack':
    case 'opposed': {
      const other = findAgent(run, action.targetAgentId)
      if (other === undefined) {
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: `${narrate(actionText).replace(/。$/, '')}，却找不到对手。` }, run, ts))
        break
      }
      const attr: AttrId = isAttrId(action.attr) ? action.attr : kind === 'attack' ? 'str' : 'pow'
      const result = adjudicate(
        { name: agent.name, attr, attrValue: agent.attrs[attr], roll: rng.d6(), mods: kind === 'attack' ? [{ label: '主动出击', value: 0 }] : [] },
        { name: other.name, attr, attrValue: other.attrs[attr], roll: rng.d6() },
      )
      const record: RollRecord = {
        actor: agent.id,
        action: kind === 'attack' ? '攻击' : '对抗',
        kind: 'opposed',
        roll: result.attacker.roll,
        attr,
        attrValue: result.attacker.attrValue,
        total: result.attackerTotal,
        opponent: other.id,
        opponentRoll: result.defender.roll,
        opponentTotal: result.defenderTotal,
        ok: result.attackerWins,
        text: result.text,
      }
      rolls.push(record)
      events.push(mkEvent({ kind: 'roll', actor: agent.id, actorName: agent.name, text: result.text, targetAgentId: other.id, roll: record }, run, ts))
      if (result.attackerWins) {
        const text = kind === 'attack' ? `${agent.name}在${ATTR_EN[attr]}上压过${other.name}，占了上风。` : `${agent.name}在${ATTR_EN[attr]}的较量中压过${other.name}。`
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text, targetAgentId: other.id, roll: record }, run, ts))
        memory.push({ tick: run.tick, kind: 'event', text, ts })
        bumpRelation(run, agent.id, other.id, kind === 'attack' ? -8 : -2)
      } else {
        const text = result.outcome === 'tie' ? `${agent.name}与${other.name}僵持不下。` : `${agent.name}在${ATTR_EN[attr]}上没能压过${other.name}。`
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text, targetAgentId: other.id, roll: record }, run, ts))
        memory.push({ tick: run.tick, kind: 'event', text, ts })
      }
      break
    }
    case 'flee': {
      const roll = resolveCheck({
        roll: rng.d6(),
        attr: 'dex',
        attrValue: agent.attrs.dex,
        difficulty: 11,
        actorName: agent.name,
        action: '脱身',
      })
      const record = toRollRecord(agent.id, '脱身', roll)
      rolls.push(record)
      if (roll.ok) {
        // 逃向最近的地标（有明确去处才不用事后编坐标）。
        const nearest = sandbox.places
          .map((p) => ({ p, d: distance(agent.x, agent.y, p.x, p.y) }))
          .sort((l, r) => l.d - r.d)[1]
        if (nearest !== undefined) {
          x = nearest.p.x
          y = nearest.p.y
        }
        const text = `${agent.name}摆脱了纠缠，退向${nearest?.p.name ?? '别处'}。`
        events.push(mkEvent({ kind: 'move', actor: agent.id, actorName: agent.name, text, from: { x: agent.x, y: agent.y }, to: { x, y }, roll: record }, run, ts))
      } else {
        const text = `${agent.name}想脱身却没走成。`
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text, roll: record }, run, ts))
      }
      break
    }
    default: {
      events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: narrate(actionText) }, run, ts))
      break
    }
  }

  // 空步判定：只有移动失败且没有任何事件/改动时才算（此时需要一次兜底叙事）。
  if (events.length === 0) empty = true

  return { events, memory, rolls, x, y, mutations, empty }
}

/** 把一次单人判定收成复盘用的记录。 */
function toRollRecord(actor: string, action: string, roll: ReturnType<typeof resolveCheck>): RollRecord {
  return {
    actor,
    action,
    kind: 'check',
    roll: roll.roll,
    attr: roll.attr,
    attrValue: roll.attrValue,
    modifier: roll.modifier,
    total: roll.total,
    difficulty: roll.difficulty,
    outcome: roll.outcome,
    ok: roll.ok,
    decisive: roll.decisive,
    text: roll.text,
  }
}

/** 关系值插值（找不到就按双方 id 建一条）。 */
export function bumpRelation(run: RunState, a: string, b: string, delta: number): void {
  const found = run.relations.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a))
  if (found !== undefined) {
    found.affinity = Math.max(-100, Math.min(100, found.affinity + delta))
    return
  }
  run.relations.push({ a, b, label: '初识', affinity: Math.max(-100, Math.min(100, delta)) })
}

export function relationBetween(run: RunState, a: string, b: string): number {
  const found = run.relations.find((r) => (r.a === a && r.b === b) || (r.a === b && r.b === a))
  return found?.affinity ?? 0
}

// ── 动作的清洗与兜底 ─────────────────────────────────────────────────────
//
// 模型返回的 JSON 不可全信：字段可能缺失、类型可能不对、可能整段不是 JSON。
// `coerceAction` 负责把它收成一个**永远可执行**的动作，兜底是 `wait`+观察，
// 而不是抛错中断整个世界——一个智能体说胡话不该让整步失败。

const KIND_ALIASES: Record<string, string> = {
  go: 'move',
  walk: 'move',
  travel: 'move',
  approach: 'move',
  talk: 'say',
  speak: 'say',
  chat: 'say',
  look: 'observe',
  investigate: 'observe',
  inspect: 'observe',
  use: 'act',
  interact: 'act',
  do: 'act',
  pickup: 'take',
  pick: 'take',
  grab: 'take',
  hand: 'give',
  try: 'check',
  attempt: 'check',
  contest: 'opposed',
  resist: 'opposed',
  fight: 'attack',
  hit: 'attack',
  run: 'flee',
  escape: 'flee',
  idle: 'wait',
  rest: 'wait',
}

export function coerceAction(raw: unknown): AgentAction {
  if (raw === null || typeof raw !== 'object') {
    return { thought: '（没能想清楚要做什么）', kind: 'wait', text: '停在原地，理了理思绪' }
  }
  const obj = raw as Record<string, unknown>
  const rawKind = typeof obj.kind === 'string' ? obj.kind.trim().toLowerCase() : ''
  let kind: AgentActionKind
  if (isActionKind(rawKind)) kind = rawKind
  else if (KIND_ALIASES[rawKind] !== undefined && isActionKind(KIND_ALIASES[rawKind])) kind = KIND_ALIASES[rawKind] as AgentActionKind
  else {
    // 模型只给了自然语言时，按动词线索猜一个（猜不到就当 wait）。
    const text = typeof obj.text === 'string' ? obj.text : ''
    if (/走|前往|去|来到|赶|走进/.test(text)) kind = 'move'
    else if (/说|问|喊|回答|告诉|聊/.test(text)) kind = 'say'
    else if (/看|观察|打量|查|搜/.test(text)) kind = 'observe'
    else if (/打|攻击|揍|推|抢/.test(text)) kind = 'attack'
    else if (/逃|跑|撤/.test(text)) kind = 'flee'
    else kind = 'wait'
  }
  const mutations: AgentAction['mutations'] = []
  if (Array.isArray(obj.mutations)) {
    for (const entry of obj.mutations.slice(0, 8)) {
      if (entry === null || typeof entry !== 'object') continue
      const e = entry as Record<string, unknown>
      const objectId = typeof e.objectId === 'string' ? e.objectId : typeof e.id === 'string' ? e.id : ''
      const key = typeof e.key === 'string' ? e.key : typeof e.state === 'string' ? e.state : ''
      const value = toStateValue(e.value ?? e.to)
      if (objectId === '' || key === '' || value === undefined) continue
      mutations.push({ objectId, key, value })
    }
  }
  const num = (v: unknown): number | undefined => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.round(n) : undefined
  }
  return {
    thought: typeof obj.thought === 'string' ? obj.thought : '',
    kind,
    text: typeof obj.text === 'string' && obj.text.trim() !== '' ? obj.text : ACTION_LABEL[kind],
    say: typeof obj.say === 'string' ? obj.say : undefined,
    objectId: typeof obj.objectId === 'string' ? obj.objectId : undefined,
    placeId: typeof obj.placeId === 'string' ? obj.placeId : undefined,
    x: num(obj.x),
    y: num(obj.y),
    targetAgentId: typeof obj.targetAgentId === 'string' ? obj.targetAgentId : typeof obj.target === 'string' ? obj.target : undefined,
    attr: isAttrId(obj.attr) ? obj.attr : undefined,
    difficultyId: typeof obj.difficultyId === 'string' ? obj.difficultyId : typeof obj.difficulty === 'string' ? obj.difficulty : undefined,
    mutations: mutations.length === 0 ? undefined : mutations,
    note: typeof obj.note === 'string' ? obj.note : undefined,
    // 心情增量只收 -2..+2：模型给的越界值夹紧而不是丢弃（丢一步的心情变化
    // 会让状态看起来"卡住"，夹紧至少符合它的意图方向）。
    moodDelta: (() => {
      const n = Number(obj.moodDelta ?? obj.mood ?? NaN)
      if (!Number.isFinite(n)) return undefined
      return Math.max(-2, Math.min(2, Math.round(n)))
    })(),
    moodLabel: typeof obj.moodLabel === 'string' && obj.moodLabel.trim() !== '' ? obj.moodLabel.trim().slice(0, 8) : undefined,
  }
}

/**
 * 从模型的自由文本里抠出 JSON。
 * 常见包装：```json 代码块、前置解释、后置补充。逐个剥离，全失败返回 null
 * —— 由调用方决定降级为兜底动作，而不是在这里静默编一个动作。
 */
export function extractJson(text: string): unknown {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return null
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidates: string[] = []
  if (fenced !== null && fenced[1] !== undefined) candidates.push(fenced[1].trim())
  candidates.push(trimmed)
  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) candidates.push(trimmed.slice(first, last + 1))
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      /* try the next candidate */
    }
  }
  return null
}
