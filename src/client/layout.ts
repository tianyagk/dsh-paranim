/**
 * 小镇布局：把地标与物件**推导成一张有结构的地图**，而不是把每个占地随机填满。
 *
 * 为什么需要这一层：上一版渲染是"每个地标 = 一整个矩形用随机瓦片铺满"，
 * 结果必然是满屏格子的堆砌——矩形填色本身不构成建筑。真正的镇子需要三个层次：
 *
 *   1. **地形**：草地/土/石板/水，大面积连续，靠少量变体做纹理而不是撒点
 *   2. **路网**：显式把地标连起来。Smallville 的特点就是那条贯穿全镇的黄泥路，
 *      没有它，房子只是散落在草地上的方块
 *   3. **建筑**：每个地标是**一栋有轮廓的房子**——墙围一圈、屋顶在墙内、门朝路、
 *      窗按间距排；而不是把屋顶瓦片铺满整个占地
 *
 * 这一层是纯函数：同样的沙盒必然得到同样的地图，可以脱离浏览器单测。
 */
import type { Sandbox, WorldObject } from '../shared/model.ts'

export type Terrain = 'grass' | 'grassAlt' | 'dirt' | 'stone' | 'water' | 'sand' | 'field'

export interface BuildingSpec {
  place: WorldObject
  /** 外框（含墙），格坐标，闭区间。 */
  left: number
  top: number
  right: number
  bottom: number
  /** 屋顶覆盖的行区间（含端点）：屋顶在墙内，最外一圈始终是墙。 */
  roofTop: number
  roofBottom: number
  /** 门的格坐标（朝向下方的路）。 */
  doorX: number
  doorY: number
  /** 屋顶族的语义名（对应 mapStyle.ts 的槽位）。 */
  roofSlot: string
  /** 窗户位置。 */
  windows: Array<{ x: number; y: number }>
}

export interface TownLayout {
  width: number
  height: number
  /** 行优先的地形表。 */
  terrain: Terrain[][]
  buildings: BuildingSpec[]
  /** 路网覆盖的格子（用于给建筑指门）。 */
  road: boolean[][]
}

function hash2(x: number, y: number, salt = 0): number {
  let h = (Math.round(x) * 374761393 + Math.round(y) * 668265263 + salt * 2246822519) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** 屋顶族：配色即语义（暖=社交/餐饮、蓝=商业/学术、绿=公共/户外、默认=住宅）。 */
export function roofSlotOf(place: WorldObject): string {
  const tags = (place.tags ?? []).join(' ')
  if (tags.includes('社交') || tags.includes('餐饮')) return 'roofWarm'
  if (tags.includes('商业') || tags.includes('学术')) return 'roofCool'
  if (tags.includes('公共') || tags.includes('户外')) return 'roofGreen'
  if (tags.includes('住宅')) return 'roofHome'
  return 'roofWarm'
}

/**
 * 生成小镇布局。
 *
 * 建筑尺寸不直接照搬地标包围盒：原版那份包围盒是"区域"（例如学院 26×18），
 * 直接当房子会得到一张巨大的实心色块。这里把每个地标收敛成一栋**合理的房子**
 * （由包围盒定中心，尺寸按面积取档），房子之间的空地留给草地、树与小路——
 * 这才是俯视小镇该有的密度。
 */
export function buildLayout(sandbox: Sandbox): TownLayout {
  const width = sandbox.map.width
  const height = sandbox.map.height
  const terrain: Terrain[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, (_, x) => 'grass' as Terrain),
  )
  // 轻微纹理：少量 grassAlt，位置由坐标决定（确定性）
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (hash2(x, y, 7) > 0.82) terrain[y][x] = 'grassAlt'
    }
  }
  const road: boolean[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => false))

  // ── 1) 沙盒自带的字符画地形优先（它是世界数据，玩家可以手改）────────────
  if (sandbox.map.tiles !== undefined) {
    for (let y = 0; y < Math.min(height, sandbox.map.tiles.length); y += 1) {
      const row = sandbox.map.tiles[y] ?? ''
      for (let x = 0; x < Math.min(width, row.length); x += 1) {
        const ch = row[x]
        if (ch === 'w') terrain[y][x] = 'water'
        else if (ch === 's') terrain[y][x] = 'sand'
        else if (ch === 'r') { terrain[y][x] = 'dirt'; road[y][x] = true }
        else if (ch === 'p' || ch === 'z') { terrain[y][x] = 'stone'; road[y][x] = true }
        else if (ch === 'g') terrain[y][x] = hash2(x, y, 7) > 0.82 ? 'grassAlt' : 'grass'
      }
    }
  }

  // ── 1.5) 室内地板：house 类沙盒给一块矩形，铺石地板 ─────────────────────
  const interior = sandbox.map.interior
  if (interior !== undefined) {
    for (let y = Math.max(0, Math.round(interior.y)); y < Math.min(height, Math.round(interior.y + interior.h)); y += 1) {
      for (let x = Math.max(0, Math.round(interior.x)); x < Math.min(width, Math.round(interior.x + interior.w)); x += 1) {
        terrain[y][x] = 'stone'
      }
    }
  }

  // ── 2) 建筑：先定房子，再让路连它们（路要能贴到门口）──────────────────
  const buildings: BuildingSpec[] = []
  for (const place of sandbox.places) {
    const area = Math.max(4, (place.w ?? 5) * (place.h ?? 5))
    // 显式给了 w/h 就照用：room 这类"房间"的尺寸是数据，不能被推导规则改掉
    // （改了就会出现"房间坐标与实际画出来的墙圈差两格"这种最难查的错位）。
    const explicit = place.w !== undefined && place.h !== undefined
    // 否则按面积取档：小铺子 5×5，大建筑 9×6。上限刻意压着——原版那份包围盒是"区域"，
    // 直接当房子会得到一张巨大的实心色块，整屏就只剩房子了。
    const w = explicit ? Math.round(place.w as number) : area >= 200 ? 9 : area >= 120 ? 8 : area >= 64 ? 7 : area >= 36 ? 6 : 5
    const h = explicit ? Math.round(place.h as number) : area >= 200 ? 6 : area >= 120 ? 6 : area >= 64 ? 5 : 5
    const left = Math.max(1, Math.min(width - w - 2, Math.round(place.x - w / 2)))
    const top = Math.max(1, Math.min(height - h - 2, Math.round(place.y - h / 2)))
    const right = left + w - 1
    const bottom = top + h - 1
    const roofTop = top + 1
    const roofBottom = top + Math.max(2, Math.floor(h * 0.55))
    const doorX = left + Math.floor(w / 2)
    const doorY = bottom
    const windows: Array<{ x: number; y: number }> = []
    for (let x = left + 1; x <= right - 1; x += 2) {
      if (x !== doorX) windows.push({ x, y: bottom })
      if (roofBottom + 1 <= bottom - 1) windows.push({ x, y: roofBottom + 1 })
    }
    buildings.push({
      place,
      left, top, right, bottom,
      roofTop, roofBottom,
      doorX, doorY,
      roofSlot: roofSlotOf(place),
      windows,
    })
    // 房子占地内铺室内地板（石板），避免露出草地
    for (let y = top; y <= bottom; y += 1) {
      for (let x = left; x <= right; x += 1) terrain[y][x] = 'stone'
    }
  }

  // ── 3) 路网：最小生成树 + 少量环路。Smallville 的辨识度就在这条路上。──
  const edges = minimumSpanningEdges(sandbox.places)
  for (const [a, b] of edges) {
    carvePath(terrain, road, sandbox.places[a], sandbox.places[b], width, height)
  }
  // 每个门口接一条短引道到底下的路（或直接向下铺 2 格，保证门不是悬空的）
  for (const b of buildings) {
    for (let y = b.bottom + 1; y <= Math.min(height - 1, b.bottom + 3); y += 1) {
      for (const x of [b.doorX, b.doorX + 1]) {
        if (x < 0 || x >= width) continue
        if (terrain[y][x] === 'water') continue
        terrain[y][x] = 'dirt'
        road[y][x] = true
      }
    }
  }

  return { width, height, terrain, buildings, road }
}

/** 地标之间的最小生成树（Prim）：只连最近的，避免满屏蛛网。 */
function minimumSpanningEdges(places: readonly WorldObject[]): Array<[number, number]> {
  if (places.length < 2) return []
  const connected = new Set<number>([0])
  const edges: Array<[number, number]> = []
  while (connected.size < places.length) {
    let best: { from: number; to: number; d: number } | null = null
    for (const i of connected) {
      for (let j = 0; j < places.length; j += 1) {
        if (connected.has(j)) continue
        const d = Math.hypot(places[i].x - places[j].x, places[i].y - places[j].y)
        if (best === null || d < best.d) best = { from: i, to: j, d }
      }
    }
    if (best === null) break
    connected.add(best.to)
    edges.push([best.from, best.to])
  }
  // 再补几条中等距离的边，形成环路（纯树状路网看起来很假）
  for (let i = 0; i < places.length; i += 1) {
    for (let j = i + 1; j < places.length; j += 1) {
      const d = Math.hypot(places[i].x - places[j].x, places[i].y - places[j].y)
      if (d < 30 && !edges.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) edges.push([i, j])
    }
  }
  return edges
}

/**
 * 铺一条 2–3 格宽的路。
 *
 * 用**折线**而不是直线：先横后竖的两段，看起来像街道；纯直线会得到一堆斜线，
 * 在像素风的方格地图上很难看（斜边必须用阶梯近似，显得毛糙）。
 */
function carvePath(
  terrain: Terrain[][],
  road: boolean[][],
  from: WorldObject,
  to: WorldObject,
  width: number,
  height: number,
): void {
  const half = 1 // 路宽 = 3 格（中心 ± 1）
  const paint = (x: number, y: number): void => {
    for (let dy = -half; dy <= half; dy += 1) {
      for (let dx = -half; dx <= half; dx += 1) {
        const px = Math.round(x) + dx
        const py = Math.round(y) + dy
        if (px < 0 || py < 0 || px >= width || py >= height) continue
        if (terrain[py][px] === 'water') continue
        terrain[py][px] = 'dirt'
        road[py][px] = true
      }
    }
  }
  const x0 = Math.round(from.x)
  const y0 = Math.round(from.y)
  const x1 = Math.round(to.x)
  const y1 = Math.round(to.y)
  // 横向段 + 纵向段（先走 x 再走 y，路口自然形成）
  const stepX = x0 <= x1 ? 1 : -1
  for (let x = x0; x !== x1 + stepX; x += stepX) paint(x, y0)
  const stepY = y0 <= y1 ? 1 : -1
  for (let y = y0; y !== y1 + stepY; y += stepY) paint(x1, y)
}

/** 布局指纹：用于客户端判断"要不要重建"。 */
export function layoutKey(sandbox: Sandbox): string {
  return (
    sandbox.places.map((p) => `${p.id}:${p.x},${p.y},${p.w ?? 0}x${p.h ?? 0}`).join('|') +
    `#${sandbox.map.width}x${sandbox.map.height}#${(sandbox.map.tiles ?? []).length}#${JSON.stringify(sandbox.map.interior ?? null)}`
  )
}
