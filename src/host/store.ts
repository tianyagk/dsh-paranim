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
import { mkdir, readdir, readFile, rename, rm, stat as fsStat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ATTR_IDS,
  DEFAULT_STEP_CONFIG,
  clampAttr,
  clampStepConfig,
  MOOD_DEFAULT,
  normalizeAttrs,
  normalizeMood,
  shortId,
  toStateValue,
  type Attrs,
  type Directive,
  type RunAgent,
  type RunState,
  type Sandbox,
  type SandboxAgent,
  type StateValue,
  type StepConfig,
  type WorldObject,
  type SandboxMap,
  type TileLayer,
  type TileNote,
  type Tileset,
} from '../shared/model.ts'
import { log } from './context.ts'
import { FALLBACK_GROUND, INLINE_SMALLVILLE } from './fallback.ts'

const SANDBOX_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
/** 种子版本戳文件名（原本是内联字面量，删除标记也要写它，抽成常量）。 */
const SEED_STAMP_FILE = '.seed-version.json'
/** 版本戳里的哨兵值：这一份被用户删掉了，别再种回来。 */
const DELETED_STAMP = '__deleted__'

export function dataHome(): string {
  if (injectedHome !== undefined) return injectedHome
  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(base, 'dsh-paranim')
}

export function sandboxDir(): string {
  return join(dataHome(), 'sandboxes')
}

/**
 * 数据根目录的可选注入点。
 *
 * 路径此前只能由 DSH_HOME 全局决定，于是任何"要真落盘"的验证都只能跑在玩家
 * 自己的 ~/.dsh 上——改一个字段就污染一次真实的沙盒库。给它一个注入口之后，
 * 自检可以在临时目录里跑完整的读写回路。
 */
let injectedHome: string | undefined
export function setDataHomeForTest(home: string | undefined): void {
  injectedHome = home
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
  /**
   * 临时文件名必须**每次都不同**。
   *
   * 原来是 `${pid}-${Date.now()}`：同一个进程在同一毫秒内发起两次写就会撞名，
   * 后者覆盖前者的 tmp，前者 rename 时那个文件已经不在——报 ENOENT，
   * 整个请求 500。并发涂抹正好稳定地落进这个窗口。
   * 带上随机段之后，撞名在概率上不可能。
   */
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${shortId('w')}`
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
    /**
     * **地标不带状态。**
     *
     * 地标是"某个地方在哪儿"这个逻辑概念，物件状态属于 object 层上的一格
     * （见 tilemap 的 TileLayer.states）。旧数据里地标带着 `light=开`、
     * `面团=已排气并分成三份…` 这类字段——那是更早的模型把房间当成物件时
     * 留下的，现在的表现是右键点一块地标会弹出"修改物体状态"，而里面那些
     * 名目既不属于地图上任何东西、也改不动任何东西（用户反馈的
     * "世界里未识别物体名称"）。
     */
    state: kind === 'place' ? {} : normalizeState(o.state),
    interactive: o.interactive === undefined ? true : o.interactive !== false,
    affordances: Array.isArray(o.affordances) ? o.affordances.filter((v) => typeof v === 'string').slice(0, 12) : undefined,
    tags: Array.isArray(o.tags) ? o.tags.filter((v) => typeof v === 'string').slice(0, 12) : undefined,
    // 屋顶族可以由沙盒显式指定（Smallville 镜像按原版建筑族写好了每处地点）。
    // 归一化把它丢掉，渲染层就只能回落到"按 tags 推导"，同族地点会全部同色。
    roofSlot: typeof o.roofSlot === 'string' ? o.roofSlot : undefined,
    sprite: typeof o.sprite === 'string' ? o.sprite : undefined,
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
    // 心情缺省用 MOOD_DEFAULT：新角色不该是"没有心情"，否则界面上会空一块
    mood: normalizeMood(a.mood ?? MOOD_DEFAULT),
    x: Math.max(0, Math.min(mapW, Math.round(num(a.x, mapW / 2)))),
    y: Math.max(0, Math.min(mapH, Math.round(num(a.y, mapH / 2)))),
    attrs,
    model: model !== null && (model.provider === '' || model.model === '') ? null : model,
    plan: Array.isArray(a.plan) ? a.plan.filter((v) => typeof v === 'string').slice(0, 24) : [],
    inventory: Array.isArray(a.inventory) ? a.inventory.filter((v) => typeof v === 'string').slice(0, 24) : [],
    color: str(a.color, '#7aa2f7'),
    portrait: str(a.portrait, '🙂'),
    // 自定义外观（瓦片引用）。非法引用一律丢掉——渲染层拿到解析不了的字符串
    // 只会静默画成默认角色，而"设了却没生效"比"没设"更难查。
    sprite: typeof a.sprite === 'string' && /^[A-Za-z0-9._-]{1,64}:\d{1,3},\d{1,3}$/.test(a.sprite) ? a.sprite : undefined,
  }
}

/**
 * 图集归一化。
 *
 * `notes` 是**人标进去的**瓦片语义，所以这里只做形状校验与裁剪，不做任何
 * 推断——早期版本用"按平均色反查格子"来猜每格是什么，那对纯色地面有效，
 * 对有形状的物件完全无效，于是出现了把路面当树画出来这类错误。
 */
export function normalizeTileset(input: unknown, fallbackId: string): Tileset | undefined {
  const e = (input ?? {}) as Record<string, unknown>
  const id = (str(e.id).trim() || fallbackId).slice(0, 64)
  if (id === '') return undefined
  const notes: Record<string, TileNote> = {}
  if (e.notes !== null && typeof e.notes === 'object' && !Array.isArray(e.notes)) {
    for (const [key, value] of Object.entries(e.notes as Record<string, unknown>)) {
      if (!/^\d{1,3},\d{1,3}$/.test(key)) continue
      if (value === null || typeof value !== 'object') continue
      const n = value as Record<string, unknown>
      const note: TileNote = {}
      if (typeof n.name === 'string' && n.name.trim() !== '') note.name = n.name.trim().slice(0, 40)
      if (n.pass === 'walk' || n.pass === 'block' || n.pass === 'water' || n.pass === 'lava') note.pass = n.pass
      if (n.use === 'door' || n.use === 'window' || n.use === 'switch') note.use = n.use
      // 空注释不存：一条 {} 和"没标过"是一回事，留着只会让判断多一种情况
      if (Object.keys(note).length > 0) notes[key] = note
    }
  }
  const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = Math.round(num(v, dflt))
    return Math.max(lo, Math.min(hi, n))
  }
  return {
    id,
    name: str(e.name, id).slice(0, 60),
    // 内置图集留空串：像素在客户端包里，内嵌一份会让每个沙盒都重复几百 KB
    image: typeof e.image === 'string' && e.image.startsWith('data:image/') ? e.image : '',
    imageW: clampInt(e.imageW, 1, 8192, 256),
    imageH: clampInt(e.imageH, 1, 8192, 256),
    tileW: clampInt(e.tileW, 2, 256, 16),
    tileH: clampInt(e.tileH, 2, 256, 16),
    margin: clampInt(e.margin, 0, 64, 0),
    spacing: clampInt(e.spacing, 0, 64, 1),
    notes,
  }
}

/** 一层瓦片图：长度对齐到 width×height，非法引用一律读成"空格"。 */
function normalizeTileLayer(input: unknown, size: number): TileLayer {
  const e = (input ?? {}) as Record<string, unknown>
  const raw = Array.isArray(e.cells) ? e.cells : []
  const cells: Array<string | null> = new Array(size).fill(null)
  for (let i = 0; i < Math.min(size, raw.length); i += 1) {
    const v = raw[i]
    // 形如 "set-id:12,34"；id 允许字母数字与 . _ -
    if (typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}:\d{1,3},\d{1,3}$/.test(v)) cells[i] = v
  }
  const out: TileLayer = { cells }
  if (e.states !== null && typeof e.states === 'object' && !Array.isArray(e.states)) {
    const states: Record<string, Record<string, StateValue>> = {}
    for (const [key, value] of Object.entries(e.states as Record<string, unknown>)) {
      const idx = Number(key)
      if (!Number.isInteger(idx) || idx < 0 || idx >= size) continue
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue
      const state: Record<string, StateValue> = {}
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        const sv = toStateValue(v)
        if (k !== '' && k.length <= 40 && sv !== undefined) state[k] = sv
      }
      if (Object.keys(state).length > 0) states[key] = state
    }
    if (Object.keys(states).length > 0) out.states = states
  }
  return out
}

export function normalizeSandbox(input: unknown, fallbackId = 'sandbox'): Sandbox {
  const raw = (input ?? {}) as Record<string, unknown>
  const mapRaw = (raw.map ?? {}) as Record<string, unknown>
  const width = Math.max(20, Math.min(600, Math.round(num(mapRaw.width, 140))))
  const height = Math.max(20, Math.min(600, Math.round(num(mapRaw.height, 100))))
  /**
   * 地图 = 图集 + 三图层。
   *
   * 每层对齐到 width×height，越界与非法的格一律读成"空的"——地图尺寸改了
   * 之后旧数据里多出来的格不能留，否则渲染时会画到图外去。
   */
  const tilesets = (Array.isArray(mapRaw.tilesets) ? mapRaw.tilesets : [])
    .slice(0, 16)
    .map((t, i) => normalizeTileset(t, `set-${i + 1}`))
    .filter((t): t is Tileset => t !== undefined)
  const cellCount = width * height
  const layersRaw = (mapRaw.layers ?? {}) as Record<string, unknown>
  const map: SandboxMap = {
    width,
    height,
    tilesets,
    layers: {
      background: normalizeTileLayer(layersRaw.background, cellCount),
      structure: normalizeTileLayer(layersRaw.structure, cellCount),
      object: normalizeTileLayer(layersRaw.object, cellCount),
    },
  }

  const places = (Array.isArray(raw.places) ? raw.places : [])
    .map((p) => normalizeObject(p, width, height, 'place'))
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
    mirrorVersion: typeof raw.mirrorVersion === 'string' ? raw.mirrorVersion : undefined,
    createdAt: num(raw.createdAt, Date.now()),
    updatedAt: num(raw.updatedAt, Date.now()),
    map,
    places,
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
      if (!name.endsWith('.json') || name.startsWith('.')) continue
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
  private cacheFingerprint = ''
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
    // 记下每个镜像种下去的是哪一版。**不能只看"文件在不在"**：
    // 镜像是随插件升级的（例如 smallville 从 19 地点重建为 40 地点 + 原版路网），
    // 只看存在性的话，老玩家目录里那份旧副本永远不会被更新——升级了却看不到变化。
    const stamps = await readJson<Record<string, string>>(join(sandboxDir(), SEED_STAMP_FILE)) ?? {}
    let seeded = 0
    for (const mirror of mirrors) {
      const file = `${mirror.id}.json`
      const version = mirror.mirrorVersion ?? ''
      const present = existing.has(file)
      // 用户删过的镜像不再种回来（见 remove 里的 DELETED_STAMP）
      if (!present && stamps[mirror.id] === DELETED_STAMP) continue
      if (present && stamps[mirror.id] === version) continue
      if (present) {
        // 玩家改过的副本不覆盖：那已经是他的沙盒，不是我们的发货镜像。
        const current = normalizeSandbox(await readJson<Record<string, unknown>>(join(sandboxDir(), file)) ?? {}, mirror.id)
        if (current.builtin !== true) {
          log(`keep user-modified sandbox ${mirror.id} (mirror version ${version} not applied)`)
          stamps[mirror.id] = version
          continue
        }
      }
      await writeJson(join(sandboxDir(), file), mirror)
      stamps[mirror.id] = version
      seeded += 1
      log(`seeded sandbox mirror: ${mirror.id} v${version} (${mirror.places.length} places / ${mirror.agents.length} agents)`)
    }
    if (seeded > 0) await writeJson(join(sandboxDir(), SEED_STAMP_FILE), stamps)
    // 不再输出"already present"：ensureSeed 每次 list() 都会跑，而"镜像已经在
    // 用户目录里"是**正常路径**，每几秒刷一行只会把真正有用的日志淹掉。
    // 真正种入镜像时上面那行会说话——那才是需要被看见的事。
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
      /**
       * 兜底小镇不内联地形（那会让产物从 300KB 涨到 1MB），所以这里铺一层
       * 默认地面——不铺的话降级时地图是一片深色，能站人但看不出是座镇子，
       * 而兜底的意义正是"镜像读不到时仍然像样"。
       *
       * 用 FALLBACK_GROUND 这个显式常量而不是按名字在 notes 里找"草地"：
       * 名字是给人看的，会被改；引用是机器用的。
       */
      const set = fallback.map.tilesets[0]
      if (set !== undefined && set.notes[FALLBACK_GROUND] !== undefined) {
        fallback.map.layers.background.cells.fill(`${set.id}:${FALLBACK_GROUND}`)
      }
      out.push(fallback)
      log('no mirror asset found on disk — using the inline fallback')
    }
    this.mirrors = out
    return out
  }

  /**
   * 列出沙盒。
   *
   * 缓存**必须跟着目录指纹走**，不能只靠 `force`：沙盒是明文文件，玩家会被明确告知
   * "可以直接手改"，而手改的常见形式就是丢一个新 .json 进目录，或者在编辑器里改完保存。
   * 上一版缓存一旦建好就不再失效，路由又不带 force，于是**新丢进去的沙盒永远不出现**
   * （表现为"我明明放进去了，界面里没有"）——这正是本轮实测撞上的。
   */
  async list(force = false): Promise<Sandbox[]> {
    if (this.cache !== null && !force) {
      const fingerprint = await this.directoryFingerprint()
      if (fingerprint === this.cacheFingerprint) return this.cache
    }
    await this.ensureSeed()
    const names = await readdir(sandboxDir()).catch(() => [] as string[])
    const out: Sandbox[] = []
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const parsed = await readJson<unknown>(join(sandboxDir(), name))
      if (parsed === undefined) continue
      out.push(normalizeSandbox(parsed, name.replace(/\.json$/, '')))
    }
    out.sort((a, b) => (a.builtin === b.builtin ? a.name.localeCompare(b.name, 'zh') : a.builtin ? -1 : 1))
    this.cache = out
    this.cacheFingerprint = await this.directoryFingerprint()
    return out
  }

  /** 目录指纹：文件名 + mtimeMs + 大小。任何增删改都会让缓存失效。 */
  private async directoryFingerprint(): Promise<string> {
    const names = await readdir(sandboxDir()).catch(() => [] as string[])
    const parts: string[] = []
    for (const name of names.sort()) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const info = await fsStat(join(sandboxDir(), name)).catch(() => undefined)
      parts.push(info === undefined ? `${name}:?` : `${name}:${info.mtimeMs}:${info.size}`)
    }
    return parts.join('|')
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
    await rm(join(sandboxDir(), `${id}.json`), { force: true })
    /**
     * 记住"这一份被删过"，否则下次启动 ensureSeed 会把它当"缺失的镜像"
     * 重新种回来——用户删了它又出现，看起来就像删除没生效。
     */
    const stamps = await readJson<Record<string, string>>(join(sandboxDir(), SEED_STAMP_FILE)) ?? {}
    stamps[id] = DELETED_STAMP
    await writeJson(join(sandboxDir(), SEED_STAMP_FILE), stamps)
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

