/**
 * dsh-paranim — 宿主服务面（结构镜像）。
 *
 * 本插件在 DSH monorepo 的 cordis 实例之外解析，因此上游的
 * `declare module '@deepseek-ai/cordis'` 增强**不可靠地**到达这里的 Context。
 * 下面按运行时真实形状把用到的成员镜像一遍（dsh-better-sidebar 与生态插件
 * 走的是同一条路），加载器传进来的真 ctx 在结构上满足这些接口。
 *
 * 只写真正用到的成员：镜像越宽，越容易在升级后**悄悄跑到一个已经不存在的
 * 方法上**——窄接口会在替换现场就报错，宽接口会把错误推迟到运行期。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

/** 一条 named web 路由（@deepseek-ai/dsh-host-webserver 的 WebRoute 镜像）。 */
export interface PluginWebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** webserver 服务面（ctx.webServer.register 返回 disposer）。 */
export interface PluginWebServer {
  register(route: PluginWebRoute): () => void
}

/** webRuntime 服务面：/api 网关的信任来源（Host 回环 / 已配置的受信域）。 */
export interface PluginWebRuntime {
  trustedHosts: readonly string[]
}

// ── 模型服务（@deepseek-ai/dsh-llm 的结构子集）───────────────────────────

export interface LlmProviderInfo {
  id: string
  name: string
}

export interface LlmModelInfo {
  provider: string
  id: string
  name: string
  description?: string
  inputModalities?: readonly string[]
}

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export type LlmStreamChunk =
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: unknown }
  | { type: 'usage'; usage: { inputTokens?: number; outputTokens?: number } }
  | { type: 'finish'; reason: string }

export interface LlmGenerateOptions {
  provider: string
  model: string
  reasoningEffort?: string
  messages: LlmMessage[]
  /** 一次性调用者的系统提示；适配器把它映射到 provider 的 system 槽。 */
  system?: string
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
}

/** 模型服务的结构面。 */
export interface PluginLlm {
  listProviders(): LlmProviderInfo[]
  listModels(provider: string): Promise<LlmModelInfo[]>
  stream(options: LlmGenerateOptions): AsyncIterable<LlmStreamChunk>
}

/** 默认模型选择（@deepseek-ai/dsh-agent-default-model）。 */
export interface PluginDefaultModel {
  currentSelection(): { provider: string; model: string; reasoningEffort?: string }
}

// ── 工具与提示段 ─────────────────────────────────────────────────────────

export interface PluginToolDefinition {
  name: string
  description: string
  /** 完整 JSON Schema（对象根）。 */
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    /** 纯投影：args + 规范返回值 → 模型可见的内容块。 */
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  execute(args: Record<string, unknown>, exec?: { signal?: AbortSignal }): Promise<unknown>
}

export interface PluginToolRuntime {
  register(def: PluginToolDefinition): () => void
}

export interface PluginSystemPrompt {
  section(opts: { name: string; order: number; text: () => string }): () => void
}

// ── cordis 上下文 ────────────────────────────────────────────────────────

export interface PluginContext {
  webServer: PluginWebServer
  /** 注册生命周期回调（DSH vendored cordis）。 */
  effect(fn: () => void | (() => void), label?: string): void
  /**
   * 可选能力——一律走 ctx.get，不用 inject（这些服务在宿主平面，缺了也要能降级）。
   * 只声明真正用到的几个 key：多余的重载会让"这个插件到底依赖什么"变得读不出来。
   */
  get(name: 'tools'): PluginToolRuntime | undefined
  get(name: 'systemPrompt'): PluginSystemPrompt | undefined
  get(name: 'llm'): PluginLlm | undefined
  get(name: 'agentDefaultModel'): PluginDefaultModel | undefined
  get(name: 'sessions'): PluginSessionStore | undefined
  get(name: 'webRuntime'): { trustedHosts?: readonly string[] } | undefined
  get(name: string): unknown
}

/** session 存储的结构子集：只需要读到会话的工作区（运行态按工作区分桶）。 */
export interface PluginSessionStore {
  get(id: string):
    | {
        header?: { cwd?: string }
      }
    | undefined
}

/** 统一日志前缀。 */
export function log(...parts: unknown[]): void {
  console.log('[paranim]', ...parts)
}
