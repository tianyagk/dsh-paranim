/**
 * dsh-paranim（他化自在天）— 宿主半边。
 *
 * 一条双面 bundle 行（`paranim` / `dsh-paranim`）：
 *  - node 半边（本文件）：沙盒库 + 运行态 + 世界步进引擎 + 每智能体的 ctx.llm 路由
 *    + /paranim/* 路由 + 模型可见工具与提示段；
 *  - 浏览器半边（src/client）：通过 `ctx.betterSidebar` 注册「他化自在天」页签。
 *
 * 为什么不放在 preset 里：沙盒库、运行态与自动步进的消费者（页签、模型工具、计时器）
 * 都跨会话存活，"这个小镇在跑"是宿主级的进程事实，不是某个 agent 会话的能力。
 * 本行**不发布任何服务**，所以不需要 isolate realm。
 */
import type { IncomingMessage } from 'node:http'
import { makeRoutes, type ParanimRoutes, type RouteDeps } from './host/routes.ts'
import { makeTools } from './host/tools.ts'
import { RunStore, SandboxStore, StepStore, bucketOf, dataHome } from './host/store.ts'
import { listModelChoices } from './host/engine.ts'
import { log, type PluginContext, type PluginLlm, type PluginWebRoute } from './host/context.ts'

/** 插件身份（bundle-patch 行的 name）。 */
export const name = 'dsh-paranim'

/**
 * 硬依赖只有 webServer：没有它就没有 /paranim/* 这条腿，行不该被激活。
 *
 * `webRuntime` **刻意不写进 inject**：inject 的语义是"等这个服务出现，否则整行
 * 挂起"。路由注册不依赖 webRuntime——它只提供信任域。把它写成硬依赖，会让一个
 * 不挂 webRuntime 的 profile 整体起不来；而现在那样只会让围栏退化为回环 Host 检查
 * （跨站防护仍生效），并在日志里说明。
 */
export const inject = ['webServer']

export function apply(ctx: PluginContext): void {
  const store = new SandboxStore()
  const runStores = new Map<string, RunStore>()
  const stepStores = new Map<string, StepStore>()
  const runOf = (workspace?: string): RunStore => {
    const key = bucketOf(workspace)
    let found = runStores.get(key)
    if (found === undefined) {
      found = new RunStore(workspace)
      runStores.set(key, found)
    }
    return found
  }
  const stepOf = (workspace?: string): StepStore => {
    const key = bucketOf(workspace)
    let found = stepStores.get(key)
    if (found === undefined) {
      found = new StepStore(workspace)
      stepStores.set(key, found)
    }
    return found
  }

  // 模型能力是**可选**的：宿主没配任何 provider 时沙盒仍要能开局（引擎走守则行动）。
  const llm = (): PluginLlm | undefined => ctx.get('llm')
  let cachedDefault: { provider: string; model: string; reasoningEffort?: string } | undefined
  let cachedDefaultAt = 0
  const defaultRoute = (): { provider: string; model: string; reasoningEffort?: string } | undefined => {
    const now = Date.now()
    if (now - cachedDefaultAt < 5000) return cachedDefault
    cachedDefaultAt = now
    const configured = ctx.get('agentDefaultModel')
    if (configured !== undefined) {
      try {
        const selection = configured.currentSelection()
        if (typeof selection?.provider === 'string' && typeof selection?.model === 'string' && selection.provider !== '' && selection.model !== '') {
          cachedDefault = { provider: selection.provider, model: selection.model, reasoningEffort: selection.reasoningEffort }
          return cachedDefault
        }
      } catch (error) {
        log('agentDefaultModel.currentSelection failed:', String(error))
      }
    }
    const service = llm()
    if (service === undefined) return undefined
    // 没有配置默认模型时，退到"第一个 provider 的第一个模型"——比"没有模型"有用得多，
    // 并且在界面里会明确标出它是退路（isDefault=false / source=fallback）。
    const provider = service.listProviders()[0]
    if (provider === undefined) return undefined
    void service
      .listModels(provider.id)
      .then((models) => {
        const first = models[0]
        if (first !== undefined) cachedDefault = { provider: provider.id, model: first.id }
      })
      .catch(() => undefined)
    cachedDefault = cachedDefault ?? undefined
    return cachedDefault
  }

  /** 从请求里取工作区：优先显式参数（浏览器半边总会带上），再退到会话表。 */
  const workspaceOf = (req: IncomingMessage): string | undefined => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const explicit = url.searchParams.get('workspace')
    if (explicit !== null && explicit !== '') return explicit
    const sessionId = url.searchParams.get('sessionId') ?? headerOf(req, 'x-paranim-session')
    if (sessionId === undefined || sessionId === '') return undefined
    const sessions = ctx.get('sessions')
    try {
      const session = sessions?.get(sessionId)
      const cwd = session?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch (error) {
      log('session workspace lookup failed:', String(error))
    }
    return undefined
  }

  const routes: ParanimRoutes = makeRoutes({
    store,
    runOf,
    stepOf,
    llm,
    defaultRoute,
    workspaceOf,
  } satisfies RouteDeps)

  ctx.effect(() => {
    // 信任域来自同一个 webRuntime（/api 网关用的就是它）。取不到就退化为回环
    // Host 检查——这是可选能力，不是硬依赖（见 inject 的说明）。
    try {
      const runtime = ctx.get('webRuntime') as { trustedHosts?: readonly string[] } | undefined
      const hosts = runtime?.trustedHosts
      routes.setTrustedHosts(Array.isArray(hosts) ? hosts : [])
    } catch (error) {
      log('trustedHosts unavailable:', String(error))
    }
    const disposers = routes.routes.map((route: PluginWebRoute) => {
      try {
        return ctx.webServer.register(route)
      } catch (error) {
        log('route register failed:', route.path, String(error))
        return () => undefined
      }
    })
    // 首次挂载就把出厂镜像种进沙盒库，并把它的来源与规模写进日志，
    // 这样"为什么里面已经有一个小镇"是查得到的，而不是魔法。
    void store
      .list(true)
      .then((list) => {
        log(`sandbox library ready at ${dataHome()} — ${list.length} sandbox(es)`)
        for (const sandbox of list) {
          log(`  · ${sandbox.id}: ${sandbox.name} — ${sandbox.places.length} places / ${sandbox.objects.length} objects / ${sandbox.agents.length} agents${sandbox.attribution === undefined ? '' : ` (${sandbox.attribution})`}`)
        }
      })
      .catch((error) => log('sandbox library init failed:', String(error)))
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已经释放 */
        }
      }
      // 卸载时必须停掉自动步进的计时器：留着它会在插件已经不在了以后继续烧模型额度。
      routes.dispose()
    }
  }, 'dsh-paranim: routes')

  ctx.effect(() => {
    const tools = ctx.get('tools')
    if (tools === undefined) {
      log('tools service absent — model tools not registered (sidebar UI still active)')
      return
    }
    const { register } = makeTools({
      routes,
      store,
      llm,
      defaultRoute,
    })
    return register(tools, ctx.get('systemPrompt'))
  }, 'dsh-paranim: model tools')

  log('host half mounted — sidebar tab is 「他化自在天」')
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return typeof value === 'string' ? value : undefined
}

export { makeRoutes, makeTools, SandboxStore, RunStore, StepStore, listModelChoices }
