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
import type { PluginLlm } from './context.ts'
import { log } from './context.ts'

const MEMORY_KEEP = 24
const MEMORY_CHARS = 6000

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

function objLine(o: WorldObject, agent: RunAgent): string {
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
  const nearbyObjects = [...sandbox.objects, ...sandbox.places]
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

  const recent = agent.memory.slice(-MEMORY_KEEP)
  const summary = recent.filter((m) => m.kind === 'summary').slice(-1)[0]
  const rest = recent.filter((m) => m.kind !== 'summary')

  const worldState = Object.entries(run.worldState)
    .map(([k, v]) => `${k}=${v === null ? '—' : Array.isArray(v) ? v.join('/') : String(v)}`)
    .join('，')

  return [
    `【世界】${sandbox.name}｜第 ${run.tick + 1} 步｜${worldState === '' ? '天气与时辰未定' : worldState}`,
    '',
    `【你是谁】${agent.name}（id=${agent.id}），${agent.concept}。`,
    `外貌：${agent.appearance === '' ? '（未描述）' : agent.appearance}`,
    `性格：${agent.persona === '' ? '（未描述）' : agent.persona}`,
    `你想要的：${agent.goal === '' ? '（未设定）' : agent.goal}`,
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
    '  "mutations": [{ "objectId": "物体 id", "key": "状态键", "value": "新值" }]',
    '}',
    '',
    `difficultyId 可选值（越难越需要运气）：${DIFFICULTY_LADDER.map((d) => `${d.id}(${d.label} ${d.value})`).join('，')}`,
    'mutations 是**显式**的状态改动：你想把某盏灯改成"故障"、把某扇门锁上、把告示张贴出去，都写在这里。',
    '改动必须发生在你 4 格之内的物体上，并且会先掷一次 DEX 判定；够不着或判定失败，改动不会生效。',
    '没有把握的事就走 kind="check" 让骰子决定，不要自己宣布成败。',
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
  if (agent.memory.length <= MEMORY_KEEP) return
  const summaries = agent.memory.filter((m) => m.kind === 'summary')
  const keepSummary = summaries.slice(-1)
  const rest = agent.memory.filter((m) => m.kind !== 'summary')
  let kept = rest.slice(-MEMORY_KEEP)
  let chars = kept.reduce((sum, m) => sum + m.text.length, 0)
  while (chars > MEMORY_CHARS && kept.length > 4) {
    kept = kept.slice(1)
    chars = kept.reduce((sum, m) => sum + m.text.length, 0)
  }
  agent.memory = [...keepSummary, ...kept]
}

/** 把一次经历写进记忆。 */
export function remember(agent: RunAgent, entry: MemoryEntry): void {
  agent.memory.push(entry)
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
    const hit = [...sandbox.places, ...sandbox.objects].find((o) => planStep.includes(o.name))
    if (hit !== undefined && distance(agent.x, agent.y, hit.x, hit.y) > 3) {
      return { thought: `该去${hit.name}了。`, kind: 'move', text: `动身前往${hit.name}`, placeId: hit.id, note: planStep }
    }
    if (hit !== undefined) {
      return { thought: `到了${hit.name}，看看这边的情况。`, kind: 'observe', text: `在${hit.name}附近打量了一圈`, objectId: hit.id, note: planStep }
    }
    return { thought: planStep, kind: 'act', text: planStep, note: '按计划行事' }
  }
  const here = [...sandbox.objects]
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
  const bounded = timeoutSignal(deps.timeoutMs, signal)
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
    return {
      action: fallbackAction(sandbox, run, agent),
      source: 'fallback',
      detail: `模型调用失败：${error instanceof Error ? error.message : String(error)}`,
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

  // 消费掉本步用过的指令：已消费的指令不再是"立刻执行"，但留在记忆里。
  const used = run.directives.filter((d) => d.agentId === agent.id && !d.consumed)
  for (const directive of used) {
    directive.consumed = true
    directive.consumedAtTick = run.tick
    remember(agent, { tick: run.tick, kind: 'whisper', text: `有人对你说：${directive.text}`, ts })
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
  const drafted = await Promise.all(pool.map(async (agent) => ({ agent, draft: await draftAction(deps, agent, controller.signal) })))

  // 2) 串行结算：世界状态是共享可变的，顺序结算才有可复现的因果（谁先动手）。
  const events: WorldEvent[] = []
  const outcomes: TickOutcome[] = []
  for (const { agent, draft } of drafted) {
    events.push(...settle(deps, agent, draft.action, ts))
    outcomes.push({ agentId: agent.id, agentName: agent.name, ok: true, source: draft.source, detail: draft.detail })
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
