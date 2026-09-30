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
import {
  clampStepConfig,
  isAttrId,
  normalizeAttrs,
  resolveCheck,
  shortId,
  toStateValue,
  type Sandbox,
  type SandboxAgent,
  type SandboxSaveBody,
  type StateValue,
  type StepConfig,
  type WorldObject,
} from '../shared/model.ts'
import { findObject } from '../shared/rules.ts'
import { isTrustedApiRequest } from './fence.ts'
import { messageOf, type LlmMessage, type PluginLlm, type PluginWebRoute } from './context.ts'
import { log } from './context.ts'
import { issueDirective, listModelChoices, runTick, type AgentCall, type TickResult } from './engine.ts'
import { RunStore, SandboxStore, StepStore, normalizeObject, normalizeSandbox } from './store.ts'

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

export function stepperKey(workspace: string | undefined, sandboxId: string): string {
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

export function stopAllSteppers(): void {
  for (const key of [...steppers.keys()]) stopStepper(key)
}

/** 插件卸载时把计时器一并清掉（fiber disposal 的收尾）。 */
export function disposeAllSteppers(): void {
  stopAllSteppers()
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
    const sandbox = args.sandboxId === undefined || args.sandboxId === ''
      ? sandboxes[0]
      : sandboxes.find((s) => s.id === args.sandboxId)
    if (sandbox === undefined) throw new HttpError(`找不到沙盒 ${String(args.sandboxId)}`, 404)
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
      // 沙盒上的对象状态可能被这一 step 改过（智能体动了灯），一起落盘，
      // 否则刷新页面后"灯还亮着"，而事件流里写着它坏了。
      const dirty = view.sandbox.objects.some((o) => (o.lastEditedAt ?? 0) > view.sandbox.updatedAt)
      if (dirty) await deps.store.save(view.sandbox)
    }
    return { ...result, world: await world({ workspace: args.workspace, sandboxId: args.sandboxId, create: true }) }
  }

  /** 从 llm 服务造一个调用器；llm 缺失时返回一个总是抛错的实现，让引擎走兜底。 */
  const makeCaller = (llm: PluginLlm | undefined) => {
    return async (agent: { id: string; name: string }, call: AgentCall, signal: AbortSignal): Promise<string> => {
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
      throw new Error(`模型 ${call.route.provider}/${call.route.model} 没有返回文本（${attempt.detail}）`)
    }
  }

  /** 一次模型调用：拼文本，并把"这次调用长什么样"记成可读的 detail。 */
  const callModelOnce = async (
    llm: PluginLlm,
    call: AgentCall,
    signal: AbortSignal,
    options?: {
      dropReasoningEffort?: boolean
      provider?: string
      model?: string
      temperature?: number
      maxTokens?: number
      system?: string
      user?: string
      /** 覆盖 messages（探针用来对比"system 单独给"与"折进 messages"两种形状）。 */
      messages?: LlmMessage[]
      /** 完全不传 temperature（探针用：某些兼容层对 temperature 敏感）。 */
      noTemperature?: boolean
    },
  ): Promise<{ text: string; detail: string }> => {
    const started = Date.now()
    let text = ''
    const kinds = new Map<string, number>()
    let finish = ''
    let usage = ''
    for await (const chunk of llm.stream({
      provider: options?.provider ?? call.route.provider,
      model: options?.model ?? call.route.model,
      reasoningEffort: options?.dropReasoningEffort === true ? undefined : call.route.reasoningEffort,
      system: options?.system ?? call.system,
      messages: options?.messages ?? [messageOf('user', options?.user ?? call.user)],
      // 「不传」而不是「传 0」：省缺与显式 0 在适配器里是两条路。
      temperature: options?.noTemperature === true ? undefined : (options?.temperature ?? 0.9),
      maxTokens: options?.maxTokens ?? 1200,
      signal,
    })) {
      kinds.set(chunk.type, (kinds.get(chunk.type) ?? 0) + 1)
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'reasoning-delta') text = text
      else if (chunk.type === 'usage') usage = JSON.stringify(chunk.usage)
      else if (chunk.type === 'finish') finish = chunk.reason
    }
    const shape = [...kinds.entries()].map(([kind, count]) => `${kind}×${count}`).join(' ')
    const detail = `耗时 ${Date.now() - started}ms｜chunk: ${shape === '' ? '（一个都没有）' : shape}｜finish=${finish === '' ? '（无）' : finish}${usage === '' ? '' : `｜usage=${usage}`}`
    return { text, detail }
  }

  /**
   * 模型调用自检：拿真实的 provider/model 走一次完整调用，返回逐 chunk 明细。
   * 存在的理由是"空文本"这类失败**无法从错误信息里诊断**——必须看到 chunk
   * 构成与结束原因，才能判断是上游拒绝、适配器没吐文本，还是路由根本没生效。
   */
  const llmProbe = async (args: { provider?: string; model?: string; reasoningEffort?: string; system?: string; user?: string }) => {
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
    const call: AgentCall = {
      route: { provider, model, reasoningEffort: args.reasoningEffort ?? route?.reasoningEffort },
      system: args.system ?? '你是一个小镇居民。只回答两个字：收到',
      user: args.user ?? '现在几点了？',
    }
    const controller = new AbortController()
    lines.push('')
    lines.push('【A】system= 单独给、messages 只有 user（插件当前的调用形状）')
    lines.push(await oneProbe(llm, call, controller.signal))
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
      }),
    )
    return { ok: true, text: lines.join('\n') }
  }

  /** 跑一种调用形状，把结果压成几行（异常也在内部收口）。 */
  const oneProbe = async (
    llm: PluginLlm,
    call: AgentCall,
    signal: AbortSignal,
    variant?: {
      messages?: LlmMessage[]
      dropReasoningEffort?: boolean
      noTemperature?: boolean
    },
  ): Promise<string> => {
    try {
      const attempt = await callModelOnce(llm, call, signal, {
        dropReasoningEffort: variant?.dropReasoningEffort,
        messages: variant?.messages,
        noTemperature: variant?.noTemperature,
      })
      const rows = [`  ${attempt.detail}`, `  文本=${JSON.stringify(attempt.text.slice(0, 160))}`]
      if (attempt.text.trim() === '') {
        const retry = await callModelOnce(llm, call, signal, {
          dropReasoningEffort: true,
          messages: variant?.messages,
          noTemperature: variant?.noTemperature,
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

          // GET /paranim/world —— 沙盒 + 运行态 + 步进设置
          if (method === 'GET' && path === '/world') {
            const view = await world({ workspace, sandboxId, create: url.searchParams.get('create') !== 'false' })
            return send(res, 200, { ok: true, data: view })
          }

          // GET /paranim/sandboxes —— 沙盒库
          if (method === 'GET' && path === '/sandboxes') {
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
                  objects: s.objects.length,
                  agents: s.agents.length,
                })),
              },
            })
          }

          // GET /paranim/models —— 可用模型（provider × model）
          if (method === 'GET' && path === '/models') {
            const choices = await listModelChoices(deps.llm(), deps.defaultRoute())
            return send(res, 200, { ok: true, data: choices })
          }

          // POST /paranim/sandbox —— 保存/另存/切换沙盒
          if (method === 'POST' && path === '/sandbox') {
            const action = String(body.action ?? 'save')
            if (action === 'select') {
              const id = String(body.id ?? '')
              const target = await deps.store.get(id)
              if (target === undefined) throw new HttpError(`找不到沙盒 ${id}`, 404)
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
                map: { width: 120, height: 90, ground: '#1f2430' },
                places: [],
                objects: [],
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
          }

          // POST /paranim/map —— 增删地标/物件
          if (method === 'POST' && path === '/map') {
            const view = await world({ workspace, sandboxId, create: true })
            const op = String(body.op ?? 'upsert')
            const bucket = body.kind === 'place' ? view.sandbox.places : view.sandbox.objects
            if (op === 'remove') {
              const id = String(body.id ?? '')
              const index = bucket.findIndex((o) => o.id === id)
              if (index < 0) throw new HttpError(`找不到对象 ${id}`, 404)
              bucket.splice(index, 1)
            } else {
              const raw = body.object ?? body
              const fallbackId = shortId(body.kind === 'place' ? 'place' : 'obj')
              const parsed = normalizeObject(raw, view.sandbox.map.width, view.sandbox.map.height, body.kind === 'place' ? 'place' : 'prop', fallbackId)
              if (parsed === undefined) throw new HttpError('对象缺少合法 id', 400)
              const index = bucket.findIndex((o) => o.id === parsed.id)
              if (index < 0) bucket.push(parsed)
              else bucket[index] = { ...bucket[index], ...parsed }
            }
            const saved = await deps.store.save(view.sandbox)
            return send(res, 200, { ok: true, data: await world({ workspace, sandboxId: saved.id, create: true }) })
          }

          // POST /paranim/object —— 修改物体状态（需求 5 的右键菜单落点）
          if (method === 'POST' && path === '/object') {
            const view = await world({ workspace, sandboxId, create: true })
            const objectId = String(body.objectId ?? '')
            const target = findObject(view.sandbox, objectId) ?? findObject({ ...view.sandbox, objects: [...view.sandbox.objects, ...[]] }, objectId)
            if (target === undefined) throw new HttpError(`找不到物体 ${objectId}`, 404)
            const by = typeof body.by === 'string' && body.by.trim() !== '' ? body.by.trim() : '玩家'
            const changes: string[] = []

            if (typeof body.name === 'string' && body.name.trim() !== '' && body.name !== target.name) {
              changes.push(`名称「${target.name}」→「${body.name.trim()}」`)
              target.name = body.name.trim()
            }
            if (typeof body.desc === 'string') target.desc = body.desc
            if (typeof body.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(body.color)) target.color = body.color
            if (typeof body.interactive === 'boolean') target.interactive = body.interactive
            if (body.x !== undefined && Number.isFinite(Number(body.x))) target.x = Math.max(0, Math.min(view.sandbox.map.width, Math.round(Number(body.x))))
            if (body.y !== undefined && Number.isFinite(Number(body.y))) target.y = Math.max(0, Math.min(view.sandbox.map.height, Math.round(Number(body.y))))

            if (body.state !== null && typeof body.state === 'object' && !Array.isArray(body.state)) {
              for (const [key, rawValue] of Object.entries(body.state as Record<string, unknown>)) {
                if (key === '' || key.length > 60) continue
                const value = rawValue === null ? null : toStateValue(rawValue)
                if (value === undefined) {
                  throw new HttpError(`状态「${key}」的值类型不支持（只接受字符串/数字/布尔/null/短数组）`, 400)
                }
                const before = target.state[key] ?? null
                if (before === value) continue
                if (value === null) delete target.state[key]
                else target.state[key] = value
                changes.push(`${key}「${before === null ? '（无）' : String(before)}」→「${value === null ? '（清除）' : String(value)}」`)
              }
            }
            if (changes.length === 0) throw new HttpError('没有任何要改的内容', 400)

            target.lastEditedBy = by
            target.lastEditedAt = Date.now()
            view.run.events.push({
              id: shortId('ev'),
              tick: view.run.tick,
              kind: 'mutate',
              ts: Date.now(),
              actor: 'gm',
              actorName: by,
              text: `${by}把「${target.name}」的 ${changes.join('，')}。`,
              targetId: target.id,
            })
            if (view.run.events.length > 3000) view.run.events = view.run.events.slice(-3000)
            await deps.store.save(view.sandbox)
            await deps.runOf(workspace).save(view.run)
            return send(res, 200, {
              ok: true,
              data: { world: await world({ workspace, sandboxId, create: true }), changes },
            })
          }

          // POST /paranim/agent —— 智能体的增/改/删（需求 3）
          if (method === 'POST' && path === '/agent') {
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
              const template = normalizeAgentFromBody(raw, view.sandbox)
              if (view.run.agents.some((a) => a.id === template.id)) {
                throw new HttpError(`智能体 id ${template.id} 已存在`, 409)
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
              await deps.store.save(view.sandbox)
              return send(res, 200, { ok: true, data: await world({ workspace, sandboxId, create: true }) })
            }

            const agentId = String(body.agentId ?? '')
            const agent = view.run.agents.find((a) => a.id === agentId)
            if (agent === undefined) throw new HttpError(`找不到智能体 ${agentId}`, 404)
            const patch = (body.patch ?? {}) as Record<string, unknown>
            if (typeof patch.name === 'string' && patch.name.trim() !== '') agent.name = patch.name.trim()
            for (const key of ['concept', 'appearance', 'persona', 'backstory', 'goal', 'fear', 'secret', 'color', 'portrait'] as const) {
              if (typeof patch[key] === 'string') agent[key] = patch[key] as string
            }
            if (Array.isArray(patch.plan)) agent.plan = patch.plan.filter((v) => typeof v === 'string').slice(0, 24)
            if (Array.isArray(patch.inventory)) agent.inventory = patch.inventory.filter((v) => typeof v === 'string').slice(0, 24)
            if (patch.x !== undefined && Number.isFinite(Number(patch.x))) agent.x = Math.max(0, Math.min(view.sandbox.map.width, Math.round(Number(patch.x))))
            if (patch.y !== undefined && Number.isFinite(Number(patch.y))) agent.y = Math.max(0, Math.min(view.sandbox.map.height, Math.round(Number(patch.y))))
            if (patch.attrs !== null && typeof patch.attrs === 'object') {
              agent.attrs = normalizeAttrs({ ...agent.attrs, ...(patch.attrs as Record<string, number>) })
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
            await deps.store.save(view.sandbox)
            return send(res, 200, { ok: true, data: await world({ workspace, sandboxId, create: true }) })
          }

          // POST /paranim/directive —— 神谕（需求 3 的指令引导）
          if (method === 'POST' && path === '/directive') {
            const view = await world({ workspace, sandboxId, create: true })
            const directive = issueDirective(view.run, String(body.agentId ?? ''), String(body.text ?? ''))
            await deps.runOf(workspace).save(view.run)
            return send(res, 200, { ok: true, data: { directive, world: await world({ workspace, sandboxId, create: true }) } })
          }

          // POST /paranim/step —— 手动步进（需求 6）
          if (method === 'POST' && path === '/step') {
            const result = await step({
              workspace,
              sandboxId,
              persist: body.persist !== false,
              maxAgents: body.maxAgents === undefined ? undefined : Number(body.maxAgents),
            })
            return send(res, 200, { ok: true, data: result })
          }

          // POST /paranim/step/config —— 手动 / 自动 + 时间流速（需求 6）
          if (method === 'POST' && path === '/step/config') {
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
          }

          // POST /paranim/reset —— 重置运行态（保留沙盒设定，回到开局那一天）
          if (method === 'POST' && path === '/reset') {
            const view = await world({ workspace, sandboxId, create: true })
            const fresh = deps.store.newRun(view.sandbox, body.count === undefined ? undefined : { count: Number(body.count) })
            await deps.runOf(workspace).save(fresh)
            stopStepper(stepperKey(workspace, view.sandbox.id))
            return send(res, 200, { ok: true, data: await world({ workspace, sandboxId: view.sandbox.id, create: true }) })
          }

          // POST /paranim/roll —— 直接掷一次（界面上的"亲自掷一骰"）
          if (method === 'POST' && path === '/roll') {
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
          }

          // POST /paranim/llm-probe —— 模型调用自检（逐 chunk 明细）
          if (method === 'POST' && path === '/llm-probe') {
            const probe = await llmProbe({
              provider: typeof body.provider === 'string' ? body.provider : undefined,
              model: typeof body.model === 'string' ? body.model : undefined,
              reasoningEffort: typeof body.reasoningEffort === 'string' ? body.reasoningEffort : undefined,
              system: typeof body.system === 'string' ? body.system : undefined,
              user: typeof body.user === 'string' ? body.user : undefined,
            })
            return send(res, 200, { ok: true, data: probe })
          }

          // GET /paranim/events —— 事件流（可按 since 增量拉）
          if (method === 'GET' && path === '/events') {
            const view = await world({ workspace, sandboxId, create: true })
            const since = Number(url.searchParams.get('since') ?? '0')
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '200')))
            const events = view.run.events.filter((e) => (Number.isFinite(since) ? e.tick > since : true)).slice(-limit)
            return send(res, 200, { ok: true, data: { tick: view.run.tick, events } })
          }

          throw new HttpError(`未知路由 ${method} /paranim${path}`, 404)
        } catch (error) {
          const status = error instanceof HttpError ? error.status : 500
          if (status >= 500) log('route error:', `${method} ${path}`, String(error))
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
  const id = typeof raw.id === 'string' && /^[a-zA-Z0-9._-]{1,40}$/.test(raw.id) ? raw.id : `agent-${shortId('a').slice(2, 8)}`
  const attrs = normalizeAttrs(raw.attrs as Record<string, number> | undefined)
  const modelRaw = raw.model as Record<string, unknown> | undefined
  const provider = modelRaw === undefined ? '' : String(modelRaw.provider ?? '')
  const model = modelRaw === undefined ? '' : String(modelRaw.model ?? '')
  return {
    id,
    name,
    concept: typeof raw.concept === 'string' ? raw.concept : '居民',
    appearance: typeof raw.appearance === 'string' ? raw.appearance : '',
    persona: typeof raw.persona === 'string' ? raw.persona : '',
    backstory: typeof raw.backstory === 'string' ? raw.backstory : '',
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    fear: typeof raw.fear === 'string' ? raw.fear : '',
    secret: typeof raw.secret === 'string' ? raw.secret : '',
    x: Number.isFinite(Number(raw.x)) ? Math.max(0, Math.min(sandbox.map.width, Math.round(Number(raw.x)))) : Math.round(sandbox.map.width / 2),
    y: Number.isFinite(Number(raw.y)) ? Math.max(0, Math.min(sandbox.map.height, Math.round(Number(raw.y)))) : Math.round(sandbox.map.height / 2),
    attrs,
    model: provider === '' || model === '' ? null : { provider, model, reasoningEffort: typeof modelRaw?.reasoningEffort === 'string' ? modelRaw.reasoningEffort : undefined },
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
