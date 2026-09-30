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

export function findObject(sandbox: Sandbox, id: string | undefined): WorldObject | undefined {
  if (id === undefined || id === '') return undefined
  return sandbox.places.find((p) => p.id === id) ?? sandbox.objects.find((o) => o.id === id)
}

export function findAgent(run: RunState, id: string | undefined): RunAgent | undefined {
  if (id === undefined || id === '') return undefined
  return run.agents.find((a) => a.id === id)
}

type SizeAware = { w?: number; h?: number }

/**
 * 移动难度：距离越远越难，目标地标拥挤或要穿过整张图时更难。
 * 十几格的短途是「容易」，跨镇是「艰难」，这给"去哪儿"这件事本身制造张力。
 */
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
export function difficultyFromAction(action: AgentAction): number {
  if (action.difficultyId === undefined || action.difficultyId === '') return DEFAULT_DIFFICULTY
  return difficultyOf(action.difficultyId).value
}

export interface ActionContext {
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

export interface ActionOutcome {
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

function applyMutation(
  sandbox: Sandbox,
  objectId: string,
  key: string,
  value: StateValue,
): { objectId: string; key: string; before: StateValue; after: StateValue } | undefined {
  const target = findObject(sandbox, objectId)
  if (target === undefined) return undefined
  const before = target.state[key] ?? null
  const after = value
  // `null` 表示删除该键——「把故障标记清掉」需要一个出口，否则只能写成
  // 空字符串，状态槽里会攒下一堆语义不明的占位值。
  if (after === null) delete target.state[key]
  else target.state[key] = after
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
      target.lastEditedBy = agent.name
      target.lastEditedAt = ts
      const text = `${agent.name}把「${target.name}」的「${key}」改为「${record.after === null ? '（清除）' : String(record.after)}」。`
      events.push(mkEvent({ kind: 'mutate', actor: agent.id, actorName: agent.name, text, targetId: objectId, mutations: [record] }, run, ts))
      memory.push({ tick: run.tick, kind: 'event', text, ts })
    }
  }

  switch (kind) {
    case 'wait': {
      events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: `${agent.name}停下来${actionText === ACTION_LABEL.wait ? '观察了一下四周' : `：${actionText}`}。` }, run, ts))
      break
    }
    case 'observe': {
      events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: `${agent.name}${actionText}。` }, run, ts))
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
        x = Math.round(tx)
        y = Math.round(ty)
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
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: `${agent.name}${actionText}。` }, run, ts))
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
        events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: `${agent.name}${actionText}，却找不到对手。` }, run, ts))
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
      events.push(mkEvent({ kind: 'act', actor: agent.id, actorName: agent.name, text: `${agent.name}${actionText}。` }, run, ts))
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
