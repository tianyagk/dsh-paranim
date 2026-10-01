/**
 * 瓦片图的读写与查询——**纯数据，不碰像素**，所以 host 与 client 都能用。
 *
 * 数据结构见 model.ts：每层是一串格引用（`"tilesetId:col,row"`），
 * 通行性来自图集里那些**人标过的**注释。这个文件是"地图数据的唯一解释口径"——
 * 移动判定、渲染、编辑器都从这里问，而不是各自解析一遍字符串。
 */
import type { MapLayers, SandboxMap, StateValue, TileLayer, TileNote, Tileset } from './model.ts'

/** 格引用的解析结果。 */
export interface ResolvedTile {
  tileset: Tileset
  col: number
  row: number
  /** 图集里对这一格的注释；没标过就是 undefined。 */
  note: TileNote | undefined
}

export function cellIndex(x: number, y: number, width: number): number {
  return y * width + x
}

export function noteKey(col: number, row: number): string {
  return `${col},${row}`
}

export function makeTileRef(tilesetId: string, col: number, row: number): string {
  return `${tilesetId}:${col},${row}`
}

/** 空的一层。 */
export function emptyLayer(width: number, height: number): TileLayer {
  return { cells: Array.from({ length: width * height }, () => null) }
}

export function emptyLayers(width: number, height: number): MapLayers {
  return {
    background: emptyLayer(width, height),
    structure: emptyLayer(width, height),
    object: emptyLayer(width, height),
  }
}

export function findTileset(map: SandboxMap, id: string): Tileset | undefined {
  return map.tilesets.find((t) => t.id === id)
}

/** 解析一格里的引用；格为空、图集不存在、坐标越界都返回 undefined。 */
export function resolveRef(map: SandboxMap, ref: string | null | undefined): ResolvedTile | undefined {
  if (ref === null || ref === undefined || ref === '') return undefined
  const colon = ref.indexOf(':')
  if (colon < 0) return undefined
  const setId = ref.slice(0, colon)
  const rest = ref.slice(colon + 1)
  const comma = rest.indexOf(',')
  if (comma < 0) return undefined
  const col = Number(rest.slice(0, comma))
  const row = Number(rest.slice(comma + 1))
  if (!Number.isInteger(col) || !Number.isInteger(row)) return undefined
  const tileset = findTileset(map, setId)
  if (tileset === undefined) return undefined
  return { tileset, col, row, note: tileset.notes[noteKey(col, row)] }
}

export function tileAt(map: SandboxMap, layer: TileLayer, x: number, y: number): ResolvedTile | undefined {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined
  return resolveRef(map, layer.cells[cellIndex(x, y, map.width)])
}

/** 某一格里挂着状态槽（object 层用）。 */
export function stateAt(map: SandboxMap, x: number, y: number): Record<string, unknown> | undefined {
  return map.layers.object.states?.[String(cellIndex(x, y, map.width))]
}

/**
 * 一格的**通行性**：从下往上问，最后给出唯一答案。
 *
 * 顺序是刻意的——上层的实物优先于下层的地形：
 *  · structure 上有东西且判定为 block → 挡（墙体优先，哪怕地面是草地）
 *  · object 上有门 → 门本身不挡（开门才能进出，是否开由状态决定）
 *  · 没有任何东西 → 看 background 的地形
 *
 * 返回值直接给移动规则用，所以这里必须能对任何一格给出确定结论。
 */
export type Pass = 'walk' | 'block' | 'water' | 'lava'

export function passAt(map: SandboxMap, x: number, y: number): Pass {
  const structure = tileAt(map, map.layers.structure, x, y)
  if (structure?.note?.pass === 'block') return 'block'

  const object = tileAt(map, map.layers.object, x, y)
  if (object?.note?.use === 'door') {
    /**
     * 门开着才过得去——这是"与门互动后开门进出"这条需求落地的唯一地方。
     * 状态挂在格子自己身上（见 TileLayer.states），所以门的位置和它的开合
     * 永远指向同一格，不会出现"门画在这里、状态记在别处"的错位。
     * 没写过状态时按**开着**处理：镜像刚摆好还没人碰过，不该自封门户。
     */
    const st = stateAt(map, x, y)
    return st?.open === false ? 'block' : 'walk'
  }
  // 窗只能看，不能穿
  if (object?.note?.use === 'window') return 'block'

  const ground = tileAt(map, map.layers.background, x, y)
  const groundPass = ground?.note?.pass
  if (groundPass !== undefined && groundPass !== 'walk') return groundPass
  return 'walk'
}

/** 这一格是不是门（用于"与门互动后开关"的判定）。 */
export function isDoorAt(map: SandboxMap, x: number, y: number): boolean {
  return tileAt(map, map.layers.object, x, y)?.note?.use === 'door'
}

/** 该沙盒里所有已标注的瓦片，按 "图集:格" 列出（编辑器与统计用）。 */
export function annotatedTiles(map: SandboxMap): Array<{ tileset: Tileset; col: number; row: number; note: TileNote }> {
  const out: Array<{ tileset: Tileset; col: number; row: number; note: TileNote }> = []
  for (const tileset of map.tilesets) {
    for (const [key, note] of Object.entries(tileset.notes)) {
      const [col, row] = key.split(',').map(Number)
      if (Number.isInteger(col) && Number.isInteger(row)) out.push({ tileset, col, row, note })
    }
  }
  return out
}

/** 图集能切出多少格。 */
export function gridOf(tileset: Pick<Tileset, 'imageW' | 'imageH' | 'tileW' | 'tileH' | 'margin' | 'spacing'>): { cols: number; rows: number } {
  const cols = Math.max(0, Math.floor((tileset.imageW - tileset.margin * 2 + tileset.spacing) / (tileset.tileW + tileset.spacing)))
  const rows = Math.max(0, Math.floor((tileset.imageH - tileset.margin * 2 + tileset.spacing) / (tileset.tileH + tileset.spacing)))
  return { cols, rows }
}

/** 某一格在图片里的像素位置（切片器预览与渲染都要用同一套算法）。 */
export function tileOrigin(tileset: Pick<Tileset, 'tileW' | 'tileH' | 'margin' | 'spacing'>, col: number, row: number): { x: number; y: number } {
  return {
    x: tileset.margin + col * (tileset.tileW + tileset.spacing),
    y: tileset.margin + row * (tileset.tileH + tileset.spacing),
  }
}

/** 统计每层有多少格有东西（界面显示与自检用）。 */
export function layerCounts(map: SandboxMap): Record<keyof MapLayers, number> {
  const count = (layer: TileLayer): number => layer.cells.reduce((n, c) => n + (c === null ? 0 : 1), 0)
  return {
    background: count(map.layers.background),
    structure: count(map.layers.structure),
    object: count(map.layers.object),
  }
}

// ── 物件视图 ──────────────────────────────────────────────────────────────
//
// 物件不再是独立的一串对象——它就是 object 层上的某一格。但引擎需要一个
// "可以遍历、有名字、有状态"的东西（生成观察、判定交互、距离护栏），
// 所以这里把格**看成**物件。好处是两边永远一致：把桌子搬走就是清空那格，
// 不存在"物件列表里还有、地图上没了"这种不同步。

export interface TileObject {
  /** 稳定 id：由格坐标推出。状态挂在格上，所以 id 也由格决定。 */
  id: string
  x: number
  y: number
  name: string
  state: Record<string, StateValue>
  /** 有注释的东西才算物件——没标过的瓦片不知道是什么，不能拿来做交互。 */
  interactive: boolean
  note: TileNote
}

export function objectIdAt(x: number, y: number): string {
  return `obj:${x},${y}`
}

/** 从 id 反解格坐标；不是本格式就返回 undefined。 */
export function positionOfObjectId(id: string): { x: number; y: number } | undefined {
  const m = /^obj:(\d+),(\d+)$/.exec(id)
  if (m === null) return undefined
  return { x: Number(m[1]), y: Number(m[2]) }
}

/** 把 object 层里有注释的格全部当作物件列出来。 */
export function objectsOf(map: SandboxMap): TileObject[] {
  const out: TileObject[] = []
  const layer = map.layers.object
  for (let i = 0; i < layer.cells.length; i += 1) {
    const t = resolveRef(map, layer.cells[i])
    if (t === undefined || t.note === undefined) continue
    const x = i % map.width
    const y = Math.floor(i / map.width)
    out.push({
      id: objectIdAt(x, y),
      x,
      y,
      name: t.note.name ?? `${t.tileset.name} ${t.col},${t.row}`,
      state: layer.states?.[String(i)] ?? {},
      interactive: t.note.use !== undefined || t.note.name !== undefined,
      note: t.note,
    })
  }
  return out
}

/** 改一格物件的状态（写进 TileLayer.states）。 */
export function setObjectState(map: SandboxMap, x: number, y: number, patch: Record<string, StateValue | null>): string[] {
  const layer = map.layers.object
  const key = String(cellIndex(x, y, map.width))
  const states = layer.states ?? (layer.states = {})
  const cur: Record<string, StateValue> = { ...(states[key] ?? {}) }
  const changed: string[] = []
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      if (k in cur) { delete cur[k]; changed.push(`${k} 已清除`) }
      continue
    }
    if (cur[k] === v) continue
    changed.push(`${k}：${String(cur[k] ?? '（无）')} → ${String(v)}`)
    cur[k] = v
  }
  if (Object.keys(cur).length === 0) delete states[key]
  else states[key] = cur
  return changed
}

/** 解析引用字符串（"setId:col,row"）；格式不对返回 undefined。 */
export function parseRef(ref: string): { setId: string; col: number; row: number } | undefined {
  const m = /^([A-Za-z0-9._-]{1,64}):(\d{1,3}),(\d{1,3})$/.exec(ref)
  if (m === null) return undefined
  return { setId: m[1], col: Number(m[2]), row: Number(m[3]) }
}

/**
 * 内置图集的登记（像素在客户端包里，只存元信息）。
 *
 * tiny-town 等 6 张的尺寸与 sheetData.ts 一致；其余 id 给一个占位登记
 * （用户图集要带 data URI 走 /sandbox 上传，这里不处理）。
 */
const BUILTIN_SIZES: Record<string, { w: number; h: number }> = {
  'tiny-town': { w: 192, h: 176 },
  'tiny-farm': { w: 192, h: 176 },
  'tiny-battle': { w: 288, h: 176 },
  'onebit': { w: 784, h: 176 },
  'city': { w: 672, h: 448 },
  'characters': { w: 864, h: 96 },
}

export function makeBuiltinTileset(id: string): Tileset {
  const size = BUILTIN_SIZES[id] ?? { w: 256, h: 256 }
  return {
    id,
    name: id,
    image: '',
    imageW: size.w,
    imageH: size.h,
    tileW: 16,
    tileH: 16,
    margin: 0,
    spacing: 0,
    notes: {},
  }
}

/**
 * 三个图层的中文名。
 *
 * 放在共享层而不是各自抄一份：客户端界面与服务端事件流文案用的是同一套
 * 说法，分开写就会像之前那样一个带英文后缀、一个不带，改一处忘一处。
 */
export const LAYER_LABEL: Record<'background' | 'structure' | 'object', string> = {
  background: '地图图层',
  structure: '建筑图层',
  object: '物件图层',
}

/** 图层名的类型守卫（入参可能来自请求体）。 */
export function isLayerName(value: unknown): value is 'background' | 'structure' | 'object' {
  return value === 'background' || value === 'structure' || value === 'object'
}
