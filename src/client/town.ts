/**
 * 小镇渲染层 —— 材质化地块 + 有屋顶门窗的建筑 + 道路 + 草木 + 角色信标。
 *
 * 为什么不直接贴 Smallville 的原画：那套 sprite/maze 资产的是 JPEG/PNG 位图，
 * 塞进插件会让仓库背上几十 MB 二进制，且许可证与原作的贴图授权需要单独确认。
 * 这里走的是**程序化绘制**：同一份地标数据（原版 arena_maze.csv 解析出来的真实
 * 包围盒）渲染成"能认出是小镇"的像素质感，坐标与形状仍然是原版的。
 *
 * 三条硬约束：
 *  1. 确定性——地面纹理、树位、屋顶瓦线全部由**坐标派生**的伪随机数决定，
 *     同一份沙盒每次重绘必须一模一样，否则拖动缩放时整个镇子会抖。
 *  2. 只画确定的东西——不臆造不存在的建筑。地标外的装饰树木/石子明确标注为
 *     "按布局生成"，不冒充原版数据。
 *  3. 不参与布局——画布由 CSS 绝对定位铺满容器，渲染层不写任何会影响父容器
 *     尺寸的属性（那正是此前"无限下坠"的回路）。
 */
import {
  OBJECT_KIND_LABEL,
  type ObjectKind,
  type Sandbox,
  type SandboxAgent,
  type StateValue,
  type WorldObject,
} from '../shared/model.ts'

// ── 调色板 ────────────────────────────────────────────────────────────────

const PALETTE = {
  grass: '#5c8b3a',
  grassDark: '#4a7530',
  grassLight: '#6d9c45',
  water: '#3f7fa0',
  waterLight: '#5fa3c4',
  sand: '#c9a86a',
  road: '#b59a72',
  roadEdge: '#8f7752',
  building: {
    social: { roof: '#8c4a3c', roofDark: '#6f382c', wall: '#d9c39a', wallDark: '#bfa87e' },
    commerce: { roof: '#3f6d8c', roofDark: '#2f5471', wall: '#d9c39a', wallDark: '#bfa87e' },
    academic: { roof: '#6a5a92', roofDark: '#52466f', wall: '#dfd3b8', wallDark: '#c2b494' },
    resident: { roof: '#a8623f', roofDark: '#874c2f', wall: '#e2d0b0', wallDark: '#c4ae8c' },
    public: { roof: '#4f7a63', roofDark: '#3b5c4a', wall: '#ddd0b4', wallDark: '#c0b092' },
    outdoor: { roof: '#5f8f4a', roofDark: '#47702f', wall: '#cfd8b0', wallDark: '#b0bd8c' },
  },
  tree: '#3f6b34',
  treeDark: '#2f5527',
  trunk: '#6b4a2f',
  stone: '#b8b2a2',
  ink: '#1d232c',
  label: 'rgba(12,16,22,0.72)',
  labelText: '#f2f5fa',
  agentRing: 'rgba(255,255,255,0.92)',
} as const

/** 建筑配色按 tags/kind 归类——同一类地标共享一套屋顶与墙面色，镇子才有秩序感。 */
function styleOf(place: WorldObject): { roof: string; roofDark: string; wall: string; wallDark: string } {
  const tags = (place.tags ?? []).join(' ')
  const kind = place.kind
  if (tags.includes('社交') || tags.includes('餐饮')) return PALETTE.building.social
  if (tags.includes('商业')) return PALETTE.building.commerce
  if (tags.includes('学术')) return PALETTE.building.academic
  if (tags.includes('住宅')) return PALETTE.building.resident
  if (tags.includes('公共')) return PALETTE.building.public
  if (tags.includes('户外')) return PALETTE.building.outdoor
  if (kind === 'place') return PALETTE.building.resident
  return PALETTE.building.public
}

// ── 确定性伪随机（按坐标派生，与绘制顺序无关）─────────────────────────────

function hash2(x: number, y: number, salt = 0): number {
  let h = (Math.round(x) * 374761393 + Math.round(y) * 668265263 + salt * 2246822519) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// ── 地块层 ────────────────────────────────────────────────────────────────

export type TileKind = 'grass' | 'road' | 'water' | 'sand' | 'stone' | 'plaza'

export interface TileField {
  width: number
  height: number
  /** 行优先的字符画：g grass / r road / w water / s sand / p stone / z plaza。 */
  rows: string[]
}

const TILE_CHAR: Record<TileKind, string> = {
  grass: 'g',
  road: 'r',
  water: 'w',
  sand: 's',
  stone: 'p',
  plaza: 'z',
}

/**
 * 生成地块底图。
 *
 * 沙盒自带 `map.tiles` 时直接用（玩家可以手写一张真正的图）；否则按地标布局推导：
 *  - 地标外围一圈铺石板（门前场地）
 *  - 相邻地标之间拉直线道路（最小生成树的边，避免满屏蛛网）
 *  - 边缘与空地撒树丛、石头、水塘（明确标注为按布局生成）
 *
 * 这是**降级图**，不是原版地图：原版是 140x100 的贴图网格，我们只有地标包围盒。
 * 但它足以让人一眼认出"这是个有街道、有房子、有公园的小镇"。
 */
export function buildTileField(sandbox: Sandbox): TileField {
  const width = sandbox.map.width
  const height = sandbox.map.height
  const grid: string[][] = Array.from({ length: height }, () => Array.from({ length: width }, () => TILE_CHAR.grass))

  const set = (x: number, y: number, kind: TileKind, force = false): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    if (!force && grid[y][x] !== TILE_CHAR.grass) return
    grid[y][x] = TILE_CHAR[kind]
  }

  // 1) 地标占地 → 石板广场；地标内圈再压一层深色，让建筑"坐"在地上
  for (const place of sandbox.places) {
    const w = place.w ?? 4
    const h = place.h ?? 4
    for (let x = Math.floor(place.x - w / 2) - 1; x <= Math.ceil(place.x + w / 2) + 1; x += 1) {
      for (let y = Math.floor(place.y - h / 2) - 1; y <= Math.ceil(place.y + h / 2) + 1; y += 1) set(x, y, 'stone')
    }
  }

  // 2) 道路：对地标做最小生成树（Prim），只连通最近的那些，避免全连接蛛网
  const places = sandbox.places
  const connected = new Set<number>([0])
  const edges: Array<[number, number]> = []
  while (connected.size < places.length && places.length > 1) {
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
  // 再补几条稍长的边，让镇子有"环路"而不是纯树——视觉上更像真实聚落
  for (let i = 0; i < places.length; i += 1) {
    for (let j = i + 1; j < places.length; j += 1) {
      const d = Math.hypot(places[i].x - places[j].x, places[i].y - places[j].y)
      if (d < 26 && !edges.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) edges.push([i, j])
    }
  }
  for (const [a, b] of edges) {
    const from = places[a]
    const to = places[b]
    const steps = Math.max(Math.abs(to.x - from.x), Math.abs(to.y - from.y)) * 2
    for (let s = 0; s <= steps; s += 1) {
      const t = steps === 0 ? 0 : s / steps
      const x = Math.round(from.x + (to.x - from.x) * t)
      const y = Math.round(from.y + (to.y - from.y) * t)
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        // 路铺 2 格宽，压在草地上；已铺石板的地方不覆盖
        if (grid[Math.max(0, Math.min(height - 1, y + dy))]?.[Math.max(0, Math.min(width - 1, x + dx))] !== TILE_CHAR.stone) {
          for (const [ex, ey] of [[0, 0], [1, 0], [0, 1], [1, 1]]) set(x + dx + ex, y + dy + ey, 'road')
        } else set(x + dx, y + dy, 'road')
      }
    }
  }

  return { width, height, rows: grid.map((row) => row.join('')) }
}

// ── 图元绘制 ──────────────────────────────────────────────────────────────

function drawGround(ctx: CanvasRenderingContext2D, view: View, sandbox: Sandbox, tiles: TileField): void {
  const { scale, offsetX, offsetY } = view
  const mapW = sandbox.map.width * scale
  const mapH = sandbox.map.height * scale
  ctx.fillStyle = PALETTE.grass
  ctx.fillRect(offsetX, offsetY, mapW, mapH)

  // 地块：只在够大时逐格画；否则按 4x4 合并，避免小缩放下画十万个方块
  const step = scale >= 6 ? 1 : scale >= 3 ? 2 : 4
  for (let y = 0; y < tiles.height; y += step) {
    for (let x = 0; x < tiles.width; x += step) {
      const char = tiles.rows[y][x]
      if (char === TILE_CHAR.grass) {
        // 草地纹理：确定性噪点，让地面不平板
        if (step === 1) {
          const n = hash2(x, y, 7)
          if (n > 0.82) ctx.fillStyle = PALETTE.grassLight
          else if (n < 0.18) ctx.fillStyle = PALETTE.grassDark
          else continue
        } else continue
      } else {
        ctx.fillStyle =
          char === TILE_CHAR.road ? PALETTE.road
          : char === TILE_CHAR.stone ? PALETTE.stone
          : char === TILE_CHAR.water ? PALETTE.water
          : char === TILE_CHAR.sand ? PALETTE.sand
          : PALETTE.stone
      }
      ctx.fillRect(offsetX + x * scale, offsetY + y * scale, scale * step + 0.5, scale * step + 0.5)
    }
  }

}

function drawBuilding(
  ctx: CanvasRenderingContext2D,
  view: View,
  place: WorldObject,
  selected: boolean,
): void {
  const { scale, offsetX, offsetY } = view
  const w = (place.w ?? 4) * scale
  const h = (place.h ?? 4) * scale
  const x = offsetX + (place.x - (place.w ?? 4) / 2) * scale
  const y = offsetY + (place.y - (place.h ?? 4) / 2) * scale
  const style = styleOf(place)

  if (scale < 1.6) {
    ctx.fillStyle = style.roof
    ctx.fillRect(x, y, w, h)
    return
  }

  const roofH = Math.max(3, h * 0.34)
  const wallDark = style.wallDark

  // 投影
  ctx.fillStyle = 'rgba(0,0,0,0.22)'
  ctx.beginPath()
  ctx.ellipse(x + w / 2, y + h + Math.max(1, scale * 0.5), w * 0.52, Math.max(2, scale * 0.9), 0, 0, Math.PI * 2)
  ctx.fill()

  // 墙体
  ctx.fillStyle = style.wall
  ctx.fillRect(x, y + roofH, w, h - roofH)
  // 墙体下缘暗边
  ctx.fillStyle = wallDark
  ctx.fillRect(x, y + h - Math.max(2, scale * 0.6), w, Math.max(2, scale * 0.6))
  // 窗户（沿墙均布，够大才画）
  if (scale >= 3.2) {
    const cols = Math.max(1, Math.floor(w / (scale * 3)))
    const winW = Math.max(2, scale * 1.1)
    const winH = Math.max(2, scale * 1.1)
    ctx.fillStyle = 'rgba(60,70,90,0.75)'
    for (let c = 0; c < cols; c += 1) {
      const wx = x + (w / (cols + 1)) * (c + 1) - winW / 2
      const wy = y + roofH + (h - roofH) * 0.34
      ctx.fillRect(wx, wy, winW, winH)
      ctx.fillStyle = 'rgba(240,220,150,0.5)'
      ctx.fillRect(wx + 0.5, wy + 0.5, winW - 1, winH * 0.4)
      ctx.fillStyle = 'rgba(60,70,90,0.75)'
    }
  }

  // 屋顶：梯形 + 瓦线
  ctx.fillStyle = style.roof
  ctx.beginPath()
  ctx.moveTo(x - scale * 0.4, y + roofH)
  ctx.lineTo(x + w * 0.16, y)
  ctx.lineTo(x + w * 0.84, y)
  ctx.lineTo(x + w + scale * 0.4, y + roofH)
  ctx.closePath()
  ctx.fill()
  ctx.strokeStyle = style.roofDark
  ctx.lineWidth = Math.max(1, scale * 0.25)
  ctx.stroke()
  if (scale >= 3) {
    ctx.globalAlpha = 0.35
    ctx.strokeStyle = style.roofDark
    ctx.lineWidth = 1
    for (let r = 1; r < 3; r += 1) {
      const ry = y + (roofH / 3) * r
      ctx.beginPath()
      ctx.moveTo(x + w * 0.2, ry)
      ctx.lineTo(x + w * 0.8, ry)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
  }

  // 门
  if (scale >= 2.4) {
    const doorW = Math.max(2, scale * 1.2)
    const doorH = Math.max(3, (h - roofH) * 0.5)
    ctx.fillStyle = '#5b4330'
    ctx.fillRect(x + w / 2 - doorW / 2, y + h - doorH, doorW, doorH)
  }

  if (selected) {
    ctx.strokeStyle = '#ffd479'
    ctx.lineWidth = Math.max(1.5, scale * 0.5)
    ctx.strokeRect(x - 1, y - 1, w + 2, h + 2)
  }

}

/** 建筑名牌单独一遍：名牌必须压在所有建筑与角色之上，否则会被邻居盖住。 */
function drawPlaceLabel(ctx: CanvasRenderingContext2D, view: View, place: WorldObject): void {
  if (view.scale < 2.2) return
  const w = (place.w ?? 4) * view.scale
  const h = (place.h ?? 4) * view.scale
  const cx = view.offsetX + place.x * view.scale
  const top = view.offsetY + (place.y - (place.h ?? 4) / 2) * view.scale
  ctx.strokeStyle = 'rgba(0,0,0,0.25)'
  ctx.lineWidth = 1
  drawLabel(ctx, place.name, cx, top - Math.max(4, view.scale * 1.4), view.scale, true)
  void w
  void h
}

/** 统一的名牌：深底浅字，避免直接压在地面纹理上读不清。 */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  cy: number,
  scale: number,
  strong: boolean,
): void {
  const font = `${Math.max(9, Math.min(13, 9 + scale * 0.7))}px system-ui, "PingFang SC", "Microsoft YaHei", sans-serif`
  ctx.font = font
  const metrics = ctx.measureText(text)
  const padX = 4
  const boxW = metrics.width + padX * 2
  const boxH = Math.max(13, scale * 1.8)
  ctx.fillStyle = strong ? PALETTE.label : 'rgba(12,16,22,0.55)'
  ctx.beginPath()
  const rx = cx - boxW / 2
  const ry = cy - boxH + 3
  const r = 3
  ctx.moveTo(rx + r, ry)
  ctx.lineTo(rx + boxW - r, ry)
  ctx.quadraticCurveTo(rx + boxW, ry, rx + boxW, ry + r)
  ctx.lineTo(rx + boxW, ry + boxH - r)
  ctx.quadraticCurveTo(rx + boxW, ry + boxH, rx + boxW - r, ry + boxH)
  ctx.lineTo(rx + r, ry + boxH)
  ctx.quadraticCurveTo(rx, ry + boxH, rx, ry + boxH - r)
  ctx.lineTo(rx, ry + r)
  ctx.quadraticCurveTo(rx, ry, rx + r, ry)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = PALETTE.labelText
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(text, cx, ry + (boxH - 12) / 2)
}

function drawObject(ctx: CanvasRenderingContext2D, view: View, object: WorldObject): void {
  const { scale, offsetX, offsetY } = view
  const x = offsetX + object.x * scale
  const y = offsetY + object.y * scale
  const broken = String(object.state.status ?? '正常') !== '正常'
  const size = Math.max(2.2, scale * 1.1)

  ctx.save()
  ctx.translate(x, y)

  switch (object.kind as ObjectKind) {
    case 'fixture': {
      // 灯柱：细杆 + 灯头；故障时灯头变红
      ctx.strokeStyle = '#4a4f57'
      ctx.lineWidth = Math.max(1, scale * 0.35)
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(0, -size * 1.6)
      ctx.stroke()
      ctx.fillStyle = broken ? '#f07178' : object.color ?? '#ffd479'
      ctx.beginPath()
      ctx.arc(0, -size * 1.9, size * 0.5, 0, Math.PI * 2)
      ctx.fill()
      if (!broken) {
        ctx.globalAlpha = 0.25
        ctx.beginPath()
        ctx.arc(0, -size * 1.9, size * 0.95, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }
      break
    }
    case 'plant': {
      ctx.fillStyle = PALETTE.trunk
      ctx.fillRect(-size * 0.16, -size * 0.4, size * 0.32, size * 0.6)
      ctx.fillStyle = PALETTE.tree
      ctx.beginPath()
      ctx.arc(0, -size * 0.9, size * 0.85, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = PALETTE.treeDark
      ctx.beginPath()
      ctx.arc(size * 0.3, -size * 0.7, size * 0.5, 0, Math.PI * 2)
      ctx.fill()
      break
    }
    case 'vehicle': {
      ctx.fillStyle = broken ? '#8a8f98' : object.color ?? '#3a7a8a'
      ctx.beginPath()
      ctx.moveTo(-size, 0)
      ctx.lineTo(size, 0)
      ctx.lineTo(size * 0.6, -size * 0.9)
      ctx.lineTo(-size * 0.6, -size * 0.9)
      ctx.closePath()
      ctx.fill()
      break
    }
    case 'sign': {
      ctx.fillStyle = PALETTE.trunk
      ctx.fillRect(-size * 0.12, -size * 1.2, size * 0.24, size * 1.2)
      ctx.fillStyle = broken ? '#f07178' : '#c9a86a'
      ctx.fillRect(-size * 0.7, -size * 1.9, size * 1.4, size * 0.8)
      break
    }
    default: {
      // 物件：圆角方块 + 高光，故障的红环
      ctx.fillStyle = object.color ?? '#c8ccd6'
      ctx.beginPath()
      ctx.roundRect(-size * 0.7, -size * 0.7, size * 1.4, size * 1.4, size * 0.35)
      ctx.fill()
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.beginPath()
      ctx.roundRect(-size * 0.5, -size * 0.55, size * 0.9, size * 0.45, size * 0.2)
      ctx.fill()
      if (broken) {
        ctx.strokeStyle = '#f07178'
        ctx.lineWidth = Math.max(1, scale * 0.3)
        ctx.beginPath()
        ctx.arc(0, 0, size * 1.25, 0, Math.PI * 2)
        ctx.stroke()
      }
      break
    }
  }
  ctx.restore()
}

/** 角色：阴影 + 圆形身体 + emoji 头像 + 名牌；够大时再挂一句最近的话。 */
function drawAgent(
  ctx: CanvasRenderingContext2D,
  view: View,
  agent: SandboxAgent,
  selected: boolean,
  bubble?: string,
): void {
  const { scale, offsetX, offsetY } = view
  const x = offsetX + agent.x * scale
  const y = offsetY + agent.y * scale
  const r = Math.max(4, scale * 1.5)

  ctx.fillStyle = 'rgba(0,0,0,0.28)'
  ctx.beginPath()
  ctx.ellipse(x, y + r * 0.85, r * 0.95, r * 0.42, 0, 0, Math.PI * 2)
  ctx.fill()

  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = agent.color
  ctx.fill()
  ctx.lineWidth = selected ? Math.max(2, scale * 0.5) : Math.max(1, scale * 0.25)
  ctx.strokeStyle = selected ? '#ffd479' : PALETTE.agentRing
  ctx.stroke()

  ctx.font = `${Math.max(9, Math.round(r * 1.25))}px system-ui, "Apple Color Emoji", "Noto Color Emoji", sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(agent.portrait, x, y + 0.5)

  if (scale >= 1.8) {
    drawLabel(ctx, agent.name, x, y - r - Math.max(3, scale * 0.7), scale, selected)
  }
  if (bubble !== undefined && scale >= 3) {
    const text = bubble.length > 22 ? `${bubble.slice(0, 21)}…` : bubble
    ctx.font = '10px system-ui, "PingFang SC", sans-serif'
    const w = Math.min(180, ctx.measureText(text).width + 12)
    const bx = x - w / 2
    const by = y - r - Math.max(18, scale * 2.6) - 14
    ctx.fillStyle = 'rgba(248,250,255,0.94)'
    ctx.beginPath()
    ctx.roundRect(bx, by, w, 15, 4)
    ctx.fill()
    ctx.beginPath()
    ctx.moveTo(x - 3, by + 15)
    ctx.lineTo(x + 3, by + 15)
    ctx.lineTo(x, by + 19)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = '#1d232c'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x, by + 8)
  }
}

// ── 主绘制入口 ────────────────────────────────────────────────────────────

export interface View {
  scale: number
  offsetX: number
  offsetY: number
}

export interface RenderInput {
  sandbox: Sandbox
  tiles: TileField
  view: View
  size: { w: number; h: number }
  agents: SandboxAgent[]
  selectedId?: string
  hover?: { objectId?: string; agentId?: string }
  /** 每个 agentId 最近说的一句话（用于气泡）。 */
  bubbles?: Map<string, string>
}

export function renderTown(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { sandbox, tiles, view, size, agents, selectedId, hover } = input
  ctx.clearRect(0, 0, size.w, size.h)
  // 画布外的世界底色（深色工作台，让小镇边界清楚）
  ctx.fillStyle = '#12151b'
  ctx.fillRect(0, 0, size.w, size.h)

  drawGround(ctx, view, sandbox, tiles)

  // 物件先画（在建筑之下、角色之上），地标建筑后画
  for (const object of sandbox.objects) {
    if (view.scale < 1.2) continue
    if (object.kind === 'plant') continue // 草木单独一批，压在建筑后
    drawObject(ctx, view, object)
  }

  for (const place of sandbox.places) {
    drawBuilding(ctx, view, place, hover?.objectId === place.id)
  }

  for (const object of sandbox.objects) {
    if (object.kind !== 'plant' || view.scale < 1.2) continue
    drawObject(ctx, view, object)
  }

  // 名牌：压在建筑与草木之上，但仍在角色之下（角色最需要被看见）
  for (const place of sandbox.places) drawPlaceLabel(ctx, view, place)

  // 角色：选中者最后画，保证不被别人盖住
  const sorted = [...agents].sort((a, b) => Number(a.id === selectedId) - Number(b.id === selectedId))
  for (const agent of sorted) {
    drawAgent(ctx, view, agent, agent.id === selectedId, input.bubbles?.get(agent.id))
  }
}

export { OBJECT_KIND_LABEL, PALETTE }
