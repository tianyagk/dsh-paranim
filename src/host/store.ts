/**
 * dsh-paranim — 沙盒库与运行态（需求 2）。
 *
 * 两类数据，落在同一个根目录下的两个子目录，用两套语义：
 *
 *   ~/.dsh/dsh-paranim/sandboxes/<id>.json   —— 可编辑/保存/载入的**世界沙盒**
 *   ~/.dsh/dsh-paranim/runs/<id>.json        —— 一次推演的**运行态**（tick、记忆、事件）
 *
 * 分开存是刻意的：沙盒是"设定"，运行态是"这一局"。把记忆和坐标写回沙盒，同一个
 * 小镇就没法用不同人数、不同角色再开一局了。`saveFromRun` 是唯一把运行态折回
 * 沙盒的通道，并且要用户显式点「从当前推演导出」。
 *
 * `assets/smallville.json` 随插件发货，是只读镜像；首次启动时复制一份到
 * sandboxes/ 作为**可编辑的**初始沙盒（builtin 标记保留，用来提示出处）。
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATTR_IDS,
  DEFAULT_STEP_CONFIG,
  clampAttr,
  clampStepConfig,
  normalizeAttrs,
  shortId,
  type Attrs,
  type Directive,
  type RunAgent,
  type RunState,
  type Sandbox,
  type SandboxAgent,
  type StateValue,
  type StepConfig,
  type WorldObject,
} from '../shared/model.ts'
import { log } from './context.ts'
import { INLINE_SMALLVILLE } from './fallback.ts'

const SANDBOX_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export function dataHome(): string {
  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(base, 'dsh-paranim')
}

export function sandboxDir(): string {
  return join(dataHome(), 'sandboxes')
}

function runDir(workspace?: string): string {
  // 运行态按工作区分桶：换一个项目/会话时不该看到上一个工作区的小镇在跑。
  // 工作区缺失（无会话上下文）时落到 shared 桶，仍然可用。
  return join(dataHome(), 'runs', bucketOf(workspace))
}

/** 把工作区路径折成一个安全的目录名。 */
export function bucketOf(workspace: string | undefined): string {
  const raw = (workspace ?? '').trim()
  if (raw === '') return 'shared'
  const slug = raw.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(-48)
  return slug === '' ? 'shared' : slug
}

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    const text = await readFile(file, 'utf8')
    return JSON.parse(text) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      log('read failed:', file, String(error))
    }
    return undefined
  }
}

/** 原子写：同目录临时文件 + rename，避免半截 JSON 覆盖掉一个好沙盒。 */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
}

// ── 归一化 ───────────────────────────────────────────────────────────────
//
// 沙盒文件是明文，玩家可以手改，也可能来自旧版本或别的工具。所有入口都过一遍
// normalize*，把缺失字段补齐、越界值夹紧、脏坐标丢掉——**读进来就直接可用**，
// 而不是把校验散到引擎各行去。

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function normalizeState(input: unknown): Record<string, StateValue> {
  const out: Record<string, StateValue> = {}
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return out
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (key === '' || key.length > 60) continue
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value as StateValue
      continue
    }
    if (Array.isArray(value)) {
      const arr = value.filter((v) => typeof v === 'string' || typeof v === 'number').slice(0, 40)
      out[key] = arr as StateValue
    }
  }
  return out
}

export function normalizeObject(
  input: unknown,
  mapW: number,
  mapH: number,
  fallbackKind: WorldObject['kind'],
  /**
   * id 缺失时用的兜底 id。**新增**对象必须给一个（否则会得到一个无名对象），
   * **导入**已有数据时不给——那份数据里的 id 是它的身份，静默改名比缺 id 更糟。
   */
  fallbackId?: string,
): WorldObject | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const o = input as Record<string, unknown>
  const id = str(o.id).trim() === '' ? (fallbackId ?? '') : str(o.id).trim()
  if (id === '') return undefined
  const kind = str(o.kind, fallbackKind) as WorldObject['kind']
  return {
    id,
    name: str(o.name, id),
    kind,
    x: Math.max(0, Math.min(mapW, Math.round(num(o.x, 0)))),
    y: Math.max(0, Math.min(mapH, Math.round(num(o.y, 0)))),
    w: o.w === undefined ? undefined : Math.max(1, Math.round(num(o.w, 1))),
    h: o.h === undefined ? undefined : Math.max(1, Math.round(num(o.h, 1))),
    color: typeof o.color === 'string' ? o.color : undefined,
    desc: typeof o.desc === 'string' ? o.desc : undefined,
    state: normalizeState(o.state),
    interactive: o.interactive === undefined ? true : o.interactive !== false,
    affordances: Array.isArray(o.affordances) ? o.affordances.filter((v) => typeof v === 'string').slice(0, 12) : undefined,
    tags: Array.isArray(o.tags) ? o.tags.filter((v) => typeof v === 'string').slice(0, 12) : undefined,
    lastEditedBy: typeof o.lastEditedBy === 'string' ? o.lastEditedBy : undefined,
    lastEditedAt: o.lastEditedAt === undefined ? undefined : num(o.lastEditedAt, 0),
  }
}

function normalizeAgentTemplate(input: unknown, mapW: number, mapH: number, index: number): SandboxAgent | undefined {
  if (input === null || typeof input !== 'object') return undefined
  const a = input as Record<string, unknown>
  const id = str(a.id).trim() === '' ? `agent-${index + 1}` : str(a.id).trim()
  const attrs = normalizeAttrs(a.attrs as Partial<Attrs> | undefined)
  const model = a.model === null || a.model === undefined ? null : {
    provider: str((a.model as Record<string, unknown>).provider),
    model: str((a.model as Record<string, unknown>).model),
    reasoningEffort: typeof (a.model as Record<string, unknown>).reasoningEffort === 'string'
      ? String((a.model as Record<string, unknown>).reasoningEffort)
      : undefined,
  }
  return {
    id,
    name: str(a.name, id),
    concept: str(a.concept, '居民'),
    appearance: str(a.appearance),
    persona: str(a.persona),
    backstory: str(a.backstory),
    goal: str(a.goal),
    x: Math.max(0, Math.min(mapW, Math.round(num(a.x, mapW / 2)))),
    y: Math.max(0, Math.min(mapH, Math.round(num(a.y, mapH / 2)))),
    attrs,
    model: model !== null && (model.provider === '' || model.model === '') ? null : model,
    plan: Array.isArray(a.plan) ? a.plan.filter((v) => typeof v === 'string').slice(0, 24) : [],
    inventory: Array.isArray(a.inventory) ? a.inventory.filter((v) => typeof v === 'string').slice(0, 24) : [],
    color: str(a.color, '#7aa2f7'),
    portrait: str(a.portrait, '🙂'),
  }
}

export function normalizeSandbox(input: unknown, fallbackId = 'sandbox'): Sandbox {
  const raw = (input ?? {}) as Record<string, unknown>
  const mapRaw = (raw.map ?? {}) as Record<string, unknown>
  const width = Math.max(20, Math.min(600, Math.round(num(mapRaw.width, 140))))
  const height = Math.max(20, Math.min(600, Math.round(num(mapRaw.height, 100))))
  const map = {
    width,
    height,
    ground: str(mapRaw.ground, '#20232c'),
    decor: Array.isArray(mapRaw.decor)
      ? mapRaw.decor
          .filter((d) => d !== null && typeof d === 'object')
          .slice(0, 64)
          .map((d) => {
            const e = d as Record<string, unknown>
            return {
              x: Math.round(num(e.x, 0)),
              y: Math.round(num(e.y, 0)),
              w: Math.max(1, Math.round(num(e.w, 1))),
              h: Math.max(1, Math.round(num(e.h, 1))),
              color: str(e.color, '#2a2e3a'),
              label: typeof e.label === 'string' ? e.label : undefined,
            }
          })
      : undefined,
    // 室内地板区域（house 类沙盒）：少了这条，房间会被画成实心屋顶，家具全被盖住
    interior:
      mapRaw.interior === null || typeof mapRaw.interior !== 'object'
        ? undefined
        : {
            x: Math.max(0, Math.round(num((mapRaw.interior as Record<string, unknown>).x, 0))),
            y: Math.max(0, Math.round(num((mapRaw.interior as Record<string, unknown>).y, 0))),
            w: Math.max(1, Math.round(num((mapRaw.interior as Record<string, unknown>).w, 1))),
            h: Math.max(1, Math.round(num((mapRaw.interior as Record<string, unknown>).h, 1))),
          },
  }
  const places = (Array.isArray(raw.places) ? raw.places : [])
    .map((p) => normalizeObject(p, width, height, 'place'))
    .filter((p): p is WorldObject => p !== undefined)
  const objects = (Array.isArray(raw.objects) ? raw.objects : [])
    .concat(Array.isArray(raw.props) ? raw.props : [])
    .map((p) => normalizeObject(p, width, height, 'prop'))
    .filter((p): p is WorldObject => p !== undefined)
  const agents = (Array.isArray(raw.agents) ? raw.agents : [])
    .map((a, i) => normalizeAgentTemplate(a, width, height, i))
    .filter((a): a is SandboxAgent => a !== undefined)
  const relations = (Array.isArray(raw.relations) ? raw.relations : [])
    .filter((r) => r !== null && typeof r === 'object')
    .slice(0, 400)
    .map((r) => {
      const e = r as Record<string, unknown>
      return {
        a: str(e.a),
        b: str(e.b),
        label: str(e.label, '相识'),
        affinity: Math.max(-100, Math.min(100, Math.round(num(e.affinity, 0)))),
      }
    })
    .filter((r) => r.a !== '' && r.b !== '')

  const id = str(raw.id).trim()
  return {
    v: 1,
    id: SANDBOX_ID_RE.test(id) ? id : fallbackId,
    name: str(raw.name, id === '' ? fallbackId : id),
    desc: str(raw.desc),
    attribution: typeof raw.attribution === 'string' ? raw.attribution : undefined,
    license: typeof raw.license === 'string' ? raw.license : undefined,
    builtin: raw.builtin === true,
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
    map,
    places,
    objects,
    relations,
    agents,
    startTick: raw.startTick === undefined ? undefined : Math.max(0, Math.round(num(raw.startTick, 0))),
  }
}

function normalizeRun(input: unknown, sandboxId: string): RunState {
  const raw = (input ?? {}) as Record<string, unknown>
  const agentsRaw = Array.isArray(raw.agents) ? raw.agents : []
  const agents: RunAgent[] = agentsRaw
    .filter((a) => a !== null && typeof a === 'object')
    .slice(0, 64)
    .map((a, i) => {
      const e = a as Record<string, unknown>
      const tpl = normalizeAgentTemplate(e, 1000, 1000, i)
      if (tpl === undefined) return undefined
      const memory = Array.isArray(e.memory)
        ? e.memory
            .filter((m) => m !== null && typeof m === 'object')
            .slice(-200)
            .map((m) => {
              const mm = m as Record<string, unknown>
              return {
                tick: Math.round(num(mm.tick, 0)),
                kind: str(mm.kind, 'event') as RunAgent['memory'][number]['kind'],
                text: str(mm.text),
                ts: num(mm.ts, Date.now()),
              }
            })
        : []
      return {
        ...tpl,
        x: Math.max(0, Math.round(num(e.x, tpl.x))),
        y: Math.max(0, Math.round(num(e.y, tpl.y))),
        spawnTick: Math.round(num(e.spawnTick, 0)),
        origin: e.origin === 'user' ? 'user' : 'preset',
        memory,
        lastUpdateTick: Math.round(num(e.lastUpdateTick, 0)),
        stepsTaken: Math.round(num(e.stepsTaken, 0)),
      } satisfies RunAgent
    })
    .filter((a): a is RunAgent => a !== undefined)
  const directives: Directive[] = Array.isArray(raw.directives)
    ? raw.directives
        .filter((d) => d !== null && typeof d === 'object')
        .slice(-200)
        .map((d) => {
          const e = d as Record<string, unknown>
          return {
            id: str(e.id, shortId('dir')),
            agentId: str(e.agentId),
            text: str(e.text),
            consumed: e.consumed === true,
            createdAt: num(e.createdAt, Date.now()),
            consumedAtTick: e.consumedAtTick === undefined ? undefined : Math.round(num(e.consumedAtTick, 0)),
          }
        })
        .filter((d) => d.agentId !== '' && d.text !== '')
    : []
  return {
    sandboxId,
    tick: Math.max(0, Math.round(num(raw.tick, 0))),
    agents,
    events: Array.isArray(raw.events) ? (raw.events as RunState['events']).slice(-3000) : [],
    directives,
    relations: Array.isArray(raw.relations) ? (raw.relations as RunState['relations']).slice(-400) : [],
    worldState: normalizeState(raw.worldState),
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
  }
}

// ── 沙盒库 ───────────────────────────────────────────────────────────────

/**
 * 读取全部发货镜像（assets/ 下的 *.json）。
 *
 * 目录里可能有多种镜像（整镇、室内……），全都要能种进去——所以按目录列举而不是
 * 写死文件名。**排除 style-preview / pack 之类的素材目录**：那里也有 json（清单），
 * 但它们是构建中间产物，不是沙盒。
 */
async function readMirrorAssets(): Promise<unknown[]> {
  const here = dirname(fileURLToPath(import.meta.url))
  const dirs = [join(here, '..', 'assets'), join(here, '..', '..', 'assets')]
  const out: unknown[] = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const names = await readdir(dir).catch(() => [] as string[])
    for (const name of names.sort()) {
      if (!name.endsWith('.json')) continue
      const parsed = await readJson<unknown>(join(dir, name))
      if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { places?: unknown }).places)) {
        out.push(parsed)
      }
    }
    if (out.length > 0) {
      log(`loaded ${out.length} sandbox mirror(s) from ${dir}`)
      break
    }
  }
  return out
}

export class SandboxStore {
  private cache: Sandbox[] | null = null
  private mirrors: Sandbox[] | null = null

  /**
   * 首次运行时把发货镜像种进用户目录。
   *
   * 现在有**两个**镜像（整镇的 smallville、室内的 house），所以不能再"发现目录非空就跳过"：
   * 那样后加的镜像永远进不来。改成**逐个镜像检查**——缺哪个补哪个，已有的不动
   * （玩家可能已经改过那份副本）。
   */
  async ensureSeed(): Promise<void> {
    await mkdir(sandboxDir(), { recursive: true })
    await mkdir(runDir(), { recursive: true })
    const existing = new Set((await readdir(sandboxDir()).catch(() => [] as string[])).filter((n) => n.endsWith('.json')))
    const mirrors = await this.mirrorSandboxes()
    let seeded = 0
    for (const mirror of mirrors) {
      const file = `${mirror.id}.json`
      if (existing.has(file)) continue
      await writeJson(join(sandboxDir(), file), mirror)
      seeded += 1
      log(`seeded sandbox mirror: ${mirror.id} (${mirror.places.length} places / ${mirror.agents.length} agents)`)
    }
    if (seeded === 0) log('all sandbox mirrors already present')
  }

  /** 单个镜像（用于「恢复出厂」）。 */
  async mirrorSandbox(id = 'smallville'): Promise<Sandbox> {
    const all = await this.mirrorSandboxes()
    return all.find((s) => s.id === id) ?? all[0]
  }

  /** 全部发货镜像：assets/ 下的 *.json（缺文件时退到内联兜底）。 */
  async mirrorSandboxes(): Promise<Sandbox[]> {
    if (this.mirrors !== null) return this.mirrors
    const files = await readMirrorAssets()
    const out: Sandbox[] = []
    for (const asset of files) {
      const mirror = normalizeSandbox(asset, 'sandbox')
      mirror.id = typeof (asset as { id?: string }).id === 'string' ? String((asset as { id: string }).id) : mirror.id
      mirror.builtin = true
      mirror.createdAt = Date.now()
      mirror.updatedAt = Date.now()
      out.push(mirror)
    }
    if (out.length === 0) {
      const fallback = normalizeSandbox(INLINE_SMALLVILLE, 'smallville')
      fallback.id = 'smallville'
      fallback.builtin = true
      out.push(fallback)
      log('no mirror asset found on disk — using the inline fallback')
    }
    this.mirrors = out
    return out
  }

  async list(force = false): Promise<Sandbox[]> {
    if (this.cache !== null && !force) return this.cache
    await this.ensureSeed()
    const names = await readdir(sandboxDir()).catch(() => [] as string[])
    const out: Sandbox[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const parsed = await readJson<unknown>(join(sandboxDir(), name))
      if (parsed === undefined) continue
      out.push(normalizeSandbox(parsed, name.replace(/\.json$/, '')))
    }
    out.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name, 'zh') : a.builtin ? -1 : 1))
    this.cache = out
    return out
  }

  async get(id: string): Promise<Sandbox | undefined> {
    if (!SANDBOX_ID_RE.test(id)) return undefined
    const all = await this.list()
    return all.find((s) => s.id === id)
  }

  async save(sandbox: Sandbox): Promise<Sandbox> {
    const clean = normalizeSandbox(sandbox, sandbox.id)
    if (!SANDBOX_ID_RE.test(clean.id)) throw new Error(`沙盒 id 非法：${clean.id}（只允许字母数字与 . _ -，以字母数字开头）`)
    clean.updatedAt = Date.now()
    await writeJson(join(sandboxDir(), `${clean.id}.json`), clean)
    this.cache = null
    return clean
  }

  /** 另存为副本（id 冲突时自动加后缀），用于「从复刻镜像派生自己的小镇」。 */
  async duplicate(id: string, newId: string, name?: string): Promise<Sandbox> {
    const source = await this.get(id)
    if (source === undefined) throw new Error(`找不到沙盒 ${id}`)
    let target = newId
    let n = 2
    while ((await this.get(target)) !== undefined) {
      target = `${newId}-${n}`
      n += 1
    }
    const copy: Sandbox = {
      ...structuredClone(source),
      id: target,
      name: name ?? `${source.name} 副本`,
      builtin: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    return this.save(copy)
  }

  async remove(id: string): Promise<void> {
    if (!SANDBOX_ID_RE.test(id)) throw new Error(`沙盒 id 非法：${id}`)
    const sandbox = await this.get(id)
    if (sandbox?.builtin === true) throw new Error('发货镜像不可删除；请先「另存为副本」再改')
    await rm(join(sandboxDir(), `${id}.json`), { force: true })
    this.cache = null
  }

  /**
   * 用一个沙盒开局：新鲜运行态；智能体取自沙盒模板。
   * `spawn` 允许用户开一局时只带 N 个智能体进来（需求 3 的"加入数量"）。
   */
  newRun(sandbox: Sandbox, spawn?: { count?: number; ids?: string[] }): RunState {
    const tick = sandbox.startTick ?? 0
    const chosen = sandbox.agents.filter((a) => spawn?.ids === undefined || spawn.ids.includes(a.id))
    const limited = spawn?.count === undefined ? chosen : chosen.slice(0, Math.max(0, spawn.count))
    const agents: RunAgent[] = limited.map((a) => ({
      ...structuredClone(a),
      spawnTick: tick,
      origin: 'preset',
      memory: [
        {
          tick,
          kind: 'summary' as const,
          text: a.backstory === '' ? `${a.name}在镇上醒来，今天是普通的一天。` : a.backstory,
          ts: Date.now(),
        },
      ],
      lastUpdateTick: tick,
      stepsTaken: 0,
    }))
    return {
      sandboxId: sandbox.id,
      tick,
      agents,
      events: [
        {
          id: shortId('ev'),
          tick,
          ts: Date.now(),
          kind: 'system',
          actor: 'system',
          actorName: '世界',
          text: `${sandbox.name} 开局：${agents.length} 个智能体入场${sandbox.attribution === undefined ? '' : `（${sandbox.attribution}）`}。`,
        },
      ],
      directives: [],
      relations: structuredClone(sandbox.relations),
      worldState: { 天气: '晴', 时辰: '上午' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
  }
}

// ── 运行态 ───────────────────────────────────────────────────────────────

export class RunStore {
  // 不用 TS 的参数属性：`node --experimental-strip-types` 的 strip-only 模式
  // 不支持它，而 selftest 直接跑 .ts（写法受限是为了让自检能跑）。
  private readonly workspace?: string

  constructor(workspace?: string) {
    this.workspace = workspace
  }

  private fileFor(sandboxId: string): string {
    return join(runDir(this.workspace), `${sandboxId}.json`)
  }

  async load(sandboxId: string): Promise<RunState | undefined> {
    if (!SANDBOX_ID_RE.test(sandboxId)) return undefined
    const parsed = await readJson<unknown>(this.fileFor(sandboxId))
    if (parsed === undefined) return undefined
    return normalizeRun(parsed, sandboxId)
  }

  async save(run: RunState): Promise<void> {
    run.updatedAt = Date.now()
    // 事件流只保留最近 3000 条：一次长推演会走到十万级，全量落盘会让
    // 每次写入都变成几十兆的同步开销，而复盘真正会看的只有近段。
    if (run.events.length > 3000) run.events = run.events.slice(-3000)
    await writeJson(this.fileFor(run.sandboxId), run)
  }

  async remove(sandboxId: string): Promise<void> {
    if (!SANDBOX_ID_RE.test(sandboxId)) return
    await rm(this.fileFor(sandboxId), { force: true })
  }
}

// ── 步进设置（需求 6）───────────────────────────────────────────────────

export class StepStore {
  private config: StepConfig = { ...DEFAULT_STEP_CONFIG }

  private readonly workspace?: string

  constructor(workspace?: string) {
    this.workspace = workspace
  }

  private file(): string {
    return join(dataHome(), 'step', `${bucketOf(this.workspace)}.json`)
  }

  async load(): Promise<StepConfig> {
    const parsed = await readJson<Partial<StepConfig>>(this.file())
    this.config = clampStepConfig(parsed ?? this.config)
    return this.config
  }

  get(): StepConfig {
    return this.config
  }

  async set(patch: Partial<StepConfig>): Promise<StepConfig> {
    this.config = clampStepConfig({ ...this.config, ...patch })
    await writeJson(this.file(), this.config)
    return this.config
  }
}

