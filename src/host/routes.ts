/**
 * /paranim/* 路由：浏览器半边与宿主半边之间唯一的通道（同源 fetch）。
 *
 * 分工刻意如此：**沙盒、运行态、引擎、模型调用全部在宿主**，浏览器只负责画和
 * 点击。这样"自动步进"在关掉页面后依然成立（计时器在宿主进程里），也让模型
 * 调用不必把任何凭据交给浏览器。
 *
 * 写接口一律要求 application/json，并过浏览器信任围栏（与 /api 网关、
 * dsh-better-sidebar 的 trust-fence 同一口径）。这是 DNS-rebinding / 跨站表单
 * 的防线，不是身份认证。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import {clampStepConfig, isAttrId, MOOD_DEFAULT, normalizeAttrs, normalizeMood, resolveCheck, randomToken, shortId, toStateValue, type Sandbox, type SandboxAgent, type SandboxSaveBody, type StateValue, type AgentModelRoute, type StepConfig, type WorldObject, type RunState, type SandboxMap, type TileLayer, type TileNote} from '../shared/model.ts'
import { findObject } from '../shared/rules.ts'
import { LAYER_LABEL, emptyLayers, makeBuiltinTileset, objectsOf, parseRef, positionOfObjectId, resolveRef, setObjectState } from '../shared/tilemap.ts'
import { isTrustedApiRequest } from './fence.ts'
import { messageOf, type LlmMessage, type PluginLlm, type PluginWebRoute } from './context.ts'
import { log } from './context.ts'
import { issueDirective, listModelChoices, runTick, type TickResult } from './engine.ts'
import { RunStore, SandboxStore, StepStore, normalizeObject, normalizeSandbox, normalizeTileset } from './store.ts'

/** 一次模型调用的描述（与 engine.ts 内部同名结构对齐：路由 + 系统提示 + 用户观察）。 */
interface LlmCall {
  route: AgentModelRoute
  system: string
  user: string
}

const MAX_BODY = 512 * 1024

export interface RouteDeps {
  store: SandboxStore
  stepOf: (workspace: string | undefined) => StepStore
  runOf: (workspace: string | undefined) => RunStore
  llm: () => PluginLlm | undefined
  defaultRoute: () => { provider: string; model: string; reasoningEffort?: string } | undefined
  /** 从请求里解析工作区（决定运行态分桶）。 */
  workspaceOf: (req: IncomingMessage) => string | undefined
}

class HttpError extends Error {
  // 不用 TS 的参数属性：`node --experimental-strip-types` 的 strip-only 模式
  // 不支持它，而 selftest 就是直接跑 .ts 的（写法受限是为了让自检能跑）。
  readonly status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

function send(res: ServerResponse, code: number, payload: unknown): void {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? '/', 'http://localhost').searchParams
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // Content-Type 断言：浏览器对 `<form>` 只能发 urlencoded / text/plain /
  // multipart，所以"必须 application/json"把跨站表单整类挡在路由之外。
  const contentType = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) {
    throw new HttpError(`Content-Type 必须是 application/json（收到 ${contentType === '' ? '空' : contentType}）`, 415)
  }
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > MAX_BODY) throw new HttpError(`请求体过大（上限 ${MAX_BODY} 字节）`, 413)
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError('请求体必须是 JSON 对象', 400)
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError('请求体不是合法 JSON', 400)
  }
}

// ── 自动步进（需求 6）────────────────────────────────────────────────────
//
// 一个沙盒一个计时器。让同一份计时器同时驱动两个沙盒，会在切换沙盒时留下一个
// 看不见的旧循环继续烧模型额度。

interface Stepper {
  running: boolean
  inFlight: boolean
  intervalMs: number
  timer: NodeJS.Timeout | null
  error?: string
  lastTick: number
  lastRunAt: number
  ticks: number
}

const steppers = new Map<string, Stepper>()

function stepperKey(workspace: string | undefined, sandboxId: string): string {
  return `${(workspace ?? '').trim()}#${sandboxId}`
}

function stopStepper(key: string): void {
  const found = steppers.get(key)
  if (found === undefined) return
  if (found.timer !== null) clearInterval(found.timer)
  found.timer = null
  found.running = false
  found.inFlight = false
}

function stopAllSteppers(): void {
  for (const key of [...steppers.keys()]) stopStepper(key)
}

export interface ParanimRoutes {
  routes: PluginWebRoute[]
  /** 手动步进：直接在宿主里跑一步（UI 的「手动步进」按钮与模型工具共用）。 */
  step: (args: ParanimStepArgs) => Promise<StepResultView>
  /** 读取沙盒与运行态（工具与路由共用，避免两套解析口径）。 */
  world: (args: { workspace?: string; sandboxId?: string; create?: boolean }) => Promise<WorldView>
  /** 把运行态落盘（工具改了智能体/指令后必须调用，否则刷新页面就丢了）。 */
  persistRun: (args: { workspace?: string; sandboxId?: string }) => Promise<void>
  /** 重置推演：保留沙盒设定，回到开局那一天（可选只带 N 个智能体）。 */
  resetRun: (args: { workspace?: string; sandboxId?: string; count?: number }) => Promise<WorldView>
  /** 模型调用自检：逐 chunk 明细（诊断"空文本"这类无法从报错看出的失败）。 */
  llmProbe: (args: { provider?: string; model?: string; reasoningEffort?: string; system?: string; user?: string }) => Promise<{ ok: boolean; text: string }>
  /** 注入 /api 网关的信任域（由 index.ts 在挂载时调用）。 */
  setTrustedHosts: (hosts: readonly string[]) => void
  dispose: () => void
}

export interface ParanimStepArgs {
  workspace?: string
  sandboxId?: string
  /** 本步步完后是否落盘（默认 true）。 */
  persist?: boolean
  /** 每步驱动上限（不传用步进设置）。 */
  maxAgents?: number
}

export interface StepResultView extends TickResult {
  /** 落盘后运行态的整体快照（含新位置与新记忆），界面直接换掉即可。 */
  world: WorldView
}

export interface WorldView {
  sandbox: Sandbox
  run: import('../shared/model.ts').RunState
  step: StepConfig
  agentCount: number
  /** 自动步进的实时状态（不是持久化配置，属于运行期事实）。 */
  stepper: { running: boolean; inFlight: boolean; intervalMs: number; lastTick: number; lastRunAt: number; error?: string; ticks: number }
}

export function makeRoutes(deps: RouteDeps): ParanimRoutes {
  const trustedHosts: string[] = []
  let trustedHostsReady = false

  /** 注入 /api 网关的信任域（由 index.ts 在挂载时调用）。 */
  const setTrustedHosts = (hosts: readonly string[]): void => {
    trustedHosts.length = 0
    trustedHosts.push(...hosts)
    trustedHostsReady = true
  }

  const guard = (req: IncomingMessage): void => {
    // 信任域拿不到时**不**拒绝请求：那说明 webRuntime 这个可选服务的形状变了，
    // 此时把整条链路打死会让界面彻底不可用。围栏退化为"仅 Host 头检查"，
    // 并在日志里如实说明，而不是假装它仍然生效。
    if (!trustedHostsReady) {
      log('webRuntime.trustedHosts 未取到——信任围栏退化为回环 Host 检查（跨站防护仍生效，配置域不生效）')
    }
    if (!isTrustedApiRequest(req, trustedHosts)) throw new HttpError('请求未通过浏览器信任围栏', 403)
  }

  const world = async (args: { workspace?: string; sandboxId?: string; create?: boolean }): Promise<WorldView> => {
    const sandboxes = await deps.store.list()
    if (sandboxes.length === 0) throw new HttpError('沙盒库是空的（连出厂镜像都没读到）', 500)
    // 没给 sandboxId 时的兜底顺序：**上次选的那个** → 列表第一个。
    // 只用 `sandboxes[0]` 是不行的：那是按名字排序的第一个（"house" 恰好排在
    // "smallville" 前面），任何漏带 sandboxId 的请求都会被悄悄拽回它。
    const stepStoreForPick = deps.stepOf(args.workspace)
    const stepCfg = await stepStoreForPick.load()
    const remembered = typeof stepCfg.sandboxId === 'string' && stepCfg.sandboxId !== '' ? stepCfg.sandboxId : undefined
    const wanted = args.sandboxId === undefined || args.sandboxId === '' ? remembered : args.sandboxId
    const sandbox = wanted === undefined
      ? sandboxes[0]
      : sandboxes.find((s) => s.id === wanted)
    if (sandbox === undefined) throw new HttpError(`找不到沙盒 ${String(wanted)}`, 404)
    const runStore = deps.runOf(args.workspace)
    let run = await runStore.load(sandbox.id)
    if (run === undefined) {
      if (args.create === false) throw new HttpError(`沙盒 ${sandbox.id} 还没有运行态`, 404)
      run = deps.store.newRun(sandbox)
      await runStore.save(run)
    }
    // 沙盒被改过（比如玩家加了新地标）时，运行态里的坐标要跟着收敛到图内。
    const stepStore = deps.stepOf(args.workspace)
    await stepStore.load()
    const key = stepperKey(args.workspace, sandbox.id)
    const live = steppers.get(key)
    return {
      sandbox,
      run,
      step: stepStore.get(),
      agentCount: run.agents.length,
      stepper: {
        running: live?.running ?? false,
        inFlight: live?.inFlight ?? false,
        intervalMs: live?.intervalMs ?? stepStore.get().intervalMs,
        lastTick: live?.lastTick ?? run.tick,
        lastRunAt: live?.lastRunAt ?? 0,
        error: live?.error,
        ticks: live?.ticks ?? 0,
      },
    }
  }

  /** 切换/载入沙盒：把这个选择记进本工作区的 step 配置，后续漏带 sandboxId 的请求才有据可依。 */
  const rememberSandbox = async (workspace: string | undefined, id: string): Promise<void> => {
    const stepStore = deps.stepOf(workspace)
    await stepStore.load()
    await stepStore.set({ sandboxId: id })
  }

  const step = async (args: ParanimStepArgs): Promise<StepResultView> => {
    const view = await world({ workspace: args.workspace, sandboxId: args.sandboxId, create: true })
    const result = await runTick({
      sandbox: view.sandbox,
      run: view.run,
      timeoutMs: view.step.callTimeoutMs,
      maxAgentsPerTick: args.maxAgents ?? view.step.maxAgentsPerTick,
      callModel: makeCaller(deps.llm()),
      defaultRoute: deps.defaultRoute(),
    })
    if (args.persist !== false) {
      await deps.runOf(args.workspace).save(view.run)
      // 这一步可能改过某个物件的状态（智能体动了灯），沙盒一起落盘，
      // 否则刷新页面后"灯还亮着"，而事件流里写着它坏了。
      // 状态现在挂在 object 层的 states 上，没有"最后改动时间"可比，索性总是存。
      await deps.store.save(view.sandbox)
    }
    return { ...result, world: await world({ workspace: args.workspace, sandboxId: args.sandboxId, create: true }) }
  }

  /** 从 llm 服务造一个调用器；llm 缺失时返回一个总是抛错的实现，让引擎走兜底。 */
  const makeCaller = (llm: PluginLlm | undefined) => {
    return async (agent: { id: string; name: string }, call: LlmCall, signal: AbortSignal): Promise<string> => {
      if (llm === undefined) throw new Error('宿主 llm 服务不可用')
      void agent
      const attempt = await callModelOnce(llm, call, signal)
      if (attempt.text.trim() !== '') return attempt.text

      // 空文本不是"模型没话说"，是**调用没成**。这里不立刻降级：先摘掉
      // reasoningEffort 重试一次——一个模型若只被声明了 reasoningEfforts
      // 而调用时又没给出，适配器可能整个请求都被上游拒掉。重试仍空才降级，
      // 并把现场（chunk 构成 / 结束原因 / 耗时）写进错误信息，而不是只说
      // "返回空文本"让后来的人无从下手。
      if (call.route.reasoningEffort !== undefined && call.route.reasoningEffort !== '') {
        const retry = await callModelOnce(llm, call, signal, { dropReasoningEffort: true })
        if (retry.text.trim() !== '') return retry.text
        throw new Error(`模型 ${call.route.provider}/${call.route.model} 两次调用都没有文本（首次 ${attempt.detail}；摘掉 reasoningEffort 后 ${retry.detail}）`)
      }
      // 把"为什么没有文本"直接说清：推理模型常见的是"预算被推理吃光"，而不是模型拒答。
      const hint = /空闲超过/.test(attempt.detail)
        ? '（空闲超时：模型在推理途中长时间没有新产出，可调大 step.callTimeoutMs）'
        : /finish=length/.test(attempt.detail)
          ? '（预算被推理占满：maxTokens 不够，调大或换非推理模型）'
          : /reasoning-delta/.test(attempt.detail)
            ? '（有推理却无正文：多为推理未结束就断了，先看耗时与 finish 原因）'
            : ''
      throw new Error(`模型 ${call.route.provider}/${call.route.model} 没有返回文本${hint}（${attempt.detail}）`)
    }
  }

  /** 一次模型调用：拼文本，并把"这次调用长什么样"记成可读的 detail。 */
  const callModelOnce = async (
    llm: PluginLlm,
    call: LlmCall,
    signal: AbortSignal,
    options?: {
      dropReasoningEffort?: boolean
      provider?: string
      model?: string
      temperature?: number
      system?: string
      user?: string
      /** 覆盖 messages（探针用来对比"system 单独给"与"折进 messages"两种形状）。 */
      messages?: LlmMessage[]
      /** 完全不传 temperature（探针用：某些兼容层对 temperature 敏感）。 */
      noTemperature?: boolean
      /** 覆盖 maxTokens（探针用：确认"预算被推理吃光"）。 */
      maxTokens?: number
      /** 覆盖空闲上限（毫秒）。默认 90s：推理模型的连续产出间隔远小于它。 */
      idleMs?: number
    },
  ): Promise<{ text: string; detail: string }> => {
    const started = Date.now()
    let text = ''
    const kinds = new Map<string, number>()
    let finish = ''
    let usage = ''
    /**
     * **空闲**计时器，而不是总时长计时器。
     *
     * 推理模型很慢但不卡：实测 workbuddy/cn:hy4-preview-f 在长提示词下推理 1014 个块、
     * 输出 3319 个 token、耗时 81.8 秒才吐出正文。用"总时长 60 秒"卡它，得到的不是
     * 超时错误而是"模型没有返回文本"，界面上表现为整轮降级——而模型其实一切正常。
     * 所以判据改成"多久没有新东西"：只要还在产出就不打断，真正卡死才中止。
     */
    const idleMs = Math.max(5000, options?.idleMs ?? 90000)
    const idle = new AbortController()
    let timer = setTimeout(() => idle.abort(new Error(`空闲超过 ${Math.round(idleMs / 1000)}s`)), idleMs)
    const bump = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => idle.abort(new Error(`空闲超过 ${Math.round(idleMs / 1000)}s`)), idleMs)
    }
    const outer = signal
    const onOuterAbort = (): void => idle.abort(outer.reason)
    outer.addEventListener('abort', onOuterAbort, { once: true })
    const streamSignal = AbortSignal.any([idle.signal, outer])
    try {
    for await (const chunk of llm.stream({
      provider: options?.provider ?? call.route.provider,
      model: options?.model ?? call.route.model,
      reasoningEffort: options?.dropReasoningEffort === true ? undefined : call.route.reasoningEffort,
      system: options?.system ?? call.system,
      messages: options?.messages ?? [messageOf('user', options?.user ?? call.user)],
      // 「不传」而不是「传 0」：省缺与显式 0 在适配器里是两条路。
      temperature: options?.noTemperature === true ? undefined : (options?.temperature ?? 0.9),
      // 推理模型（如 workbuddy/cn:hy4-preview-f）会把预算先花在 reasoning 上，
      // 推理没结束就一个字正文都不会吐。1200 对这个世界的提示词（身份+记忆+周围环境）
      // 远远不够：实测 20–45 秒后 finish，chunk 里只有 reasoning-delta、没有 text-delta。
      // 智能体的输出本身很短（一个 JSON 动作），所以预算放大是安全的。
      maxTokens: options?.maxTokens ?? 8192,
      signal: streamSignal,
    })) {
      bump()
      kinds.set(chunk.type, (kinds.get(chunk.type) ?? 0) + 1)
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') text = text
      else if (chunk.type === 'usage') usage = JSON.stringify(chunk.usage)
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    const shape = [...kinds.entries()].map(([kind, count]) => `${kind}×${count}`).join(' ')
    const detail = `耗时 ${Date.now() - started}ms｜chunk: ${shape === '' ? '（一个都没有）' : shape}｜finish=${finish === '' ? '（无）' : finish}${usage === '' ? '' : `｜usage=${usage}`}`
    return { text, detail }
    } finally {
      clearTimeout(timer)
      outer.removeEventListener('abort', onOuterAbort)
    }
  }

  /**
   * 模型调用自检：拿真实的 provider/model 走一次完整调用，返回逐 chunk 明细。
   * 存在的理由是"空文本"这类失败**无法从错误信息里诊断**——必须看到 chunk
   * 构成与结束原因，才能判断是上游拒绝、适配器没吐文本，还是路由根本没生效。
   */
  const llmProbe = async (args: { provider?: string; model?: string; reasoningEffort?: string; system?: string; user?: string; maxTokens?: number; quiet?: boolean }) => {
    const llm = deps.llm()
    if (llm === undefined) return { ok: false, text: 'ctx.get("llm") 为 undefined（宿主未挂 llm 服务）' }
    const route = deps.defaultRoute()
    const provider = args.provider ?? route?.provider ?? ''
    const model = args.model ?? route?.model ?? ''
    if (provider === '' || model === '') return { ok: false, text: '没有可用的 provider/model（既未传入，宿主也没有默认模型）' }
    const lines: string[] = [
      `provider=${provider} model=${model} reasoningEffort=${args.reasoningEffort ?? route?.reasoningEffort ?? '（无）'}`,
      `宿主默认路由：${route === undefined ? '（无）' : `${route.provider}/${route.model}${route.reasoningEffort === undefined ? '' : ` @${route.reasoningEffort}`}`}`,
      `llm.listProviders()：${llm.listProviders().map((p) => `${p.id}(${p.name})`).join(', ')}`,
    ]
    const call: LlmCall = {
      route: { provider, model, reasoningEffort: args.reasoningEffort ?? route?.reasoningEffort },
      system: args.system ?? '你是一个小镇居民。只回答两个字：收到',
      user: args.user ?? '现在几点了？',
    }
    const controller = new AbortController()
    const budget = args.maxTokens ?? 8192
    lines.push(`maxTokens=${budget}  system=${call.system.length} 字`)
    if (args.quiet === true) {
      lines.push(await oneProbe(llm, call, controller.signal, { maxTokens: budget }))
      return { ok: true, text: lines.join('\n') }
    }
    lines.push('')
    lines.push('【A】system= 单独给、messages 只有 user（插件当前的调用形状）')
    lines.push(await oneProbe(llm, call, controller.signal, { maxTokens: budget }))
    lines.push('')
    lines.push('【B】system 折进 messages[0]（role=system），messages 走 user（agent-loop 的形状）')
    lines.push(
      await oneProbe(llm, call, controller.signal, {
        messages: [messageOf('system', call.system), messageOf('user', call.user)],
      }),
    )
    lines.push('')
    lines.push('【C】最小调用：不传 system、不传 reasoningEffort、temperature 省略')
    lines.push(
      await oneProbe(llm, call, controller.signal, {
        dropReasoningEffort: true,
        messages: [messageOf('user', '只回答两个字：收到')],
        noTemperature: true,
        maxTokens: budget,
      }),
    )
    return { ok: true, text: lines.join('\n') }
  }

  /** 跑一种调用形状，把结果压成几行（异常也在内部收口）。 */
  const oneProbe = async (
    llm: PluginLlm,
    call: LlmCall,
    signal: AbortSignal,
    variant?: {
      messages?: LlmMessage[]
      dropReasoningEffort?: boolean
      noTemperature?: boolean
      maxTokens?: number
    },
  ): Promise<string> => {
    try {
      const attempt = await callModelOnce(llm, call, signal, {
        dropReasoningEffort: variant?.dropReasoningEffort,
        messages: variant?.messages,
        noTemperature: variant?.noTemperature,
        maxTokens: variant?.maxTokens,
      })
      const rows = [`  ${attempt.detail}`, `  文本=${JSON.stringify(attempt.text.slice(0, 160))}`]
      if (attempt.text.trim() === '') {
        const retry = await callModelOnce(llm, call, signal, {
          dropReasoningEffort: true,
          messages: variant?.messages,
          noTemperature: variant?.noTemperature,
          maxTokens: variant?.maxTokens,
        })
        rows.push(`  摘掉 reasoningEffort 重试：${retry.detail}`)
        rows.push(`    文本=${JSON.stringify(retry.text.slice(0, 160))}`)
      }
      return rows.join('\n')
    } catch (error) {
      const rows = [`  抛异常：${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`]
      if (error instanceof Error && error.stack !== undefined) {
        rows.push(`  stack: ${error.stack.split('\n').slice(0, 6).join(' | ')}`)
      }
      return rows.join('\n')
    }
  }

  const startStepper = (workspace: string | undefined, sandboxId: string, intervalMs: number): Stepper => {
    const key = stepperKey(workspace, sandboxId)
    stopStepper(key)
    const state: Stepper = steppers.get(key) ?? { running: false, inFlight: false, intervalMs, timer: null, lastTick: 0, lastRunAt: 0, ticks: 0 }
    state.intervalMs = intervalMs
    state.running = true
    state.inFlight = false
    state.error = undefined
    state.timer = setInterval(() => {
      const live = steppers.get(key)
      if (live === undefined || !live.running || live.inFlight) return
      live.inFlight = true
      step({ workspace, sandboxId, persist: true })
        .then((result) => {
          const now = steppers.get(key)
          if (now === undefined) return
          now.lastTick = result.tick
          now.lastRunAt = Date.now()
          now.ticks += 1
          now.error = undefined
        })
        .catch((error) => {
          const now = steppers.get(key)
          if (now !== undefined) now.error = error instanceof Error ? error.message : String(error)
          log('auto step failed:', String(error))
        })
        .finally(() => {
          const now = steppers.get(key)
          if (now !== undefined) now.inFlight = false
        })
    }, intervalMs)
    // 计时器不该钉住进程：宿主退出时必须放行。
    state.timer.unref?.()
    steppers.set(key, state)
    return state
  }

  // ── 路由表 ─────────────────────────────────────────────────────────────

  /**
   * 落盘一次改动：沙盒 + 事件流。
   *
   * 两件事必须一起做，缺第二件就是静默丢数据——只 save 沙盒的话，刚记下的
   * mutate 事件在下一次重启后就消失了，而"谁动了这个世界"这条线索正是事件流
   * 存在的意义。此前这两行在各路由里重复 9 次、顺序还不统一（有的先存 run 后
   * 存 sandbox），漏掉一行的代价很高，所以合成一个动词。
   */
  const commit = async (view: { sandbox: Sandbox; run: RunState }, workspace: string): Promise<Sandbox> => {
    const saved = await deps.store.save(view.sandbox)
    await deps.runOf(workspace).save(view.run)
    return saved
  }

  /** 落盘并回一份最新的世界视图给前端。 */
  const sendWorld = async (
    res: ServerResponse,
    view: { sandbox: Sandbox; run: RunState },
    workspace: string,
    sandboxId?: string,
  ): Promise<void> => {
    await commit(view, workspace)
    send(res, 200, { ok: true, data: await world({ workspace, sandboxId: sandboxId ?? view.sandbox.id, create: true }) })
  }

/** 每个工作区一条写队列，见 handler 里的 serialize。 */
/**
 * 改地图尺寸：三个图层一起重排。
 *
 * cells 是行优先的一维数组，长度必须正好是 宽×高。只改 width/height 会让
 * 整个图层错位（第 N 格落到别的坐标上），而且不报错——画面上就是"地图花了"。
 * 这里按左上角对齐重排：保留老图里还在范围内的格，越界的丢掉，新扩的补空。
 */
function resizeMap(map: SandboxMap, width: number, height: number): SandboxMap {
  const remap = (layer: TileLayer): TileLayer => {
    const cells: Array<string | null> = new Array(width * height).fill(null)
    for (let y = 0; y < Math.min(height, map.height); y += 1) {
      for (let x = 0; x < Math.min(width, map.width); x += 1) {
        cells[y * width + x] = layer.cells[y * map.width + x] ?? null
      }
    }
    const out: TileLayer = { cells }
    if (layer.states !== undefined) {
      const states: Record<string, Record<string, StateValue>> = {}
      for (const [key, value] of Object.entries(layer.states)) {
        const idx = Number(key)
        if (!Number.isInteger(idx)) continue
        const x = idx % map.width
        const y = Math.floor(idx / map.width)
        if (x < width && y < height) states[String(y * width + x)] = value
      }
      if (Object.keys(states).length > 0) out.states = states
    }
    return out
  }
  return {
    ...map,
    width,
    height,
    layers: {
      background: remap(map.layers.background),
      structure: remap(map.layers.structure),
      object: remap(map.layers.object),
    },
  }
}

const writeQueues = new Map<string, Promise<unknown>>()

  const routes: PluginWebRoute[] = [
    {
      kind: 'prefix',
      path: '/paranim',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.replace(/^\/paranim/, '') || '/'
        const method = (req.method ?? 'GET').toUpperCase()
        const workspace = deps.workspaceOf(req)
        const sandboxId = url.searchParams.get('sandboxId') ?? undefined

        try {
          guard(req)
          const body = method === 'POST' ? await readBody(req) : {}
          /**
           * 路由表：`方法 路径` → 处理函数。
           *
           * 此前这里是十五个并列 if + 末尾一句无条件 throw：某个分支只要漏了 `return`，
           * 已经成功响应的请求就会继续往下掉，最终报成"未知路由"——看着像路由没注册，
           * 实际是分支没退出。改成查表之后每个处理函数各自结束，"未知路由"只在真的没注册时出现。
           *
           * 表定义在 handler 体内，所以每个处理函数都能闭包拿到 res / body / workspace ——
           * 不需要定义上下文类型再层层传参，搬动时函数体可以原样保留。
           */
          /**
           * 把同一 key 上的任务排成队列，前一个结束（无论成败）才跑下一个。
           *
           * `prev.then(job, job)` 两个分支都传 job：前一个任务抛错时队列必须继续，
           * 否则一次失败会把后面所有请求永久卡死。
           */
          function serialize<T>(key: string, job: () => Promise<T>): Promise<T> {
            const prev = writeQueues.get(key) ?? Promise.resolve()
            const run = prev.then(job, job)
            writeQueues.set(key, run.then(() => undefined, () => undefined))
            return run
          }

          /**
           * 记一条"玩家动了世界"的事件。
           *
           * 改动必须留下线索：只落盘不写事件的话，复盘时"这一步地图怎么变的"
           * 就断了，而这正是事件流存在的意义。
           */
          const logMutate = (view: { run: RunState }, text: string, by: string, targetId?: string): void => {
            view.run.events.push({
              id: shortId('ev'), tick: view.run.tick, ts: Date.now(), kind: 'mutate',
              actor: 'gm', actorName: by, text, targetId,
            })
          }

          const routeTable: Record<string, () => Promise<void>> = {
            // GET /paranim/world —— 沙盒 + 运行态 + 步进设置
            'GET /world': async () => {
              const view = await world({ workspace, sandboxId, create: url.searchParams.get('create') !== 'false' })
              return send(res, 200, { ok: true, data: view })
            },

            // GET /paranim/sandboxes —— 沙盒库
            'GET /sandboxes': async () => {
              const list = await deps.store.list(true)
              const current = (await world({ workspace, sandboxId, create: true })).sandbox.id
              return send(res, 200, {
                ok: true,
                data: {
                  currentId: current,
                  sandboxes: list.map((s) => ({
                    id: s.id,
                    name: s.name,
                    desc: s.desc,
                    builtin: s.builtin === true,
                    attribution: s.attribution,
                    license: s.license,
                    updatedAt: s.updatedAt,
                    places: s.places.length,
                    objects: objectsOf(s.map).length,
                    agents: s.agents.length,
                  })),
                },
              })
            },

            // GET /paranim/models —— 可用模型（provider × model）
            'GET /models': async () => {
              const choices = await listModelChoices(deps.llm(), deps.defaultRoute())
              return send(res, 200, { ok: true, data: choices })
            },

            // POST /paranim/sandbox —— 保存/另存/切换沙盒
            'POST /sandbox': async () => {
              const action = String(body.action ?? 'save')
              /**
               * 改沙盒的元信息：名字、描述、地图尺寸。
               *
               * 尺寸改动要把三个图层一起重排——cells 是行优先的一维数组，
               * 长度必须等于 宽×高，只改 width/height 会让整个图层错位。
               * 重排规则：保留左上角，越界的丢掉，新扩出来的补空。
               * 挂在格子上的状态（states）也要跟着换算格索引。
               */
              if (action === 'meta') {
                const view = await world({ workspace, sandboxId, create: true })
                const by = typeof body.by === 'string' && body.by.trim() !== '' ? body.by.trim() : '玩家'
                if (typeof body.name === 'string' && body.name.trim() !== '') view.sandbox.name = body.name.trim().slice(0, 60)
                if (typeof body.desc === 'string') view.sandbox.desc = body.desc.slice(0, 400)
                if (typeof body.attribution === 'string') view.sandbox.attribution = body.attribution.slice(0, 300)
                const W = body.width === undefined ? view.sandbox.map.width : Math.max(8, Math.min(400, Math.round(Number(body.width))))
                const H = body.height === undefined ? view.sandbox.map.height : Math.max(8, Math.min(400, Math.round(Number(body.height))))
                const changed: string[] = []
                if (W !== view.sandbox.map.width || H !== view.sandbox.map.height) {
                  changed.push(`尺寸 ${view.sandbox.map.width}×${view.sandbox.map.height} → ${W}×${H}`)
                  view.sandbox.map = resizeMap(view.sandbox.map, W, H)
                }
                view.sandbox.updatedAt = Date.now()
                logMutate(view, changed.length > 0
                  ? `${by}把「${view.sandbox.name}」改成 ${changed.join('，')}。`
                  : `${by}改了「${view.sandbox.name}」的名称或描述。`, by)
                await sendWorld(res, view, workspace)
                return
              }
              if (action === 'select') {
                const id = String(body.id ?? '')
                const target = await deps.store.get(id)
                if (target === undefined) throw new HttpError(`找不到沙盒 ${id}`, 404)
                await rememberSandbox(workspace, id)
                const view = await world({ workspace, sandboxId: id, create: true })
                return send(res, 200, { ok: true, data: view })
              }
              if (action === 'create') {
                const name = String(body.name ?? '新沙盒')
                const id = String(body.id ?? '').trim() === '' ? slugify(name) : String(body.id)
                const blank = normalizeSandbox({
                  id,
                  name,
                  desc: String(body.desc ?? '空沙盒：自己摆一座镇。'),
                  map: { width: 120, height: 90, tilesets: [], layers: emptyLayers(120, 90) },
                  places: [],
                  agents: [],
                  relations: [],
                }, id)
                await deps.store.save(blank)
                return send(res, 200, { ok: true, data: await world({ workspace, sandboxId: blank.id, create: true }) })
              }
              if (action === 'duplicate') {
                const from = String(body.id ?? '')
                const copy = await deps.store.duplicate(from, String(body.newId ?? `${from}-copy`), typeof body.name === 'string' ? body.name : undefined)
                return send(res, 200, { ok: true, data: await world({ workspace, sandboxId: copy.id, create: true }) })
              }
              if (action === 'remove') {
                const id = String(body.id ?? '')
                await deps.store.remove(id)
                /**
                 * 删掉的若正是"上次选中的那个"，选择要一并清掉。
                 *
                 * 否则这台工作区里所有**不带 sandboxId** 的请求都会先去找它，
                 * 而它已经不在了——world() 抛"找不到沙盒"，前端拿到 500，
                 * 表现就是"点删除没反应"（其实文件已经删了，是回退那一步炸的）。
                 */
                const stepStore = deps.stepOf(workspace)
                const cfg = await stepStore.load()
                if (cfg.sandboxId === id) {
                  // 用**显式 undefined** 覆盖，而不是 delete 掉键再 set：
                  // StepStore.set 是合并语义（{...旧, ...patch}），少一个键
                  // 就等于"保持原值"——删键再 set 什么也没发生（实测踩过）。
                  await stepStore.set({ sandboxId: undefined })
                }
                // 它要是正在自动步进，也一并停掉——不然计时器会一直对着一个
                // 不存在的沙盒继续跑（每次都失败，日志越滚越多）。
                stopStepper(stepperKey(workspace, id))
                return send(res, 200, { ok: true, data: await world({ workspace, create: true }) })
              }
              if (action === 'reset') {
                // 重置回出厂镜像：删掉当前沙盒，把镜像重新种回去。
                const id = String(body.id ?? 'smallville')
                const mirror = await deps.store.mirrorSandbox()
                if (id !== 'smallville') throw new HttpError('只有出厂镜像 smallville 支持重置', 400)
                await deps.store.save({ ...mirror, builtin: true, updatedAt: Date.now() })
                await deps.runOf(workspace).remove(id)
                return send(res, 200, { ok: true, data: await world({ workspace, sandboxId: id, create: true }) })
              }
              // 默认：保存当前沙盒（可带 fromRun 把运行态折回沙盒）
              const saveBody = body as SandboxSaveBody
              const current = await world({ workspace, sandboxId: saveBody.id ?? sandboxId, create: false })
              let next: Sandbox = {
                ...current.sandbox,
                name: typeof saveBody.name === 'string' && saveBody.name.trim() !== '' ? saveBody.name.trim() : current.sandbox.name,
                desc: typeof saveBody.desc === 'string' ? saveBody.desc : current.sandbox.desc,
              }
              if (saveBody.fromRun === true) {
                next = { ...next, agents: current.run.agents.map(stripRunFields) }
              }
              const saved = await deps.store.save(next)
              return send(res, 200, { ok: true, data: await world({ workspace, sandboxId: saved.id, create: true }) })
            },

            /**
             * POST /paranim/tileset —— 图集本身的操作：注释、导入、切片参数、删除。
             *
             * 为什么单独一条路由：注释与切片参数属于**图集**而不属于地图，
             * 而它们原先走的是 `/sandbox {action:'save'}`——那条路在服务端
             * 读的是**服务端自己那份沙盒**，客户端改完再 save 等于什么都没提交。
             * （实测：标注完瓦片，刷新就没了。）所以必须有一条真正写服务端的入口。
             */
            'POST /tileset': async () => {
              const view = await world({ workspace, sandboxId, create: true })
              const by = typeof body.by === 'string' && body.by.trim() !== '' ? body.by.trim() : '玩家'
              const op = String(body.op ?? '')
              const tilesets = view.sandbox.map.tilesets
              const setId = String(body.tilesetId ?? '')

              if (op === 'add') {
                // 导入一张素材图：body.tileset 带着 data URI 与切片参数
                const t = normalizeTileset(body.tileset, `set-${tilesets.length + 1}`)
                if (t === undefined) throw new HttpError('图集参数不合法', 400)
                if (t.image === '') throw new HttpError('导入的图集必须带图片数据', 400)
                const id = tilesets.some((x) => x.id === t.id) ? `${t.id}-${randomToken(4)}` : t.id
                tilesets.push({ ...t, id })
                view.sandbox.updatedAt = Date.now()
                logMutate(view, `${by}导入了素材图「${t.name}」（${t.imageW}×${t.imageH}，切 ${t.tileW}×${t.tileH}）。`, by)
                await sendWorld(res, view, workspace)
                return
              }

              const ts = tilesets.find((t) => t.id === setId)
              if (ts === undefined) throw new HttpError(`找不到图集 ${setId}`, 404)

              if (op === 'note') {
                const key = String(body.key ?? '')
                if (!/^\d{1,3},\d{1,3}$/.test(key)) throw new HttpError('格子写成「列,行」', 400)
                const raw = (body.note ?? {}) as Record<string, unknown>
                const note: TileNote = {}
                if (typeof raw.name === 'string' && raw.name.trim() !== '') note.name = raw.name.trim().slice(0, 40)
                if (raw.pass === 'walk' || raw.pass === 'block' || raw.pass === 'water' || raw.pass === 'lava') note.pass = raw.pass
                if (raw.use === 'door' || raw.use === 'window' || raw.use === 'switch') note.use = raw.use
                if (typeof raw.desc === 'string' && raw.desc.trim() !== '') note.desc = raw.desc.trim().slice(0, 200)
                if (Array.isArray(raw.states)) {
                  const list = raw.states.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => String(v).trim().slice(0, 16)).slice(0, 12)
                  if (list.length > 0) note.states = list
                }
                if (Object.keys(note).length === 0) delete ts.notes[key]
                else ts.notes[key] = note
                view.sandbox.updatedAt = Date.now()
                logMutate(view, Object.keys(note).length === 0
                  ? `${by}清掉了「${ts.name} ${key}」的注释。`
                  : `${by}把「${ts.name} ${key}」标注为「${note.name ?? '（无名）'}」${note.pass === 'block' ? '（挡路）' : ''}${note.use === 'door' ? '（门）' : ''}。`, by)
              } else if (op === 'slice') {
                const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
                  const n = Math.round(Number(v))
                  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dflt
                }
                ts.tileW = clamp(body.tileW, 2, 256, ts.tileW)
                ts.tileH = clamp(body.tileH, 2, 256, ts.tileH)
                ts.margin = clamp(body.margin, 0, 64, ts.margin)
                ts.spacing = clamp(body.spacing, 0, 64, ts.spacing)
                view.sandbox.updatedAt = Date.now()
                logMutate(view, `${by}把「${ts.name}」的切片改成 ${ts.tileW}×${ts.tileH}（间隙 ${ts.spacing}）。`, by)
              } else if (op === 'remove') {
                const at = tilesets.findIndex((t) => t.id === setId)
                const [gone] = tilesets.splice(at, 1)
                view.sandbox.updatedAt = Date.now()
                logMutate(view, `${by}移除了素材图「${gone.name}」。`, by)
              } else {
                throw new HttpError(`未知操作 ${op}`, 400)
              }
              await sendWorld(res, view, workspace)
              return
            },

            /**
             * POST /paranim/paint —— 在某一层的一格上放/清一个瓦片。
             *
             * 编辑器**只有一个写入口**。"一格一个瓦片"这条约定在这里强制，
             * 前端怎么画都破坏不了它——而通行性判定（rules.canEnter）依赖
             * "每格只有一个答案"才成立。
             *
             * 一次可以带一串格子（拖动涂抹会连点），所以入参是 cells 数组。
             */
            'POST /paint': async () => {
              const view = await world({ workspace, sandboxId, create: true })
              const by = typeof body.by === 'string' && body.by.trim() !== '' ? body.by.trim() : '玩家'
              const layerName = String(body.layer ?? '')
              if (layerName !== 'background' && layerName !== 'structure' && layerName !== 'object') {
                throw new HttpError(`未知图层 ${layerName}`, 400)
              }
              const layer = view.sandbox.map.layers[layerName]
              const W = view.sandbox.map.width
              const H = view.sandbox.map.height
              // null / 空串 = 橡皮
              const ref = body.ref === null || body.ref === undefined || body.ref === '' ? null : String(body.ref)
              if (ref !== null) {
                const parsed = parseRef(ref)
                if (parsed === undefined) throw new HttpError(`瓦片引用格式无效：${ref}`, 400)
                /**
                 * 画上去的瓦片，它的图集必须跟着进沙盒——渲染时要从沙盒自己的
                 * tilesets 里找像素。直接拒掉的话，"换了一支笔就画不上"会很
                 * 莫名其妙；自动登记的话，笔从哪来图集就从哪来。
                 * 内置图集只存 id（像素在客户端包里），不重复内嵌。
                 */
                if (!view.sandbox.map.tilesets.some((t) => t.id === parsed.setId)) {
                  view.sandbox.map.tilesets.push(makeBuiltinTileset(parsed.setId))
                }
              }
              const list = Array.isArray(body.cells) ? body.cells.slice(0, 4096) : []
              let painted = 0
              for (const cell of list) {
                const c = (cell ?? {}) as Record<string, unknown>
                const x = Math.round(Number(c.x))
                const y = Math.round(Number(c.y))
                if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= W || y >= H) continue
                const idx = y * W + x
                if (layer.cells[idx] === ref) continue
                layer.cells[idx] = ref
                // 清空时连状态一起丢掉：格上没东西了，状态就没有宿主
                if (ref === null && layer.states !== undefined) delete layer.states[String(idx)]
                painted += 1
              }
              if (painted > 0) {
                view.sandbox.updatedAt = Date.now()
                logMutate(view, `${by}在「${LAYER_LABEL[layerName]}」上画了 ${painted} 格${ref === null ? '（擦除）' : ''}。`, by)
                await sendWorld(res, view, workspace)
                return
              }
              await sendWorld(res, view, workspace)
              return
            },

            /**
             * POST /paranim/place —— 命名地标的增删改。
             *
             * 地标是**逻辑概念**（"咖啡馆在哪儿"），不是地图上的东西——地图由三个
             * 瓦片图层表达，包括建筑。所以这里只动名字与范围，不碰任何图层。
             */
            'POST /place': async () => {
              const view = await world({ workspace, sandboxId, create: true })
              const op = String(body.op ?? 'patch')
              const by = typeof body.by === 'string' && body.by.trim() !== '' ? body.by.trim() : '玩家'
              const W = view.sandbox.map.width
              const H = view.sandbox.map.height
              const placeId = String(body.placeId ?? body.id ?? '')
              const index = view.sandbox.places.findIndex((p) => p.id === placeId)

              if (op === 'add') {
                const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim().slice(0, 24) : '新地标'
                const place: WorldObject = {
                  id: `place-${randomToken(6)}`,
                  name,
                  kind: 'place',
                  x: Math.max(0, Math.min(W - 1, Math.round(Number(body.x ?? W / 2)))),
                  y: Math.max(0, Math.min(H - 1, Math.round(Number(body.y ?? H / 2)))),
                  w: Math.max(1, Math.min(W, Math.round(Number(body.w ?? 12)))),
                  h: Math.max(1, Math.min(H, Math.round(Number(body.h ?? 10)))),
                  color: typeof body.color === 'string' ? body.color : '#a8623f',
                  interactive: true,
                  state: { open: true },
                  desc: typeof body.desc === 'string' ? body.desc : '',
                }
                view.sandbox.places.push(place)
                logMutate(view, `${by}新建了地标「${place.name}」（@${place.x},${place.y}）。`, by, place.id)
              } else if (index < 0) {
                throw new HttpError(`找不到地标 ${placeId}`, 404)
              } else if (op === 'remove') {
                const [gone] = view.sandbox.places.splice(index, 1)
                logMutate(view, `${by}删掉了地标「${gone.name}」。`, by)
              } else {
                const target = view.sandbox.places[index]
                const before = `${target.name} @${target.x},${target.y}`
                if (typeof body.name === 'string' && body.name.trim() !== '') target.name = body.name.trim().slice(0, 24)
                if (body.x !== undefined) target.x = Math.max(0, Math.min(W - 1, Math.round(Number(body.x))))
                if (body.y !== undefined) target.y = Math.max(0, Math.min(H - 1, Math.round(Number(body.y))))
                if (body.w !== undefined) target.w = Math.max(1, Math.min(W, Math.round(Number(body.w))))
                if (body.h !== undefined) target.h = Math.max(1, Math.min(H, Math.round(Number(body.h))))
                if (typeof body.desc === 'string') target.desc = body.desc.slice(0, 400)
                target.lastEditedBy = by
                target.lastEditedAt = Date.now()
                logMutate(view, `${by}改了地标「${target.name}」：${before} → ${target.name} @${target.x},${target.y}。`, by, target.id)
              }
              view.sandbox.updatedAt = Date.now()
              await sendWorld(res, view, workspace)
              return
            },

            /**
             * POST /paranim/object —— 改一格物件的状态，或改地标。
             *
             * 物件与地标是两种东西，走同一条路由只因为都是"右键改状态"：
             *  · 物件的 id 形如 `obj:x,y`（由格坐标推出），状态挂在 object 层
             *    那一格上（setObjectState），名字/贴图/能不能动都来自图集注释；
             *  · 地标是逻辑概念（WorldObject），可以直接改它的字段。
             */
            'POST /object': async () => {
              const view = await world({ workspace, sandboxId, create: true })
              const objectId = String(body.objectId ?? '')
              const by = typeof body.by === 'string' && body.by.trim() !== '' ? body.by.trim() : '玩家'
              const changes: string[] = []
              const statePatch: Record<string, StateValue | null> = {}

              // 状态统一先收集到 statePatch，物件与地标最后各自落笔
              if (body.state !== null && typeof body.state === 'object' && !Array.isArray(body.state)) {
                for (const [key, rawValue] of Object.entries(body.state as Record<string, unknown>)) {
                  if (key === '' || key.length > 60) continue
                  const value = rawValue === null ? null : toStateValue(rawValue)
                  if (value === undefined) {
                    throw new HttpError(`状态「${key}」的值类型不支持（只接受字符串/数字/布尔/null/短数组）`, 400)
                  }
                  statePatch[key] = value
                }
              }

              let name = ''
              const pos = positionOfObjectId(objectId)
              if (pos !== undefined) {
                // ── 物件：object 层上的一格 ──
                const idx = pos.y * view.sandbox.map.width + pos.x
                const tile = resolveRef(view.sandbox.map, view.sandbox.map.layers.object.cells[idx])
                if (tile === undefined) throw new HttpError(`(${pos.x},${pos.y}) 这一格上没有物件`, 404)
                name = tile.note?.name ?? '物件'
                const before = view.sandbox.map.layers.object.states?.[String(idx)] ?? {}
                for (const [k, v] of Object.entries(statePatch)) {
                  const old = before[k] ?? null
                  if (old === v) continue
                  changes.push(`${k}「${old === null ? '（无）' : String(old)}」→「${v === null ? '（清除）' : String(v)}」`)
                }
                if (changes.length === 0) throw new HttpError('没有任何要改的内容', 400)
                setObjectState(view.sandbox.map, pos.x, pos.y, statePatch)
                view.run.events.push({
                  id: shortId('ev'), tick: view.run.tick, ts: Date.now(), kind: 'mutate',
                  actor: 'gm', actorName: by, text: `${by}把「${name}」的 ${changes.join('，')}。`, targetId: objectId,
                })
              } else {
                // ── 地标：WorldObject ──
                const target = view.sandbox.places.find((p) => p.id === objectId)
                if (target === undefined) throw new HttpError(`找不到物体 ${objectId}`, 404)
                name = target.name
                if (typeof body.name === 'string' && body.name.trim() !== '' && body.name !== target.name) {
                  changes.push(`名称「${target.name}」→「${body.name.trim()}」`)
                  target.name = body.name.trim()
                }
                if (typeof body.desc === 'string') target.desc = body.desc
                if (body.x !== undefined && Number.isFinite(Number(body.x))) target.x = Math.max(0, Math.min(view.sandbox.map.width, Math.round(Number(body.x))))
                if (body.y !== undefined && Number.isFinite(Number(body.y))) target.y = Math.max(0, Math.min(view.sandbox.map.height, Math.round(Number(body.y))))
                const targetPatch: Record<string, StateValue | null> = {}
                for (const [k, v] of Object.entries(statePatch)) {
                  const old = target.state[k] ?? null
                  if (old === v) continue
                  changes.push(`${k}「${old === null ? '（无）' : String(old)}」→「${v === null ? '（清除）' : String(v)}」`)
                  targetPatch[k] = v
                }
                if (changes.length === 0) throw new HttpError('没有任何要改的内容', 400)
                for (const [k, v] of Object.entries(targetPatch)) {
                  if (v === null) delete target.state[k]
                  else target.state[k] = v
                }
                target.lastEditedBy = by
                target.lastEditedAt = Date.now()
                view.run.events.push({
                  id: shortId('ev'), tick: view.run.tick, ts: Date.now(), kind: 'mutate',
                  actor: 'gm', actorName: by, text: `${by}把「${target.name}」的 ${changes.join('，')}。`, targetId: target.id,
                })
              }
              if (view.run.events.length > 3000) view.run.events = view.run.events.slice(-3000)
              await commit(view, workspace)
              return send(res, 200, {
                ok: true,
                data: { world: await world({ workspace, sandboxId, create: true }), changes },
              })
            },

            // POST /paranim/agent —— 智能体的增/改/删（需求 3）
            'POST /agent': async () => {
              const view = await world({ workspace, sandboxId, create: true })
              const op = String(body.op ?? 'update')

              if (op === 'remove') {
                const agentId = String(body.agentId ?? '')
                const index = view.run.agents.findIndex((a) => a.id === agentId)
                if (index < 0) throw new HttpError(`找不到智能体 ${agentId}`, 404)
                const [gone] = view.run.agents.splice(index, 1)
                view.run.events.push({
                  id: shortId('ev'), tick: view.run.tick, ts: Date.now(), kind: 'despawn', actor: 'gm', actorName: '世界',
                  text: `${gone.name}离开了这座小镇。`,
                })
                await deps.runOf(workspace).save(view.run)
                return send(res, 200, { ok: true, data: await world({ workspace, sandboxId, create: true }) })
              }

              if (op === 'add') {
                const raw = (body.agent ?? {}) as Record<string, unknown>
                // 自动生成的 id 必须**自己避让**，而不是撞上就报 409：
                // 调用方没有指定 id（界面的新增按钮就是这样），用一个随机短 id 撞上已有
                // 角色时报错，等于"点新增偶尔会失败、只闪一下底栏错误"。
                // 调用方**显式**指定了 id 才该报冲突——那时冲突是它自己的意图问题。
                const explicitId = typeof raw.id === 'string' && raw.id.trim() !== ''
                let template = normalizeAgentFromBody(raw, view.sandbox)
                if (explicitId) {
                  if (view.run.agents.some((a) => a.id === template.id)) {
                    throw new HttpError(`智能体 id ${template.id} 已存在`, 409)
                  }
                } else {
                  let guard = 0
                  while (view.run.agents.some((a) => a.id === template.id) && guard < 32) {
                    template = normalizeAgentFromBody({ ...raw, id: undefined }, view.sandbox)
                    guard += 1
                  }
                  if (view.run.agents.some((a) => a.id === template.id)) {
                    throw new HttpError('无法为该智能体生成唯一 id（连续 32 次碰撞，请显式指定 id）', 500)
                  }
                }
                if (view.run.agents.length >= 64) throw new HttpError('一局最多 64 个智能体', 400)
                const agent = {
                  ...template,
                  spawnTick: view.run.tick,
                  origin: 'user' as const,
                  memory: [{ tick: view.run.tick, kind: 'summary' as const, text: template.backstory === '' ? `${template.name}刚刚来到镇上。` : template.backstory, ts: Date.now() }],
                  lastUpdateTick: view.run.tick,
                  stepsTaken: 0,
                }
                view.run.agents.push(agent)
                view.run.events.push({
                  id: shortId('ev'), tick: view.run.tick, ts: Date.now(), kind: 'spawn', actor: 'gm', actorName: '世界',
                  text: `${agent.name}（${agent.concept}）加入了小镇。`,
                  targetAgentId: agent.id,
                })
                // 加进沙盒模板，下次开新局还在（用户新增的角色属于"设定"，不是一次性的）。
                view.sandbox.agents.push(stripRunFields(agent))
                await deps.runOf(workspace).save(view.run)
                await commit(view, workspace)
                return send(res, 200, { ok: true, data: await world({ workspace, sandboxId, create: true }) })
              }

              const agentId = String(body.agentId ?? '')
              const agent = view.run.agents.find((a) => a.id === agentId)
              if (agent === undefined) throw new HttpError(`找不到智能体 ${agentId}`, 404)
              const patch = (body.patch ?? {}) as Record<string, unknown>
              if (typeof patch.name === 'string' && patch.name.trim() !== '') agent.name = patch.name.trim()
              for (const key of ['concept', 'appearance', 'persona', 'backstory', 'goal', 'color', 'portrait'] as const) {
                if (typeof patch[key] === 'string') agent[key] = patch[key] as string
              }
              if (Array.isArray(patch.plan)) agent.plan = patch.plan.filter((v) => typeof v === 'string').slice(0, 24)
              if (Array.isArray(patch.inventory)) agent.inventory = patch.inventory.filter((v) => typeof v === 'string').slice(0, 24)
              if (patch.x !== undefined && Number.isFinite(Number(patch.x))) agent.x = Math.max(0, Math.min(view.sandbox.map.width, Math.round(Number(patch.x))))
              if (patch.y !== undefined && Number.isFinite(Number(patch.y))) agent.y = Math.max(0, Math.min(view.sandbox.map.height, Math.round(Number(patch.y))))
              if (patch.attrs !== null && typeof patch.attrs === 'object') {
                agent.attrs = normalizeAttrs({ ...agent.attrs, ...(patch.attrs as Record<string, number>) })
              }
              if (patch.mood !== undefined && patch.mood !== null) agent.mood = normalizeMood(patch.mood)
              // 自定义外观：空串表示"恢复默认角色表"
              if (typeof patch.sprite === 'string') {
                const ref = patch.sprite.trim()
                if (ref === '') delete agent.sprite
                else if (parseRef(ref) !== undefined) agent.sprite = ref
              }
              /**
               * 「当前想法」是可编辑的。
               *
               * 它不是一个独立字段，而是**记忆里最后一条 thought**（见客户端的
               * currentThought）。所以"编辑想法"就是往记忆里追一条——这样
               * 界面上立刻生效，而且不新增第二份真相（引擎每步也往这里写想法，
               * 若另存一个字段，两者迟早对不上）。
               */
              if (typeof patch.thought === 'string' && patch.thought.trim() !== '') {
                const text = patch.thought.trim().slice(0, 200)
                agent.memory.push({ tick: view.run.tick, kind: 'thought', text, ts: Date.now() })
                if (agent.memory.length > 200) agent.memory = agent.memory.slice(-200)
              }
              if (patch.model !== undefined) {
                if (patch.model === null) agent.model = null
                else {
                  const m = patch.model as Record<string, unknown>
                  const provider = String(m.provider ?? '')
                  const model = String(m.model ?? '')
                  agent.model = provider === '' || model === '' ? null : {
                    provider,
                    model,
                    reasoningEffort: typeof m.reasoningEffort === 'string' && m.reasoningEffort !== '' ? m.reasoningEffort : undefined,
                  }
                }
              }
              // 同步回沙盒模板：改的是"这个人是谁"，不该只在这一局里生效。
              const template = view.sandbox.agents.find((a) => a.id === agent.id)
              if (template !== undefined) Object.assign(template, stripRunFields(agent))
              else view.sandbox.agents.push(stripRunFields(agent))
              await deps.runOf(workspace).save(view.run)
              await commit(view, workspace)
              return send(res, 200, { ok: true, data: await world({ workspace, sandboxId, create: true }) })
            },

            // POST /paranim/directive —— 下达指令（需求 3 的指令引导）
            'POST /directive': async () => {
              const view = await world({ workspace, sandboxId, create: true })
              const directive = issueDirective(view.run, String(body.agentId ?? ''), String(body.text ?? ''))
              await deps.runOf(workspace).save(view.run)
              return send(res, 200, { ok: true, data: { directive, world: await world({ workspace, sandboxId, create: true }) } })
            },

            // POST /paranim/step —— 手动步进（需求 6）
            'POST /step': async () => {
              const result = await step({
                workspace,
                sandboxId,
                persist: body.persist !== false,
                maxAgents: body.maxAgents === undefined ? undefined : Number(body.maxAgents),
              })
              return send(res, 200, { ok: true, data: result })
            },

            // POST /paranim/step/config —— 手动 / 自动 + 时间流速（需求 6）
            'POST /step/config': async () => {
              const store = deps.stepOf(workspace)
              await store.load()
              const patch: Partial<StepConfig> = {}
              if (body.mode === 'manual' || body.mode === 'auto') patch.mode = body.mode
              if (body.intervalMs !== undefined) patch.intervalMs = Number(body.intervalMs)
              if (body.maxAgentsPerTick !== undefined) patch.maxAgentsPerTick = Number(body.maxAgentsPerTick)
              if (body.callTimeoutMs !== undefined) patch.callTimeoutMs = Number(body.callTimeoutMs)
              const next = await store.set(clampStepConfig({ ...store.get(), ...patch }))
              const resolvedId = (await world({ workspace, sandboxId, create: true })).sandbox.id
              if (next.mode === 'auto') startStepper(workspace, resolvedId, next.intervalMs)
              else stopStepper(stepperKey(workspace, resolvedId))
              return send(res, 200, { ok: true, data: await world({ workspace, sandboxId: resolvedId, create: true }) })
            },

            // POST /paranim/reset —— 重置运行态（保留沙盒设定，回到开局那一天）
            'POST /reset': async () => {
              const view = await world({ workspace, sandboxId, create: true })
              const fresh = deps.store.newRun(view.sandbox, body.count === undefined ? undefined : { count: Number(body.count) })
              await deps.runOf(workspace).save(fresh)
              stopStepper(stepperKey(workspace, view.sandbox.id))
              return send(res, 200, { ok: true, data: await world({ workspace, sandboxId: view.sandbox.id, create: true }) })
            },

            // POST /paranim/roll —— 直接掷一次（界面上的"亲自掷一骰"）
            'POST /roll': async () => {
              const view = await world({ workspace, sandboxId, create: true })
              const actorId = String(body.agentId ?? '')
              const agent = view.run.agents.find((a) => a.id === actorId)
              if (agent === undefined) throw new HttpError(`找不到智能体 ${actorId}`, 404)
              const attrRaw = String(body.attr ?? 'dex')
              if (!isAttrId(attrRaw)) throw new HttpError(`未知属性 ${attrRaw}`, 400)
              const difficulty = Number(body.difficulty ?? 11)
              const roll = resolveCheck({
                roll: 1 + Math.floor(Math.random() * 6),
                attr: attrRaw,
                attrValue: agent.attrs[attrRaw],
                difficulty: Number.isFinite(difficulty) ? difficulty : 11,
                actorName: agent.name,
                action: typeof body.action === 'string' ? body.action : '临时判定',
              })
              view.run.events.push({
                id: shortId('ev'), tick: view.run.tick, ts: Date.now(), kind: 'roll', actor: agent.id, actorName: agent.name,
                text: roll.text, roll: {
                  actor: agent.id, action: String(body.action ?? '临时判定'), kind: 'check',
                  roll: roll.roll, attr: roll.attr, attrValue: roll.attrValue, modifier: roll.modifier,
                  total: roll.total, difficulty: roll.difficulty, outcome: roll.outcome, ok: roll.ok, decisive: roll.decisive, text: roll.text,
                },
              })
              await deps.runOf(workspace).save(view.run)
              return send(res, 200, { ok: true, data: { roll, world: await world({ workspace, sandboxId, create: true }) } })
            },

            // POST /paranim/llm-probe —— 模型调用自检（逐 chunk 明细）
            'POST /llm-probe': async () => {
              const probe = await llmProbe({
                provider: typeof body.provider === 'string' ? body.provider : undefined,
                model: typeof body.model === 'string' ? body.model : undefined,
                reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
                system: typeof body.system === 'string' ? body.system : undefined,
                user: typeof body.user === 'string' ? body.user : undefined,
                maxTokens: body.maxTokens === undefined ? undefined : Number(body.maxTokens),
                quiet: body.quiet === true,
              })
              return send(res, 200, { ok: true, data: probe })
            },
          }

          const handle = routeTable[`${method} ${path}`]
          if (handle === undefined) throw new HttpError(`未知路由 ${method} /paranim${path}`, 404)
          /**
           * 同一工作区的写操作串行化。
           *
           * 每个写路由都是"读沙盒 → 改 → 落盘"三步，这几步的 await 点之间是交错
           * 窗口：两个请求的"读"若都发生在对方"写"之前，后写的那个就带着自己那份
           * 旧快照覆盖前面刚写的结果。实测 128 条并发涂抹——**全部请求都返回 200，
           * 却只有 2 格落上**，丢了 126 格且一声不吭。拖动涂抹正好稳定落进这个窗口，
           * 表现就是"涂不上去"。
           *
           * 队列把这三步绑成一个不可交错的整体。只读路由（掷骰、探测）不排队：
           * 让它们跟着等没有意义，还会让界面显得卡。
           */
          /**
           * 不排队的那几类：
           *  · /roll、/llm-probe —— 只读，跟着等没有意义
           *  · /step/config    —— 其中的"暂停"必须**立刻**生效。它也排队的话，
           *    暂停请求会排在正在跑的那次步进后面（模型调用可能几十秒），
           *    表现就是"点了暂停没反应、还在自己往前走"。
           *    停止计时器是纯内存操作，不参与沙盒的读-改-写，本来就不需要排队；
           *    落盘那步配置也没有竞争可言（同一工作区只有一份）。
           */
          const UNQUEUED = new Set(['/roll', '/llm-probe', '/step/config'])
          if (method === 'POST' && !UNQUEUED.has(path)) {
            await serialize(workspace, handle)
          } else {
            await handle()
          }
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          /**
           * 5xx 要把堆栈记下来。
           *
           * 只记 message 的话，像 "Cannot read properties of null" 这种错误完全
           * 无法定位——看不到是哪一行、也看不到调用链，只能靠反复插桩猜。
           */
          if (status >= 500) {
            log('route error:', `${method} ${path}`, error instanceof Error ? (error.stack ?? error.message) : String(error))
          }
          return send(res, status, { ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  ]

  return {
    routes,
    step,
    world,
    persistRun: async (args) => {
      const view = await world({ workspace: args.workspace, sandboxId: args.sandboxId, create: true })
      await deps.runOf(args.workspace).save(view.run)
    },
    llmProbe,
    resetRun: async (args) => {
      const view = await world({ workspace: args.workspace, sandboxId: args.sandboxId, create: true })
      const fresh = deps.store.newRun(view.sandbox, args.count === undefined ? undefined : { count: args.count })
      await deps.runOf(args.workspace).save(fresh)
      stopStepper(stepperKey(args.workspace, view.sandbox.id))
      return world({ workspace: args.workspace, sandboxId: view.sandbox.id, create: true })
    },
    setTrustedHosts,
    dispose: () => stopAllSteppers(),
  }
}

/** 从请求体里收一个智能体模板（新增用），补齐属性与坐标。 */
function normalizeAgentFromBody(raw: Record<string, unknown>, sandbox: Sandbox): SandboxAgent {
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : '无名居民'
  const id = typeof raw.id === 'string' && /^[a-zA-Z0-9._-]{1,40}$/.test(raw.id) ? raw.id : `agent-${randomToken(6)}`
  const attrs = normalizeAttrs(raw.attrs as Record<string, number> | undefined)
  // `model: null` 是**合法输入**，含义是"跟随宿主默认模型"（客户端的新增按钮就是这么发的）。
  // 这里原先只判了 undefined，null 会走到 modelRaw.provider 上抛 TypeError —— 接口 500，
  // 而界面上表现为"按钮没反应"（错误只闪在底栏）。null 与 undefined 在这里语义相同。
  const modelRaw = raw.model
  const modelObj = modelRaw !== null && typeof modelRaw === 'object' ? (modelRaw as Record<string, unknown>) : undefined
  const provider = modelObj === undefined ? '' : String(modelObj.provider ?? '')
  const model = modelObj === undefined ? '' : String(modelObj.model ?? '')
  return {
    id,
    name,
    concept: typeof raw.concept === 'string' ? raw.concept : '居民',
    appearance: typeof raw.appearance === 'string' ? raw.appearance : '',
    persona: typeof raw.persona === 'string' ? raw.persona : '',
    backstory: typeof raw.backstory === 'string' ? raw.backstory : '',
    mood: normalizeMood((raw as { mood?: unknown }).mood ?? MOOD_DEFAULT),
    x: Number.isFinite(Number(raw.x)) ? Math.max(0, Math.min(sandbox.map.width, Math.round(Number(raw.x)))) : Math.round(sandbox.map.width / 2),
    y: Number.isFinite(Number(raw.y)) ? Math.max(0, Math.min(sandbox.map.height, Math.round(Number(raw.y)))) : Math.round(sandbox.map.height / 2),
    attrs,
    model: provider === '' || model === '' ? null : { provider, model, reasoningEffort: typeof modelObj?.reasoningEffort === 'string' ? modelObj.reasoningEffort : undefined },
    plan: Array.isArray(raw.plan) ? raw.plan.filter((v): v is string => typeof v === 'string').slice(0, 24) : [],
    inventory: Array.isArray(raw.inventory) ? raw.inventory.filter((v): v is string => typeof v === 'string').slice(0, 24) : [],
    color: typeof raw.color === 'string' ? raw.color : '#7aa2f7',
    portrait: typeof raw.portrait === 'string' ? raw.portrait : '🙂',
  }
}

/** 把运行期字段剥掉，得到可写回沙盒模板的纯模板。 */
function stripRunFields(agent: SandboxAgent & { spawnTick?: number; origin?: string; memory?: unknown; lastUpdateTick?: number; stepsTaken?: number }): SandboxAgent {
  const { spawnTick, origin, memory, lastUpdateTick, stepsTaken, ...template } = agent
  void spawnTick; void origin; void memory; void lastUpdateTick; void stepsTaken
  return template
}

function slugify(name: string): string {
  const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return base === '' ? `sandbox-${shortId('s').slice(2, 8)}` : base.slice(0, 40)
}
