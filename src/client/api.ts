/**
 * 浏览器半边 → 宿主半边的同源 JSON 通道。
 *
 * 所有调用都带上 `workspace` + `sessionId`：宿主用它们决定运行态分桶
 * （不同工作区各跑各的小镇，互不串味）。
 */
import type { Directive, ModelChoice, ModelsResponse, RunState, Sandbox, StepConfig, WorldEvent } from '../shared/model.ts'

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export interface WorldView {
  sandbox: Sandbox
  run: RunState
  step: StepConfig
  agentCount: number
  stepper: {
    running: boolean
    inFlight: boolean
    intervalMs: number
    lastTick: number
    lastRunAt: number
    error?: string
    ticks: number
  }
}

export interface SandboxSummary {
  id: string
  name: string
  desc: string
  builtin: boolean
  attribution?: string
  license?: string
  updatedAt: number
  places: number
  objects: number
  agents: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    })
  } catch (error) {
    throw new ApiError(`网络错误：${error instanceof Error ? error.message : String(error)}`, 0)
  }
  let payload: { ok?: boolean; data?: T; error?: string }
  try {
    payload = (await res.json()) as typeof payload
  } catch {
    throw new ApiError(`响应解析失败（HTTP ${res.status}）`, res.status)
  }
  if (!res.ok || payload.ok === false) {
    throw new ApiError(payload.error ?? `HTTP ${res.status}`, res.status)
  }
  return payload.data as T
}

function scope(workspace?: string, sessionId?: string, sandboxId?: string): string {
  const params = new URLSearchParams()
  if (workspace !== undefined && workspace !== '') params.set('workspace', workspace)
  if (sessionId !== undefined && sessionId !== '') params.set('sessionId', sessionId)
  if (sandboxId !== undefined && sandboxId !== '') params.set('sandboxId', sandboxId)
  const text = params.toString()
  return text === '' ? '' : `?${text}`
}

export interface Scope {
  workspace?: string
  sessionId?: string
  sandboxId?: string
}

export function createApi(scopeRef: () => Scope) {
  const post = <T>(path: string, body: unknown, sandboxId?: string): Promise<T> => {
    const current = scopeRef()
    return request<T>(`/paranim${path}${scope(current.workspace, current.sessionId, sandboxId ?? current.sandboxId)}`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
    })
  }
  const get = <T>(path: string): Promise<T> => {
    const current = scopeRef()
    return request<T>(`/paranim${path}${scope(current.workspace, current.sessionId, current.sandboxId)}`)
  }

  return {
    world: (): Promise<WorldView> => get<WorldView>('/world'),
    sandboxes: (): Promise<{ sandboxes: SandboxSummary[]; currentId: string }> =>
      get<{ sandboxes: SandboxSummary[]; currentId: string }>('/sandboxes'),
    models: (): Promise<ModelsResponse> => get<ModelsResponse>('/models'),
    step: (options?: { maxAgents?: number }): Promise<{ tick: number; driven: number; outcomes: Array<{ agentName: string; source: string; detail: string }>; events: WorldEvent[]; world: WorldView }> =>
      post('/step', { maxAgents: options?.maxAgents }),
    stepConfig: (patch: Partial<StepConfig>): Promise<WorldView> => post('/step/config', patch),
    object: (body: Record<string, unknown>): Promise<{ world: WorldView; changes: string[] }> => post('/object', body),
    mapObject: (body: Record<string, unknown>): Promise<WorldView> => post('/map', body),
    agent: (body: Record<string, unknown>): Promise<WorldView> => post('/agent', body),
    directive: (agentId: string, text: string): Promise<{ directive: Directive; world: WorldView }> =>
      post('/directive', { agentId, text }),
    sandbox: (body: Record<string, unknown>): Promise<WorldView> => post('/sandbox', body),
    reset: (count?: number): Promise<WorldView> => post('/reset', count === undefined ? {} : { count }),
  }
}

export type ParanimApi = ReturnType<typeof createApi>
