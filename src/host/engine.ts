/**
 * dsh-paranim — 世界步进引擎（需求 3 / 4 / 6 的执行体）。
 *
 * 一步（tick）的流程：
 *   1. 取本步要驱动的智能体（受 maxAgentsPerTick 限制）
 *   2. **并发**向每个智能体要一个声明式动作（各自走自己的模型路由）
 *   3. **串行**结算动作：世界状态是共享可变对象，并发结算会让判定读到半改的世界
 *   4. 落记忆、落事件、推进 tick
 *
 * 只有第 2 步是并发的，这一点是刻意的：模型调用是唯一的慢操作，而结算必须是
 * 确定性的顺序——两个智能体同时去抢同一把椅子，谁先动手必须可复现。
 */
import {
  ACTION_LABEL,
  ATTR_EN,
  DIFFICULTY_LADDER,
  MOOD_DEFAULT,
  MOOD_MAX,
  clampMood,
  moodLabel,
  normalizeMood,
  shortId,
  type AgentAction,
  type AgentModelRoute,
  type Directive,
  type MemoryEntry,
  type RunAgent,
  type RunState,
  type Sandbox,
  type WorldEvent,
  type WorldObject,
} from '../shared/model.ts'
import {
  bumpRelation,
  coerceAction,
  distance,
  extractJson,
  findObject,
  placeAt,
  realRng,
  relationBetween,
  resolveAction,
  type Rng,
} from '../shared/rules.ts'
import { objectsOf } from '../shared/tilemap.ts'
import { reflectionPrompt, retrieveMemories, shouldReflect } from '../shared/memory.ts'
import type { PluginLlm } from './context.ts'
import { log } from './context.ts'

/**
 * **存多少**（裁剪上限）与**取多少**（检索 top-k）是两件事。
 *
 * 原先两者共用一个 24，于是检索在最多 25 条里取 24 条——recency/importance/
 * relevance 三项打分对结果没有任何实质影响，memory.ts 那套 2-gram relevance、
 * 开方抬升、按步衰减**全是死代码**（第三方审查实测指出，F7）。
 * 落盘侧本来就是 slice(-200)，说明本来的心理模型就是两百条。
 */
const MEMORY_STORE = 200
/** 每次进提示词取几条（其余留在库里参与下次打分）。 */
const MEMORY_RECALL = 10
const MEMORY_CHARS = 9000

interface AgentCall {
  /** 该智能体的模型路由（null = 由调用方给出的兜底路由）。 */
  route: AgentModelRoute
  /** 系统提示。 */
  system: string
  /** 用户消息（观察）。 */
  user: string
}

export interface EngineDeps {
  sandbox: Sandbox
  run: RunState
  rng?: Rng
  /** 模型调用器：返回模型原文；抛错代表本步该智能体降级。 */
  callModel: (agent: RunAgent, call: AgentCall, signal: AbortSignal) => Promise<string>
  timeoutMs: number
  /** 每步驱动的智能体上限。 */
  maxAgentsPerTick: number
  /** 本步的时间戳（默认 Date.now()，测试可注入）。 */
  ts?: number
  /**
   * 智能体没有自带模型路由时的兜底路由（通常取宿主默认模型）。
   * 缺省时该智能体直接走守则行动，而不是报错——小镇不该因为没配模型就停摆。
   */
  defaultRoute?: AgentModelRoute
}

interface TickOutcome {
  agentId: string
  agentName: string
  ok: boolean
  /** 用了哪条路：model（模型给出动作）/ fallback（降级为守则行动）。 */
  source: 'model' | 'fallback'
  detail: string
}

export interface TickResult {
  tick: number
  events: WorldEvent[]
  outcomes: TickOutcome[]
  /** 本步被驱动的智能体数。 */
  driven: number
}

// ── 观察（喂给模型的世界快照）───────────────────────────────────────────

/** 物件行：WorldObject（地标）与 TileObject（格子物件）的公共部分就够用。 */
function objLine(o: { name: string; x: number; y: number; state: Record<string, unknown>; desc?: string; id?: string; kind?: string }, agent: RunAgent): string {
  const stateText = Object.entries(o.state)
    .map(([k, v]) => `${k}=${v === null ? '—' : Array.isArray(v) ? v.join('/') : String(v)}`)
    .join(' ')
  const dist = distance(agent.x, agent.y, o.x, o.y)
  return `- ${o.name}（id=${o.id}，${o.kind}，距离 ${dist} 格）${stateText === '' ? '' : ` 状态：${stateText}`}${dist <= 4 ? ' ← 你就在旁边，可以直接动手' : ''}`
}

function memoryLine(entry: MemoryEntry, currentTick: number): string {
  const ago = currentTick - entry.tick
  const when = ago <= 0 ? '此刻' : `${ago} 步前`
  const tag = entry.kind === 'thought' ? '（心里的想法）' : entry.kind === 'whisper' ? '（脑海里的声音）' : ''
  return `- [${when}]${tag} ${entry.text}`
}

/** 组装一个智能体此刻看到的世界。 */
function buildObservation(sandbox: Sandbox, run: RunState, agent: RunAgent): string {
  const place = placeAt(sandbox, agent.x, agent.y)
  const nearbyObjects = [...objectsOf(sandbox.map), ...sandbox.places]
    .map((o) => ({ o, d: distance(agent.x, agent.y, o.x, o.y) }))
    .filter((x) => x.d <= 30)
    .sort((a, b) => a.d - b.d)
    .slice(0, 10)
    .map((x) => objLine(x.o, agent))

  const others = run.agents
    .filter((a) => a.id !== agent.id)
    .map((a) => ({ a, d: distance(agent.x, agent.y, a.x, a.y) }))
    .filter((x) => x.d <= 40)
    .sort((l, r) => l.d - r.d)
    .slice(0, 6)

  const otherLines = others.map(({ a, d }) => {
    const affinity = relationBetween(run, agent.id, a.id)
    const tone = affinity >= 40 ? '亲近' : affinity >= 15 ? '友好' : affinity <= -30 ? '敌对' : affinity <= -10 ? '有摩擦' : '平常'
    return `- ${a.name}（id=${a.id}，${a.concept}，距离 ${d} 格，你们的关系：${tone}）此刻在 ${placeAt(sandbox, a.x, a.y)?.name ?? `(${a.x},${a.y})`}`
  })

  const pending = run.directives.filter((d) => d.agentId === agent.id && !d.consumed)
  const directiveLines = pending.map((d) => `- ${d.text}`)

  const planLeft = agent.plan.length === 0 ? '（今天的计划已经做完了）' : agent.plan.map((p, i) => `  ${i + 1}. ${p}`).join('\n')

  const summary = agent.memory.filter((m) => m.kind === 'summary').slice(-1)[0]
  /**
   * **检索**而不是"取最近 N 条"（见 shared/memory.ts 的说明）。
   *
   * 查询串用"我在哪 + 我打算做什么"——也就是 P0 里 relevance 的 query：
   * 站在厨房里的人，该想起的是**在这个厨房里发生过的事**，而不是恰好排在
   * 时间线末尾的那几条（那可能全是刚才路上的风景）。
   */
  // query 只放**实词**：地点名 + 计划。坐标塞进去只会切出一堆数字噪音，
  // 把 relevance 的分母撑大（"厨房"命中一次就只值几分之一）。
  const queryText = [place?.name ?? '', ...agent.plan.slice(0, 4)].join(' ')
  const recalled = retrieveMemories(
    agent.memory.filter((m) => m.kind !== 'summary'),
    queryText,
    run.tick,
    MEMORY_RECALL,
  )
  // 取出来的按时间排回：检索决定"想起哪些"，时间顺序决定"怎么读"。
  recalled.sort((a, b) => a.entry.tick - b.entry.tick)
  // 被取用过就记一笔，下次的 recency 从这里算（论文的 recency 也是这么定义的）
  for (const r of recalled) r.entry.lastAccessTick = run.tick
  const rest = recalled.map((r) => r.entry)

  const worldState = Object.entries(run.worldState)
    .map(([k, v]) => `${k}=${v === null ? '—' : Array.isArray(v) ? v.join('/') : String(v)}`)
    .join('，')

  return [
    `【世界】${sandbox.name}｜第 ${run.tick + 1} 步｜${worldState === '' ? '天气与时辰未定' : worldState}`,
    '',
    `【你是谁】${agent.name}（id=${agent.id}），${agent.concept}。`,
    `外貌：${agent.appearance === '' ? '（未描述）' : agent.appearance}`,
    `性格：${agent.persona === '' ? '（未描述）' : agent.persona}`,
    `你现在的心情：${moodText(agent)}`,
    `你此刻在想：${currentThoughtOf(agent) ?? '（脑子里空空的）'}`,
    `你的六维（1D6 + 属性 ≥ 难度即成功）：${ATTR_EN.str} ${agent.attrs.str}｜${ATTR_EN.con} ${agent.attrs.con}｜${ATTR_EN.dex} ${agent.attrs.dex}｜${ATTR_EN.app} ${agent.attrs.app}｜${ATTR_EN.int} ${agent.attrs.int}｜${ATTR_EN.pow} ${agent.attrs.pow}`,
    '',
    `【你在哪】${place?.name ?? `空旷处 (${agent.x},${agent.y})`}，坐标 (${agent.x},${agent.y})`,
    `随身：${agent.inventory.length === 0 ? '空手' : agent.inventory.join('、')}`,
    '',
    '【今天的计划】',
    planLeft,
    '',
    summary === undefined ? '' : `【你记得的来历】${summary.text}`,
    '【你最近经历的事】',
    rest.length === 0 ? '- （还没发生什么）' : rest.map((m) => memoryLine(m, run.tick)).join('\n'),
    '',
    '【你能看到的东西】',
    nearbyObjects.length === 0 ? '- 附近没什么值得注意的' : nearbyObjects.join('\n'),
    '',
    '【附近的人】',
    otherLines.length === 0 ? '- 此刻没有别人在附近' : otherLines.join('\n'),
    directiveLines.length === 0 ? '' : '\n【上级刚给你的指令（你必须立刻执行，优先级最高）】\n' + directiveLines.join('\n'),
  ]
    .filter((line) => line !== '')
    .join('\n')
}

/** 系统提示：把动作契约讲清楚，一次讲透，避免模型每步重新猜格式。 */
function systemPromptFor(agent: RunAgent): string {
  return [
    `你正在扮演一座小镇里的居民「${agent.name}」。你是一个有欲望、有秘密、会犯错的普通人，不是一个乐于助人的助手。`,
    '你只做你此刻想做的事。不要旁白，不要总结，不要替别人说话，不要询问用户。',
    '',
    '每一步你都必须输出**一个 JSON 对象**，不要输出任何额外文字：',
    '{',
    '  "thought": "你此刻心里在想什么（一句话，别人看不到）",',
    '  "kind": "move | say | observe | act | take | give | check | opposed | attack | flee | wait",',
    '  "text": "你做这件事的第三人称叙述（一句话，会写进镇上的公共记录）",',
    '  "say": "kind=say 时你说出口的原话",',
    '  "placeId": "kind=move 时目的地的 id（用【你能看到的东西】里的 id）",',
    '  "targetAgentId": "对话/对抗/攻击的对象 id",',
    '  "attr": "kind=check/opposed/attack 时用哪一项属性：str|con|dex|app|int|pow",',
    '  "difficultyId": "kind=check 时的难度："',
    '  "mutations": [{ "objectId": "物体 id", "key": "状态键", "value": "新值" }],',
    '  "moodDelta": "这一步的心情变化，-2..+2 的整数（比如被人冷落填 -1，事情办成了填 +1）",',
    '  "moodLabel": "变化后的心情词，一个词，例如 开心 / 烦躁 / 疲惫 / 兴奋"',
    '}',
    '',
    `difficultyId 可选值（越难越需要运气）：${DIFFICULTY_LADDER.map((d) => `${d.id}(${d.label} ${d.value})`).join('，')}`,
    'mutations 是**显式**的状态改动：你想把某盏灯改成"故障"、把某扇门锁上、把告示张贴出去，都写在这里。',
    '改动必须发生在你 4 格之内的物体上，并且会先掷一次 DEX 判定；够不着或判定失败，改动不会生效。',
    '没有把握的事就走 kind="check" 让骰子决定，不要自己宣布成败。',
    '心情只给**增量**（不是你希望它变成多少）：环境、别人的态度、骰运都有权重。没有变化就不填。',
    '叙述要具体到动作与感官（谁、在哪、做什么、发出什么响），不要抽象成情绪总结。',
  ].join('\n')
}

// ── 记忆维护 ─────────────────────────────────────────────────────────────

/**
 * 记忆裁剪：保留最近的若干条 + 一条来历摘要。
 *
 * 为什么要留摘要而不是纯滑动窗口：一个智能体走到第 200 步时，纯窗口会让它忘了
 * 自己是谁、跟谁有过什么——行为会退化成"对每个路人重新自我介绍"。摘要把来历
 * 压成一行常量，窗口才敢开小。
 */
function pruneMemory(agent: RunAgent): void {
  if (agent.memory.length <= MEMORY_STORE) return
  const summaries = agent.memory.filter((m) => m.kind === 'summary')
  const keepSummary = summaries.slice(-1)
  /**
   * 反思与计划**不参与"丢最旧的"**。
   *
   * 它们是更高层的结论（反思是模型从几十条经历里提炼的一句话，计划是今天
   * 的意图），按时间裁剪时会被新产生的日常动作顶掉——留下的全是流水账，
   * 反而把最该记住的东西挤没了。各自只保最近若干条，避免无限增长。
   */
  const highLevel = agent.memory.filter((m) => m.kind === 'reflection' || m.kind === 'plan').slice(-12)
  const highSet = new Set(highLevel)
  const rest = agent.memory.filter((m) => m.kind !== 'summary' && !highSet.has(m))
  let kept = rest.slice(-(MEMORY_STORE - highLevel.length))
  let chars = kept.reduce((sum, m) => sum + m.text.length, 0)
  while (chars > MEMORY_CHARS && kept.length > 4) {
    kept = kept.slice(1)
    chars = kept.reduce((sum, m) => sum + m.text.length, 0)
  }
  agent.memory = [...keepSummary, ...highLevel, ...kept]
}

/** 把一次经历写进记忆。 */
export function remember(agent: RunAgent, entry: MemoryEntry): void {
  agent.memory.push(entry)
  /**
   * 单调递增的"我这一生经历过多少条"。
   *
   * 反思游标原先存的是**数组下标**，而 pruneMemory 把数组裁到定长——
   * 第一次反思时游标写 24，此后长度恒为 24，`slice(24)` 恒为空，
   * **永远不再反思**（第三方审查实测指出，F2）。计数与数组长度解耦之后
   * 裁剪多少都不影响它。
   */
  agent.memoriesSeen = (agent.memoriesSeen ?? 0) + 1
  pruneMemory(agent)
}

// ── 兜底行动（无模型 / 模型失败 / 输出不可解析）──────────────────────────
//
// 兜底**不编造剧情**：它只执行计划里的下一步与眼前能做的事。一段没有模型驱动的
// 小镇仍然会在走、在说话、在开关灯，而不是冻结——需求 6 的"手动步进"必须永远
// 有反馈，否则界面会像是坏了。

function fallbackAction(sandbox: Sandbox, run: RunState, agent: RunAgent): AgentAction {
  const planStep = agent.plan[0]
  if (planStep !== undefined) {
    const hit = [...sandbox.places, ...objectsOf(sandbox.map)].find((o) => planStep.includes(o.name))
    if (hit !== undefined && distance(agent.x, agent.y, hit.x, hit.y) > 3) {
      return { thought: `该去${hit.name}了。`, kind: 'move', text: `动身前往${hit.name}`, placeId: hit.id, note: planStep }
    }
    if (hit !== undefined) {
      return { thought: `到了${hit.name}，看看这边的情况。`, kind: 'observe', text: `在${hit.name}附近打量了一圈`, objectId: hit.id, note: planStep }
    }
    return { thought: planStep, kind: 'act', text: planStep, note: '按计划行事' }
  }
  const here = [...objectsOf(sandbox.map)]
    .map((o) => ({ o, d: distance(agent.x, agent.y, o.x, o.y) }))
    .filter((x) => x.d <= 4)
    .sort((a, b) => a.d - b.d)[0]
  const other = run.agents
    .filter((a) => a.id !== agent.id)
    .map((a) => ({ a, d: distance(agent.x, agent.y, a.x, a.y) }))
    .filter((x) => x.d <= 8)
    .sort((a, b) => a.d - b.d)[0]
  if (here !== undefined && agent.attrs.dex >= 6) {
    const key = Object.keys(here.o.state)[0] ?? 'status'
    const current = here.o.state[key]
    const next = current === '正常' ? '被碰过' : '正常'
    return {
      thought: `顺手把${here.o.name}动了动。`,
      kind: 'act',
      text: `摆弄了一下${here.o.name}`,
      objectId: here.o.id,
      mutations: [{ objectId: here.o.id, key, value: next }],
    }
  }
  if (other !== undefined) {
    return { thought: `跟${other.a.name}说两句。`, kind: 'say', text: `和${other.a.name}打了个招呼`, say: '今天的天气倒是不错。', targetAgentId: other.a.id }
  }
  return { thought: '先站一会儿，看看再说。', kind: 'observe', text: '在原地看了一会儿镇上的人来人往' }
}

// ── 一步的驱动 ───────────────────────────────────────────────────────────

/**
 * 当前想法 = 最近一条"心里想的"记忆。
 *
 * 不另设字段存它：`thought` 每一步都写进 memory，再存一份就等于同一件事有两个
 * 真相来源，迟早对不上。派生出来的东西永远与记忆一致。
 */
function currentThoughtOf(agent: RunAgent): string | undefined {
  for (let i = agent.memory.length - 1; i >= 0; i -= 1) {
    const entry = agent.memory[i]
    if (entry.kind === 'thought' && entry.text.trim() !== '') return entry.text
  }
  return undefined
}

/** 心情的一行文本，例如「生气 4/10」——词给色彩，指数给高低。 */
function moodText(agent: RunAgent): string {
  const mood = normalizeMood(agent.mood ?? MOOD_DEFAULT)
  return `${mood.label} ${mood.value}/${MOOD_MAX}`
}

/** 把一步的心情增量应用上去（没有增量就保持不变）。 */
function applyMood(agent: RunAgent, action: AgentAction, tick: number, ts: number): void {
  const delta = action.moodDelta ?? 0
  if (delta === 0 && action.moodLabel === undefined) return
  const before = normalizeMood(agent.mood ?? MOOD_DEFAULT)
  const value = clampMood(before.value + delta)
  // 模型给了词就用它（它对"刚才那件事"的反应最清楚），没给才按指数自动取
  const label = action.moodLabel ?? (value === before.value ? before.label : moodLabel(value))
  agent.mood = { value, label }
  if (value !== before.value) {
    remember(agent, {
      // tick 必须是**当时**的世界步数：写死 0 会让这条记忆显示成"第 0 步的事"，
      // 越往后越离谱（本地跑了 6 步后它显示"6 步前"，而它其实是刚发生的）。
      tick,
      kind: 'event',
      text: `心情从「${before.label} ${before.value}/${MOOD_MAX}」变成「${label} ${value}/${MOOD_MAX}」。`,
      ts,
    })
  }
}

function timeoutSignal(ms: number, parent?: AbortSignal): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`模型调用超时（${ms}ms）`)), ms)
  const onAbort = (): void => controller.abort(parent?.reason)
  if (parent !== undefined) {
    if (parent.aborted) controller.abort(parent.reason)
    else parent.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      parent?.removeEventListener('abort', onAbort)
    },
  }
}

/** 一次取材的结果：动作 + 它是怎么来的（复盘要能区分模型与降级）。 */
interface Draft {
  action: AgentAction
  source: 'model' | 'fallback'
  detail: string
}

/**
 * 为一个智能体取一个动作。
 *
 * 这是**唯一**的"取动作"实现：并发预取与串行结算都走它，所以降级口径
 * （无路由 → 兜底；空文本/非 JSON/调用失败 → 兜底）只有一处，不会出现
 * "重试路径悄悄放宽了格式要求"这种双份契约。
 */
/**
 * 反思（P1）。
 *
 * 对照 Stanford 论文第 4.2 节：拿最近一段经历问模型"这说明了什么"，把答案
 * 作为一条更高层的记忆存回记忆流。原文说"一天约两三次"——因为**只有反思
 * 能让智能体从重复经历里得出结论**，光有观察，它只能一次次重新试探。
 *
 * 三条工程上的分寸：
 *  · 反思失败**不影响这一步的行动**：它是锦上添花，不该把整步拖垮；
 *  · 无论成没成都推进游标（lastReflectAt），否则同一段记忆会被反复反思，
 *    白白烧掉调用；
 *  · 没有可用模型时直接跳过并推进游标——不推进的话每步都会重试同一段。
 */
async function maybeReflect(
  deps: EngineDeps,
  agent: RunAgent,
  run: RunState,
  ts: number,
  signal: AbortSignal,
): Promise<void> {
  const seen = agent.memoriesSeen ?? agent.memory.length
  if (!shouldReflect(agent.memory, agent.lastReflectAt, seen)) return
  const upto = seen
  const route = agent.model ?? deps.defaultRoute
  if (route === undefined || route === null) {
    agent.lastReflectAt = upto
    return
  }
  /**
   * 反思也要过闸。原先传的是 `controller.signal`——那个信号在 runTick 里
   * **从不 abort**，于是"一次挂起的反思会把整步的 Promise.all 永远吊住"
   * （第三方审查指出，F1 附带项）。这里给它自己的总时长上限。
   */
  const gate = timeoutSignal(Math.max(deps.timeoutMs * 2, 120_000), signal)
  try {
    const text = await deps.callModel(agent, {
      route,
      system: `你是${agent.name}，${agent.concept}。你会定期回顾自己最近的经历，并写下几句真实的感想。`,
      user: reflectionPrompt(agent.name, agent.memory),
    }, gate.signal)
    const clean = text.trim().slice(0, 400)
    if (clean !== '') {
      remember(agent, { tick: run.tick, kind: 'reflection', text: clean, ts, importance: 8 })
    }
  } catch (error) {
    log('reflection failed:', String(error))
  } finally {
    gate.clear()
  }
  agent.lastReflectAt = upto
}

async function draftAction(
  deps: EngineDeps,
  agent: RunAgent,
  signal: AbortSignal,
): Promise<Draft> {
  const { sandbox, run } = deps
  const route = agent.model ?? deps.defaultRoute
  if (route === undefined || route === null) {
    return { action: fallbackAction(sandbox, run, agent), source: 'fallback', detail: '未指定模型且宿主无默认模型' }
  }
  /**
   * 一次模型调用的时限。
   *
   * 这里曾经写的是 `Math.max(deps.timeoutMs, 600000)`——本意是"再给一层宽得多的
   * 总时长天花板，免得一次死锁把整局挂住"，实际效果却是**用户配的 callTimeoutMs
   * 永远不起作用**（除非配得比十分钟还长）。模型一旦挂起，界面就是"点了步进、
   * 步数不动、事件不动、也不报错"，要等十分钟才等到一句超时——用户看到的正是
   * 这个（他反馈的"步进结束后没有任何变化"）。
   *
   * ⚠️ 这里**不能用 callTimeoutMs 当总时长**。
   *
   * 我上一轮就是这么改的，结果只对了一半：callTimeoutMs 的语义是**空闲**上限
   * （"多久没有新东西"），而这道闸是**总时长**（从调用开始计时，不看有没有
   * 产出）。推理模型一次要跑 80 秒以上、期间一直在吐 token，被这道总闸先截断，
   * 内层那道正确的空闲闸根本来不及响——用户看到的是"整轮降级"，而模型一切正常。
   *
   * 现在这里只保留**死锁兜底**（给得极宽，唯一的职责是"别让一次死锁把整局挂住"），
   * 真正的超时判据交给 routes.ts 里按 idleMs 实现的那一个。
   */
  const bounded = timeoutSignal(Math.max(deps.timeoutMs * 5, 300_000), signal)
  try {
    const call: AgentCall = { route, system: systemPromptFor(agent), user: buildObservation(sandbox, run, agent) }
    const text = await deps.callModel(agent, call, bounded.signal)
    const parsed = extractJson(text)
    if (parsed === null) {
      return { action: fallbackAction(sandbox, run, agent), source: 'fallback', detail: '模型输出不是可解析的 JSON' }
    }
    const action = coerceAction(parsed)
    return { action, source: 'model', detail: `${ACTION_LABEL[action.kind]}｜${action.text}`.slice(0, 200) }
  } catch (error) {
    // 超时要说得像超时：否则界面上一句"The operation was aborted"看不出到底是
    // 配置太短还是模型那边挂了——这两件事的处理方式完全不同。
    return {
      action: fallbackAction(sandbox, run, agent),
      source: 'fallback',
      detail: bounded.signal.aborted
        ? `模型超过 ${Math.round(Math.max(deps.timeoutMs, 10_000) / 1000)} 秒没有返回（可调大 step.callTimeoutMs）`
        : `模型调用失败：${error instanceof Error ? error.message : String(error)}`,
    }
  } finally {
    bounded.clear()
  }
}

/** 把一次动作结算进世界：位置、记忆、指令消费。返回它产生的事件。 */
function settle(deps: EngineDeps, agent: RunAgent, action: AgentAction, ts: number): WorldEvent[] {
  const { sandbox, run } = deps
  const resolved = resolveAction(action, {
    sandbox,
    run,
    agent,
    rng: deps.rng ?? realRng,
    ts,
    operator: 'agent',
  })
  agent.x = resolved.x
  agent.y = resolved.y
  agent.lastUpdateTick = run.tick
  agent.stepsTaken += 1
  if (agent.plan.length > 0) agent.plan = agent.plan.slice(1)
  for (const entry of resolved.memory) remember(agent, entry)
  applyMood(agent, action, run.tick, ts)

  /**
   * 被互动的**对方**也要记得（第三方审查 F6）。
   *
   * `resolveAction` 只返回行动方的记忆，于是被搭话的人下一步完全不记得
   * "刚才有人对我说了 X"——它的检索无从谈起（近处没有任何相关语料），
   * 对话因此无法继续；关系变化的"为什么"也只剩单方视角。
   * Stanford 论文里对话双方都会把这段对话记进各自的记忆流。
   *
   * 直接沿用事件原文（第三人称），与记忆里其它条目保持同一种口吻。
   */
  for (const event of resolved.events) {
    const targetId = event.targetAgentId
    if (targetId === undefined || targetId === agent.id) continue
    const other = run.agents.find((a) => a.id === targetId)
    if (other === undefined) continue
    remember(other, { tick: run.tick, kind: 'observation', text: event.text, ts })
  }

  /**
   * 指令的消费时机：**只有真的做出了动作才算用完**。
   *
   * 原先无条件消费，于是模型这一步要是返回了空动作、或者动作在清洗里被丢掉，
   * 指令就白白消耗了——它会从上下文里消失，而人明明看到自己刚下过指令。
   * 用户描述的"下达指令后步进卡住"正是这种：指令不见了，智能体也不照做。
   *
   * 反过来也不能永远不消费：那会每步都注入"必须立刻执行"，把同一条指令
   * 反复塞进观察，模型一直对着它打转。所以条件是"这一步确实做了事"。
   */
  const acted = resolved.events.length > 0 || resolved.mutations.length > 0
  if (acted) {
    const used = run.directives.filter((d) => d.agentId === agent.id && !d.consumed)
    for (const directive of used) {
      directive.consumed = true
      directive.consumedAtTick = run.tick
      remember(agent, { tick: run.tick, kind: 'whisper', text: `有人对你说：${directive.text}`, ts })
    }
  }

  const events = resolved.events
  if (resolved.empty) {
    events.push({
      id: shortId('ev'),
      tick: run.tick,
      ts,
      kind: 'act',
      actor: agent.id,
      actorName: agent.name,
      text: `${agent.name}停在原地，这一段时间就这么过去了。`,
    })
  }
  return events
}

/** 执行一步。 */
export async function runTick(deps: EngineDeps): Promise<TickResult> {
  const { sandbox, run } = deps
  const ts = deps.ts ?? Date.now()
  run.tick += 1
  const pool = run.agents.slice(0, Math.max(1, deps.maxAgentsPerTick))
  const controller = new AbortController()

  // 1) 并发取动作——模型调用是整步里唯一的慢操作。
  const drafted = await Promise.all(pool.map(async (agent) => {
    // 反思排在取动作之前：这样它刚得出的结论，紧接着就能影响这一步的选择
    await maybeReflect(deps, agent, run, ts, controller.signal)
    return { agent, draft: await draftAction(deps, agent, controller.signal) }
  }))

  // 2) 串行结算：世界状态是共享可变的，顺序结算才有可复现的因果（谁先动手）。
  const events: WorldEvent[] = []
  const outcomes: TickOutcome[] = []
  for (const { agent, draft } of drafted) {
    events.push(...settle(deps, agent, draft.action, ts))
    outcomes.push({ agentId: agent.id, agentName: agent.name, ok: true, source: draft.source, detail: draft.detail })
  }

  /**
   * 有智能体没走成模型时，**在事件流里留一条**。
   *
   * 这条信息原先只存在于返回值里（outcomes），而界面只用它数了个数——
   * 模型挂了、输出不是合法 JSON 时，复盘的人翻事件流什么也看不到，
   * 只看到那一步"什么都没发生"。降级本身不打断推演，但必须留痕。
   */
  const degraded = outcomes.filter((o) => o.source !== 'model')
  if (degraded.length > 0) {
    events.push({
      id: shortId('ev'),
      tick: run.tick,
      ts,
      kind: 'system',
      actor: 'gm',
      actorName: '世界',
      text: `${degraded.length}/${outcomes.length} 位智能体这一步没走成模型：`
        + degraded.map((o) => `${o.agentName}（${o.detail}）`).join('；'),
    })
  }

  run.events.push(...events)
  if (run.events.length > 3000) run.events = run.events.slice(-3000)
  run.updatedAt = ts
  return { tick: run.tick, events, outcomes, driven: drafted.length }
}

// ── 用户指令（需求 3 的「指令引导」）──────────────────────────────────────

export function issueDirective(run: RunState, agentId: string, text: string): Directive {
  const agent = run.agents.find((a) => a.id === agentId)
  if (agent === undefined) throw new Error(`找不到智能体 ${agentId}`)
  const clean = text.trim().slice(0, 400)
  if (clean === '') throw new Error('指令不能为空')
  const directive: Directive = {
    id: shortId('dir'),
    agentId,
    text: clean,
    consumed: false,
    createdAt: Date.now(),
  }
  run.directives.push(directive)
  // 指令同时也进公共事件流：用户希望看到自己下过什么，也能在复盘里对上因果。
  run.events.push({
    id: shortId('ev'),
    tick: run.tick,
    ts: directive.createdAt,
    kind: 'directive',
    actor: 'gm',
    actorName: '指令',
    text: `【指令】对${agent.name}：${clean}`,
    targetAgentId: agentId,
  })
  if (run.events.length > 3000) run.events = run.events.slice(-3000)
  return directive
}

// ── 模型调用器 ───────────────────────────────────────────────────────────

/** 列举可用模型（provider × model），供界面选「驱动模型」。 */
export async function listModelChoices(
  llm: PluginLlm | undefined,
  defaultRoute: AgentModelRoute | undefined,
): Promise<{ models: import('../shared/model.ts').ModelChoice[]; error?: string; source: 'live' | 'fallback' }> {
  const out: import('../shared/model.ts').ModelChoice[] = []
  if (llm === undefined) {
    return {
      models: defaultRoute === undefined ? [] : [{
        provider: defaultRoute.provider,
        providerName: defaultRoute.provider,
        model: defaultRoute.model,
        modelName: defaultRoute.model,
        isDefault: true,
      }],
      source: 'fallback',
      error: '宿主 llm 服务不可用',
    }
  }
  let error: string | undefined
  const providers = llm.listProviders()
  for (const provider of providers) {
    try {
      const models = await llm.listModels(provider.id)
      for (const model of models) {
        out.push({
          provider: provider.id,
          providerName: provider.name,
          model: model.id,
          modelName: model.name,
          description: model.description,
          isDefault: defaultRoute !== undefined && defaultRoute.provider === provider.id && defaultRoute.model === model.id,
        })
      }
    } catch (err) {
      error = `${provider.id}: ${err instanceof Error ? err.message : String(err)}`
      log('listModels failed for', provider.id, String(err))
    }
  }
  if (out.length > 0) return { models: out, error, source: 'live' }
  return {
    models: defaultRoute === undefined ? [] : [{
      provider: defaultRoute.provider,
      providerName: defaultRoute.provider,
      model: defaultRoute.model,
      modelName: defaultRoute.model,
      isDefault: true,
    }],
    source: 'fallback',
    error: error ?? 'provider 没有返回任何模型',
  }
}
