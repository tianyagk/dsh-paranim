/**
 * dsh-paranim — 公用契约（host 与 client 共享）。
 *
 * 这里定义三样东西，两端都只能通过它说话：
 *  1. 六维属性与 D6 判定引擎（`resolveCheck` / `adjudicate` / `DICE_RE`）
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
export const ATTR_MIN = 1
export const ATTR_MAX = 20

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

/** 只接受 1..6；其他输入返回 null（调用方决定报错口径）。 */
export const DICE_RE = /^[1-6]$/

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
export function isValidRoll(value: unknown): value is number {
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

/** 六项之和，用于「这个人总体多强」的粗略比较。 */
export function attrSum(attrs: Attrs): number {
  let sum = 0
  for (const id of ATTR_IDS) sum += attrs[id]
  return sum
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
  /** 修改者与时间，用于复盘「谁在什么时候动了这盏灯」。 */
  lastEditedBy?: string
  lastEditedAt?: number
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
  goal: string
  fear: string
  secret: string
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

export interface SandboxMap {
  width: number
  height: number
  ground: string
  /** 底色装饰（网格线等）由客户端按样式绘制，这里只放语义化的色块。 */
  decor?: Array<{ x: number; y: number; w: number; h: number; color: string; label?: string }>
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
  createdAt: number
  updatedAt: number
  map: SandboxMap
  places: WorldObject[]
  objects: WorldObject[]
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

export interface RunAgentSummary {
  /** 整体状态的一句话（由引擎按属性与处境生成）。 */
  mood: string
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
}

export const STEP_INTERVAL_MIN = 2000
export const STEP_INTERVAL_MAX = 600000
export const DEFAULT_STEP_CONFIG: StepConfig = {
  mode: 'manual',
  intervalMs: 15000,
  maxAgentsPerTick: 12,
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

export const ACTION_KINDS: readonly AgentActionKind[] = [
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

export interface WorldResponse {
  sandbox: Sandbox
  run: RunState
  step: StepConfig
  /** 运行中的智能体数（= run.agents.length，单独给出便于 UI 少算）。 */
  agentCount: number
}

export interface SandboxListResponse {
  sandboxes: Array<Pick<Sandbox, 'id' | 'name' | 'desc' | 'builtin' | 'attribution' | 'license' | 'updatedAt'> & {
    places: number
    objects: number
    agents: number
  }>
  currentId: string
}

export interface StepResponse {
  ok: boolean
  tick: number
  /** 本步新产生的事件。 */
  events: WorldEvent[]
  /** 本步实际被驱动的智能体数。 */
  driven: number
  /** 每个智能体的驱动结果（含未驱动的原因）。 */
  outcomes: Array<{ agentId: string; agentName: string; ok: boolean; detail: string }>
  error?: string
}

export interface DirectiveBody {
  agentId: string
  text: string
}

export interface ObjectPatchBody {
  objectId: string
  /** 要覆盖的状态键值（值为 null 表示删除该键）。 */
  state?: Record<string, StateValue | null>
  /** 改名 / 改坐标 / 改交互性 / 改描述。 */
  name?: string
  desc?: string
  x?: number
  y?: number
  interactive?: boolean
  color?: string
  /** 谁改的（写进 lastEditedBy，玩家默认 '玩家'）。 */
  by?: string
}

export interface AgentPatchBody {
  agentId?: string
  /** 新增时必填的模板字段。 */
  agent?: Partial<SandboxAgent> & { name?: string }
  /** 更新时按 id 覆盖字段。 */
  patch?: Partial<SandboxAgent>
  /** 从运行中移除（true = 离场）。 */
  remove?: boolean
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
export function shortId(prefix: string): string {
  const base = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 7)
  return `${prefix}-${base}${rand}`
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
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
