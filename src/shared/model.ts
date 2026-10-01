/**
 * dsh-paranim — 公用契约（host 与 client 共享）。
 *
 * 这里定义三样东西，两端都只能通过它说话：
 *  1. 六维属性与 D6 判定引擎（`resolveCheck` / `adjudicate`）
 *  2. 世界沙盒的持久化 schema（`Sandbox` / `Agent` / `WorldObject` / `RunState`）
 *  3. `/paranim/*` 路由的请求与响应形状
 *
 * 判定引擎是纯函数：同样的输入永远得到同样的输出，因此可以脱离运行时单测。
 */

// ── 六维属性（需求 4）──────────────────────────────────────────────────────
//
// 正常人 4-10 的整数，越高越强。低于 4 是残障、高于 10 是超常，两端都允许但
// 由使用者明示（schema 只给出 HUMAN_MIN/HUMAN_MAX 供 UI 标出常规区间）。

export interface Attrs {
  /** 力量 STR */
  str: number
  /** 体质 CON */
  con: number
  /** 敏捷 DEX */
  dex: number
  /** 外貌 APP */
  app: number
  /** 智力 INT */
  int: number
  /** 意志 POW */
  pow: number
}

export type AttrId = keyof Attrs

/** 展示顺序固定：力量 / 体质 / 敏捷 / 外貌 / 智力 / 意志。 */
export const ATTR_IDS: readonly AttrId[] = ['str', 'con', 'dex', 'app', 'int', 'pow']

export const ATTR_LABEL: Record<AttrId, string> = {
  str: '力量',
  con: '体质',
  dex: '敏捷',
  app: '外貌',
  int: '智力',
  pow: '意志',
}

export const ATTR_EN: Record<AttrId, string> = {
  str: 'STR',
  con: 'CON',
  dex: 'DEX',
  app: 'APP',
  int: 'INT',
  pow: 'POW',
}

/** 正常人属性区间（含端点）。 */
export const HUMAN_MIN = 4
export const HUMAN_MAX = 10

/** 属性绝对值下限/上限（越界值在写入时被夹紧到这一档）。 */
const ATTR_MIN = 1
const ATTR_MAX = 20

export function isAttrId(value: unknown): value is AttrId {
  return typeof value === 'string' && (ATTR_IDS as readonly string[]).includes(value)
}

/** 属性中位数：建卡与随机生成时用作基准。 */
export const HUMAN_MID = 7

// ── 判定（需求 4）─────────────────────────────────────────────────────────
//
// 规则一句话：掷 1 枚 D6，骰值 + 对应属性 ≥ 难度 → 成功。
// 1 恒失败、6 恒成功（对抗同样吃这两条）。对抗时两边各掷一次，比较
// 「骰值 + 属性」的有效值，平手判防守方胜（守方收益，攻方需真正压过）。

/** 难度阶梯：越难数值越高（rollUnder 的「修正值」是它的语义反面）。 */
export interface DifficultyStep {
  /** 阶梯档位标识。 */
  id: string
  /** 展示名。 */
  label: string
  /** 需要够到的目标数（骰值 + 属性 ≥ 此值即成功）。 */
  value: number
  /** 一句话说明这一档适合什么情形。 */
  desc: string
}

export const DIFFICULTY_LADDER: readonly DifficultyStep[] = [
  { id: 'trivial', label: '随手', value: 6, desc: '几乎不会失败的日常动作（系鞋带、推门）' },
  { id: 'easy', label: '容易', value: 9, desc: '有把握但仍有失手可能（搬一把椅子、认路）' },
  { id: 'normal', label: '常规', value: 11, desc: '标准难度，属性中位的人约一成多失手（翻墙、套话）' },
  { id: 'hard', label: '棘手', value: 13, desc: '需要本事或运气（徒手爬三楼、说服固执的店主）' },
  { id: 'very-hard', label: '艰难', value: 15, desc: '专家尚且会失手（在众目下偷东西、徒手压制壮汉）' },
  { id: 'brutal', label: '严峻', value: 17, desc: '接近能力的上限（暴雨里追踪、一句话扭转敌意）' },
  { id: 'nearly-impossible', label: '近乎不可能', value: 19, desc: '只有 6 或满骰加上极高属性才可能' },
]

export const DEFAULT_DIFFICULTY = 11

export function difficultyOf(id: string): DifficultyStep {
  return DIFFICULTY_LADDER.find((step) => step.id === id) ?? DIFFICULTY_LADDER[2]
}

export type CheckOutcome = 'critical' | 'success' | 'failure' | 'critical-failure'

export interface CheckResult {
  /** 骰面（1..6）。 */
  roll: number
  /** 参与判定的属性名。 */
  attr: AttrId
  /** 属性值。 */
  attrValue: number
  /** 其他修正之和（来源见 `mods`）。 */
  modifier: number
  /** 骰值 + 属性 + 修正。 */
  total: number
  /** 本次判定需要够到的目标数。 */
  difficulty: number
  /** 结果的文字形态。 */
  outcome: CheckOutcome
  ok: boolean
  /** 是否走了 1 必败 / 6 必胜的规则（此时 total 不参与判定）。 */
  decisive: boolean
  /** 修正明细，用于向玩家交代「为什么是 +2」。 */
  mods: CheckMod[]
  /** 一句话中文结论。 */
  text: string
}

export interface CheckMod {
  label: string
  value: number
}

export interface CheckInput {
  /** 骰面 1..6。 */
  roll: number
  /** 参与判定的属性。 */
  attr: AttrId
  /** 该属性的值。 */
  attrValue: number
  /** 目标数（通常取自 DIFFICULTY_LADDER）。 */
  difficulty: number
  /** 逐项修正（可为空）。 */
  mods?: CheckMod[]
  /** 判定对象的展示名，用于生成结论文本。 */
  actorName?: string
  /** 行动描述，用于生成结论文本。 */
  action?: string
}

/** 判定骰面是否合法（1..6 整数）。 */
function isValidRoll(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 6
}

function sumMods(mods: readonly CheckMod[] | undefined): number {
  if (mods === undefined) return 0
  let total = 0
  for (const mod of mods) total += mod.value
  return total
}

/**
 * 单人判定。
 *
 * D6 只有 6 个面，`骰值 + 属性` 的可达区间极窄，所以 1（骰值 1）与 6 被独立出来
 * 作为必败/必胜：没有这条，一个 STR 10 的人对「严峻 17」永远只能靠 6 —— 那样
 * 骰子不再是运气，而是唯一的通道；有了这条，6 仍然是通道，但 1 让强者也会失手，
 * 剧情才有代价可言。
 */
export function resolveCheck(input: CheckInput): CheckResult {
  const roll = Math.trunc(input.roll)
  if (!isValidRoll(roll)) throw new Error(`骰面必须是 1..6 的整数，收到 ${String(input.roll)}`)
  const modifier = sumMods(input.mods)
  const total = roll + input.attrValue + modifier
  const difficulty = input.difficulty

  let outcome: CheckOutcome
  let decisive = false
  if (roll === 6) {
    outcome = 'critical'
    decisive = true
  } else if (roll === 1) {
    outcome = 'critical-failure'
    decisive = true
  } else if (total >= difficulty) {
    outcome = 'success'
  } else {
    outcome = 'failure'
  }

  const who = input.actorName === undefined || input.actorName === '' ? '这次行动' : `${input.actorName}的这次行动`
  const what = input.action === undefined || input.action === '' ? '' : `（${input.action}）`
  const attrText = `${ATTR_EN[input.attr]} ${input.attrValue}`
  const modText = modifier === 0 ? '' : ` ${modifier > 0 ? '+' : ''}${modifier}`

  let text: string
  switch (outcome) {
    case 'critical':
      text = `D6=6 → 必成功：${who}${what}不仅做到了，还做得漂亮（${attrText}${modText}，目标 ${difficulty}）。`
      break
    case 'critical-failure':
      text = `D6=1 → 必失败：${who}${what}出了岔子，还要付出额外代价（${attrText}${modText}，目标 ${difficulty}）。`
      break
    case 'success':
      text = `D6=${roll}${modText} + ${attrText} = ${total} ≥ ${difficulty} → 成功：${who}${what}达成。`
      break
    default:
      text = `D6=${roll}${modText} + ${attrText} = ${total} < ${difficulty} → 失败：${who}${what}没有达成。`
      break
  }

  return {
    roll,
    attr: input.attr,
    attrValue: input.attrValue,
    modifier,
    total,
    difficulty,
    outcome,
    ok: outcome === 'critical' || outcome === 'success',
    decisive,
    mods: input.mods === undefined ? [] : [...input.mods],
    text,
  }
}

export type OpposedOutcome = 'attacker' | 'defender' | 'tie'

export interface OpposedSide {
  name: string
  attr: AttrId
  attrValue: number
  roll: number
  mods?: CheckMod[]
}

export interface OpposedResult {
  attacker: CheckResult
  defender: CheckResult
  /** 攻防双方的有效值（骰值 + 属性 + 修正）。 */
  attackerTotal: number
  defenderTotal: number
  outcome: OpposedOutcome
  /** 胜者是进攻方吗（tie 时为 false）。 */
  attackerWins: boolean
  text: string
}

/**
 * 对抗判定：双方各掷一次，比较有效值。
 *
 * 与单人判定刻意不同——对抗里 1/6 不是必败/必胜，而是照常计入有效值：
 * `1 + 属性` 对强者仍是压迫，`6 + 属性` 对弱者仍可能翻盘。对抗的胜负本来就
 * 该由双方的实力差说话，让 1/6 一票否决会把"力气大的人更容易赢"抹掉。
 */
export function adjudicate(attacker: OpposedSide, defender: OpposedSide): OpposedResult {
  const atk = resolveCheck({
    roll: attacker.roll,
    attr: attacker.attr,
    attrValue: attacker.attrValue,
    difficulty: 0,
    mods: attacker.mods,
    actorName: attacker.name,
  })
  const def = resolveCheck({
    roll: defender.roll,
    attr: defender.attr,
    attrValue: defender.attrValue,
    difficulty: 0,
    mods: defender.mods,
    actorName: defender.name,
  })
  const attackerTotal = atk.total
  const defenderTotal = def.total
  const outcome: OpposedOutcome =
    attackerTotal > defenderTotal ? 'attacker' : attackerTotal < defenderTotal ? 'defender' : 'tie'
  const text =
    outcome === 'tie'
      ? `对抗（${ATTR_EN[attacker.attr]}）：${attacker.name} ${attackerTotal} 对 ${defender.name} ${defenderTotal} → 平手，维持现状（防守方收益）。`
      : `对抗（${ATTR_EN[attacker.attr]}）：${attacker.name} ${attackerTotal} 对 ${defender.name} ${defenderTotal} → ${outcome === 'attacker' ? attacker.name : defender.name} 压过对方。`
  return {
    attacker: atk,
    defender: def,
    attackerTotal,
    defenderTotal,
    outcome,
    attackerWins: outcome === 'attacker',
    text,
  }
}

/** 校验并夹紧一个属性值。 */
export function clampAttr(value: unknown, fallback = HUMAN_MID): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(ATTR_MAX, Math.max(ATTR_MIN, Math.round(n)))
}

/** 补齐缺失属性，保证六项齐全（导入外部素材时的收口点）。 */
export function normalizeAttrs(input: Partial<Attrs> | undefined | null): Attrs {
  const src = input ?? {}
  return {
    str: clampAttr(src.str),
    con: clampAttr(src.con),
    dex: clampAttr(src.dex),
    app: clampAttr(src.app),
    int: clampAttr(src.int),
    pow: clampAttr(src.pow),
  }
}

// ── 沙盒 schema（需求 2）─────────────────────────────────────────────────

export type ObjectKind = 'place' | 'prop' | 'fixture' | 'vehicle' | 'plant' | 'sign' | 'other'

export const OBJECT_KIND_LABEL: Record<ObjectKind, string> = {
  place: '地标',
  prop: '物件',
  fixture: '设施',
  vehicle: '载具',
  plant: '草木',
  sign: '标识',
  other: '其他',
}

/** 任意可读写的状态槽：值必须是 JSON 可序列化标量或短数组。 */
export type StateValue = string | number | boolean | null | string[] | number[]

/** 沙盒里的一个对象（地标/物件/设施）。 */
export interface WorldObject {
  id: string
  name: string
  kind: ObjectKind
  x: number
  y: number
  /** 占地尺寸（地标用；物件通常省略，按 1 格画）。 */
  w?: number
  h?: number
  /** 覆盖地图底色（可选）。 */
  color?: string
  desc?: string
  tags?: string[]
  /** 玩家可改的状态槽；右键菜单直接编辑这里。 */
  state: Record<string, StateValue>
  /** 是否可交互（决定右键菜单显示「修改状态」还是「仅查看」）。 */
  interactive: boolean
  /** 交互动词提示，如 ['修理','破坏','点灯']。 */
  affordances?: string[]
  /**
   * 屋顶配色族（对应 mapStyle.BUILDING 的 roof* 槽位）。
   * 地标可显式指定；不给则由渲染层按 tags 推导。Smallville 镜像按原版建筑族写好了每处地点，
   * 这样同一类建筑在地图上是同一个色系——这正是原版地图"一眼能分出住宅区与商业区"的原因。
   */
  roofSlot?: string
  /**
   * 物件用哪张贴图（对应 mapStyle.PROPS 的槽位名，见 OBJECT_LIBRARY）。
   * 显式字段优先于按名字推断：玩家在「物件资源池」里挑了哪张，就该用哪张。
   */
  sprite?: string
  /** 修改者与时间，用于复盘「谁在什么时候动了这盏灯」。 */
  lastEditedBy?: string
  lastEditedAt?: number
}

/**
 * 心情：**一个词 + 一个 0–10 的指数**，显示成「生气 4/10」。
 *
 * 两者各司其职：指数给高低（能排序、能做阈值判断），词给色彩（读起来
 * 像人话）。缺词时按指数自动取一个（见 moodLabel），所以不会出现"只有
 * 数字没有说法"的情况。
 */

const MOOD_MIN = 0
export const MOOD_MAX = 10
/** 新角色的默认心情：不上不下，留给第一步去改变。 */
export const MOOD_DEFAULT: Mood = { value: 6, label: '平静' }

/** 心情：指数 + 一个词。 */
export interface Mood {
  /** 0–10。 */
  value: number
  /** 一个词，例如「生气」「开心」「烦躁」。 */
  label: string
}

/** 夹紧到 0–10 的整数。 */
export function clampMood(value: unknown, fallback = MOOD_DEFAULT.value): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(MOOD_MAX, Math.max(MOOD_MIN, Math.round(n)))
}

/**
 * 归一一条心情。
 *
 * 接受两种形状：`{ value, label }`（正常）与裸数字（简写，词按指数自动取）。
 * 词为空时也自动取——"只有数字没有说法"在这里就被补上了。
 */
export function normalizeMood(input: unknown): Mood {
  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const raw = input as { value?: unknown; label?: unknown }
    const value = clampMood(raw.value)
    const label = typeof raw.label === 'string' && raw.label.trim() !== '' ? raw.label.trim().slice(0, 8) : moodLabel(value)
    return { value, label }
  }
  const value = clampMood(input)
  return { value, label: moodLabel(value) }
}

/** 指数 → 默认词（模型没给词时用它）。 */
export function moodLabel(value: number): string {
  if (value >= 9) return '兴奋'
  if (value >= 7) return '开心'
  if (value >= 5) return '平静'
  if (value >= 3) return '烦躁'
  if (value >= 1) return '生气'
  return '崩溃'
}


export interface AgentModelRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 智能体记忆的一条（需求 3 的「引导」也落在这里作为 whispered）。 */
export interface MemoryEntry {
  /** 发生时的世界步。 */
  tick: number
  kind: 'thought' | 'observation' | 'speech' | 'action' | 'event' | 'whisper' | 'summary'
  text: string
  ts: number
}

export interface SandboxAgent {
  id: string
  name: string
  /** 概念/职业/身份。 */
  concept: string
  /** 外貌（需求 3 可自定义）。 */
  appearance: string
  /** 性格与说话方式（需求 3 可自定义）。 */
  persona: string
  backstory: string
  /**
   * 心情：0–10 的指数 + 一个词。**由模型在动作里顺带给出**（见 AgentAction.moodDelta），
   * 不是引擎从属性推导的——心情是对"刚才那件事"的反应，只有当事者知道该是什么。
   */
  /** 心情：词 + 0–10 指数。缺省用 MOOD_DEFAULT。 */
  mood?: Mood
  /**
   * 自定义外观：一个瓦片引用（"图集:列,行"）。
   *
   * 给了就用它画，没给就用内置角色表（那 6 帧朝下/侧/上）。用户可以上传
   * 一张图（自动登记成单格图集）或从已有图集里挑一格——满足"每个角色长得
   * 不一样"这件事，而不用改代码。
   */
  sprite?: string
  x: number
  y: number
  /** 六维属性（需求 4）。 */
  attrs: Attrs
  /** 驱动模型；缺省 = 跟随宿主默认模型（需求 3 的"从 dsh 可用模型中选择"）。 */
  model?: AgentModelRoute | null
  /** 今日计划，逐条消耗。 */
  plan: string[]
  /** 随身物品。 */
  inventory: string[]
  /** 外观色（地图上的点）。 */
  color: string
  /** 头像 emoji。 */
  portrait: string
}

/** 一次判定落进事件流后的记录（复盘与叙事都要用到）。 */
export interface RollRecord {
  actor: string
  action: string
  kind: 'check' | 'opposed'
  roll?: number
  attr?: AttrId
  attrValue?: number
  modifier?: number
  total?: number
  difficulty?: number
  outcome?: CheckOutcome
  ok?: boolean
  decisive?: boolean
  text: string
  opponent?: string
  opponentRoll?: number
  opponentTotal?: number
}

/** 世界步里发生的一件事。 */
export interface WorldEvent {
  id: string
  tick: number
  ts: number
  kind: 'move' | 'say' | 'act' | 'mutate' | 'spawn' | 'despawn' | 'directive' | 'roll' | 'system'
  /** 参与者的 agentId（玩家指令为 'gm'）。 */
  actor: string
  actorName: string
  text: string
  /** 目标对象/地标 id（移动、改状态时给出）。 */
  targetId?: string
  /** 目标 agentId（对话、对抗时给出）。 */
  targetAgentId?: string
  /** 坐标变化。 */
  from?: { x: number; y: number }
  to?: { x: number; y: number }
  /** 该事件引发的状态改动，便于精确复盘。 */
  mutations?: Array<{ objectId: string; key: string; before: StateValue; after: StateValue }>
  roll?: RollRecord
}

/** 用户对某个智能体的指令（需求 3 的「通过指令引导它在世界中行动」）。 */
export interface Directive {
  id: string
  agentId: string
  text: string
  /** 尚未被消费的指令会注入该智能体的下一次观察。 */
  consumed: boolean
  createdAt: number
  consumedAtTick?: number
}

export interface SandboxRelation {
  a: string
  b: string
  label: string
  /** -100..100，负值为敌意。 */
  affinity: number
}

/** 地面材质：background layer 里每一格的取值。 */
export type GroundKind = 'grass' | 'dirt' | 'stone' | 'concrete' | 'sand' | 'water' | 'field' | 'wood'

/**
 * 一格瓦片的注释——**由人在图集编辑器里标**，不是代码猜的。
 *
 * 为什么必须人标：早先用"按平均色反查格子"来选贴图，那对纯色地面有效
 * （草地、石板整格同色），对**有形状的东西**完全无效——一棵树和一片灌木的
 * 平均色可以一模一样。于是出现"把路面当树画出来"这类错误，而且不报错。
 * 现在改成：图集切片后逐格标注，代码只读标注结果。
 */
export interface TileNote {
  /** 显示名，如"草地"、"木门"。 */
  name?: string
  /**
   * 通行性。移动规则只认这一个字段：
   *  · walk  可走
   *  · block 挡路（墙、栅栏——栅栏要攀爬检定）
   *  · water 水域（不可走，除非有船）
   *  · lava  岩浆（可走但受伤）
   * 缺省视为 walk。
   */
  pass?: 'walk' | 'block' | 'water' | 'lava'
  /** 互动方式：门/窗这类可以开关的东西。 */
  use?: 'door' | 'window' | 'switch'
  /** 备注：给玩家看的说明，不参与判定。 */
  desc?: string
  /**
   * 这个瓦片能够处于哪些状态（物件用），例如 ['正常','故障','维修中']。
   *
   * 右键菜单与智能体动作都从这里取值——与其让模型自由编一个状态字符串、
   * 事后谁也看不懂，不如先声明"这个东西能有哪些状态"。
   */
  states?: string[]
}

/** 一张可切片的素材图。切片参数与逐格注释都在这里。 */
export interface Tileset {
  id: string
  name: string
  /**
   * 图片。内置图集留空串——它们的像素已在客户端包内（sheetData.ts），
   * 内嵌一份会让每个沙盒都重复几百 KB。用户载入的图集存 data URI。
   */
  image: string
  /** 图片像素尺寸，用来算能切出多少行列。 */
  imageW: number
  imageH: number
  tileW: number
  tileH: number
  /** 图边距（素材图四周留白）。 */
  margin: number
  /** 格与格之间的间隙。Kenney 的图集带 1px，切的时候不扣掉会串格。 */
  spacing: number
  /** 逐格注释，键是 "col,row"。没标的格子就是"还没定义"。 */
  notes: Record<string, TileNote>
}

/**
 * 一层瓦片图。
 *
 * `cells` 行优先，长度 = width × height，每格存 `"tilesetId:col,row"` 或 null。
 * **一格只能有一个瓦片**——这是 tilemap 的基本约定：压着放多张会让"这一格
 * 到底是什么"失去答案，而通行性判定必须能给出唯一答案。
 */
export interface TileLayer {
  cells: Array<string | null>
  /**
   * 逐格状态（object 层用），键是格索引 `y * width + x`。
   *
   * 物件不是独立的一串对象，而是"某一格上的那个东西"，状态就挂在这一格。
   * 这样"把桌子搬走"就是清空那格，不需要同步两份数据。
   */
  states?: Record<string, Record<string, StateValue>>
}

/** 三个图层：下→上依次是背景地面、建筑结构、可互动物件。 */
export interface MapLayers {
  /** 地面。水面/岩浆这类地形会影响移动。 */
  background: TileLayer
  /** 墙体与障碍。墙不可穿越，栅栏需攀爬检定。 */
  structure: TileLayer
  /** 门窗、汽车、路灯等可互动的东西。 */
  object: TileLayer
}

export interface SandboxMap {
  width: number
  height: number
  /** 该沙盒用到的图集。内置图集只存 id（像素在客户端包内），用户载入的存 data URI。 */
  tilesets: Tileset[]
  layers: MapLayers
}

/** 一个可编辑、可保存、可载入的世界沙盒（需求 2）。 */
export interface Sandbox {
  /** 格式版本，便于将来迁移。 */
  v: number
  id: string
  name: string
  desc: string
  /** 素材来源声明（复刻镜像必须写清出处与许可）。 */
  attribution?: string
  license?: string
  /** 是否随插件发货的只读镜像（允许另存为副本后编辑）。 */
  builtin?: boolean
  /** 发货镜像的版本号：升级时据此判断要不要更新玩家目录里那份未改动的副本。 */
  mirrorVersion?: string
  createdAt: number
  updatedAt: number
  map: SandboxMap
  /**
   * 命名地标：智能体的目的地、事件里"在哪儿"的说法。
   *
   * 这**不是**地图上的东西——地图由三个瓦片图层表达，包括建筑。地标是逻辑上的
   * 一块有名字的区域（"咖啡馆""公园"），它的坐标可能压在柜台或墙上，所以移动
   * 判定只看瓦片格，不看地标坐标（见 rules.nearestOpen）。
   */
  places: WorldObject[]
  relations: SandboxRelation[]
  /**
   * 初始智能体模板。运行中的智能体（含记忆、位置）落在 RunState，不写回这里，
   * 这样同一个沙盒可以反复以不同人数开局。
   */
  agents: SandboxAgent[]
  /** 初始世界步数（复刻镜像可设非 0，表示"小镇已经运转了一阵"）。 */
  startTick?: number
}

/** 运行中的智能体 = 模板 + 运行期状态。 */
export interface RunAgent extends SandboxAgent {
  spawnTick: number
  /** 由谁加入：preset（沙盒自带）/ user（用户在界面里加的）。 */
  origin: 'preset' | 'user'
  memory: MemoryEntry[]
  lastUpdateTick: number
  /** 累计步数，用于记忆压缩节流。 */
  stepsTaken: number
}

export interface RunState {
  sandboxId: string
  tick: number
  agents: RunAgent[]
  events: WorldEvent[]
  directives: Directive[]
  /** 智能体之间的关系（初始来自沙盒，运行中会被改变）。 */
  relations: SandboxRelation[]
  /** 世界级状态槽（天气、时辰等），玩家也能改。 */
  worldState: Record<string, StateValue>
  createdAt: number
  updatedAt: number
}

// ── 步骤控制（需求 6）────────────────────────────────────────────────────

export interface StepConfig {
  mode: 'manual' | 'auto'
  /** 自动步进间隔（毫秒）。 */
  intervalMs: number
  /** 每步最多驱动多少个智能体（防止一次调用把配额打光）。 */
  maxAgentsPerTick: number
  /** 单个智能体的模型调用超时（毫秒）。 */
  callTimeoutMs: number
  /** 本工作区上次选中的沙盒：任何漏带 sandboxId 的请求按它兜底，避免被拽回列表第一个。 */
  sandboxId?: string
}

export const STEP_INTERVAL_MIN = 2000
export const STEP_INTERVAL_MAX = 600000
export const DEFAULT_STEP_CONFIG: StepConfig = {
  mode: 'manual',
  intervalMs: 15000,
  maxAgentsPerTick: 12,
  // 这是**空闲**上限的兜底值（见 routes.ts 的空闲计时器），不是单次调用的总时长上限。
  // 推理模型（workbuddy/cn:hy4-preview-f 等）在长提示词下可以推理 80 秒以上才吐第一个字，
  // 用总时长卡它，表现就是"模型没有返回文本"、界面上一堆降级——而它其实工作得好好的。
  callTimeoutMs: 60000,
}

export function clampStepConfig(input: Partial<StepConfig> | undefined): StepConfig {
  const src = input ?? {}
  const interval = Number(src.intervalMs)
  return {
    mode: src.mode === 'auto' ? 'auto' : 'manual',
    intervalMs: Number.isFinite(interval)
      ? Math.min(STEP_INTERVAL_MAX, Math.max(STEP_INTERVAL_MIN, Math.round(interval)))
      : DEFAULT_STEP_CONFIG.intervalMs,
    maxAgentsPerTick: Math.min(48, Math.max(1, Math.round(Number(src.maxAgentsPerTick) || DEFAULT_STEP_CONFIG.maxAgentsPerTick))),
    callTimeoutMs: Math.min(300000, Math.max(5000, Math.round(Number(src.callTimeoutMs) || DEFAULT_STEP_CONFIG.callTimeoutMs))),
    sandboxId: typeof src.sandboxId === 'string' && src.sandboxId !== '' ? src.sandboxId : undefined,
  }
}

// ── 智能体动作契约 ───────────────────────────────────────────────────────
//
// 引擎每步向模型要一个**声明式动作**：世界状态由 `mutations` 显式给出，而不是
// 引擎事后比对新旧快照去猜。猜出来的 diff 无法区分"发生过的动作"和"巧合的状态
// 相同"，审计日志会失真；显式声明让每一条状态变化都能追到是谁、在哪一步做的。

export type AgentActionKind =
  | 'move'
  | 'say'
  | 'observe'
  | 'act'
  | 'take'
  | 'give'
  | 'check'
  | 'opposed'
  | 'attack'
  | 'flee'
  | 'wait'

const ACTION_KINDS: readonly AgentActionKind[] = [
  'move',
  'say',
  'observe',
  'act',
  'take',
  'give',
  'check',
  'opposed',
  'attack',
  'flee',
  'wait',
]

export const ACTION_LABEL: Record<AgentActionKind, string> = {
  move: '移动',
  say: '交谈',
  observe: '观察',
  act: '行动',
  take: '取用',
  give: '给予',
  check: '尝试',
  opposed: '对抗',
  attack: '攻击',
  flee: '逃离',
  wait: '等待',
}

export function isActionKind(value: unknown): value is AgentActionKind {
  return typeof value === 'string' && (ACTION_KINDS as readonly string[]).includes(value)
}

/** 模型应当返回的动作 JSON。 */
export interface AgentAction {
  /** 内在想法（写进记忆，不进入公共事件流）。 */
  thought: string
  kind: AgentActionKind
  /** 行动的自然语言描述，直接进事件流。 */
  text: string
  /** 说出来的话（kind=say 时）。 */
  say?: string
  /** 目标对象 id（move/act/take 时）。 */
  objectId?: string
  /** 目标地标 id（move 时优先于裸坐标）。 */
  placeId?: string
  /** 目标坐标。 */
  x?: number
  y?: number
  /** 目标智能体 id（say/opposed/attack/give 时）。 */
  targetAgentId?: string
  /** 判定用的属性（check/opposed/attack 时）。 */
  attr?: AttrId
  /** 判定难度档位 id（check 时）。 */
  difficultyId?: string
  /** 显式状态改动：objectId + state 的键值覆盖。 */
  mutations?: Array<{ objectId: string; key: string; value: StateValue }>
  /** 移动失败时的备用停留理由，避免空步。 */
  note?: string
  /**
   * 这一步的心情变化：-2..+2（越界会被夹到该范围）。
   * 只给增量而不给绝对值，是为了让"环境 + 骰运"始终有权重——模型不能凭一句话
   * 把心情从崩溃直接改到兴奋。
   */
  moodDelta?: number
  /** 心情的词（不给就按指数自动取词）。 */
  moodLabel?: string
}

// ── 路由契约 ─────────────────────────────────────────────────────────────

export interface ModelChoice {
  provider: string
  /** 展示用 provider 名。 */
  providerName: string
  model: string
  modelName: string
  description?: string
  /** 是否是当前默认模型（新智能体的初始选择）。 */
  isDefault: boolean
}

export interface ModelsResponse {
  models: ModelChoice[]
  /** 取模型目录时是否出错（出错时仍返回候选，UI 明确提示）。 */
  error?: string
  /** 目录来源：live（llm 服务）/ fallback（默认模型单条）。 */
  source: 'live' | 'fallback'
}

export interface SandboxSaveBody {
  /** 不传 id 表示另存为新沙盒。 */
  id?: string
  name?: string
  desc?: string
  /** 从当前运行状态导出智能体（把运行中的位置/属性写回沙盒）。 */
  fromRun?: boolean
}

// ── 工具函数 ─────────────────────────────────────────────────────────────

/** 生成短 id（无需加密强度，只要在同一沙盒内不撞）。 */
/** 随机令牌：base36、定长。id 用它的**随机**部分，不用时间戳。 */
export function randomToken(length = 8): string {
  let out = ''
  while (out.length < length) out += Math.random().toString(36).slice(2)
  return out.slice(0, length)
}

export function shortId(prefix: string): string {
  // 时间戳只作前缀，便于肉眼排序；**唯一性完全靠随机部分**。
  // 这条曾经踩过：调用方写 `shortId('a').slice(2, 8)` 想取 6 位，实际取到的是
  // 时间戳的前 6 位（`a-muo9w5ok...` 的 `muo9w5`）——随机部分全被切掉，
  // 于是同一毫秒内生成的 id 完全相同（连重试 32 次都是同一个）。
  return `${prefix}-${Date.now().toString(36)}${randomToken(8)}`
}

/** 把任意输入读成一个状态值（拒绝对象/函数，避免脏数据进 JSON）。 */
export function toStateValue(input: unknown): StateValue | undefined {
  if (input === null) return null
  const t = typeof input
  if (t === 'string') return String(input).slice(0, 400)
  if (t === 'number') return Number.isFinite(input as number) ? (input as number) : undefined
  if (t === 'boolean') return input as boolean
  if (Array.isArray(input)) {
    const arr = input.filter((v) => typeof v === 'string' || typeof v === 'number').slice(0, 40)
    return arr.length === 0 ? [] : (arr as string[] | number[])
  }
  return undefined
}
