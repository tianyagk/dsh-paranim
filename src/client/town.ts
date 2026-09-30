/**
 * 小镇渲染层 —— 用真实像素图集（Kenney CC0）绘制俯视图。
 *
 * 素材来源与分工见 `mapStyle.ts`；取图接口见 `tiles.ts`。
 *
 * 三条硬约束（都是踩过坑换来的，别改）：
 *  1. **确定性**：地面变体、树位、朝向全部由坐标派生，同一份沙盒每次重绘一模一样，
 *     拖动缩放不会抖。
 *  2. **只画视口内的格子**：140×100 全画是 14000 次 drawImage，缩小时九成在画布外。
 *  3. **不参与布局**：画布由 CSS 绝对定位铺满容器，渲染层不写任何影响父容器尺寸的属性
 *     （那正是"向下无限下坠"的回路）。
 */
import {
  OBJECT_KIND_LABEL,
  type ObjectKind,
  type Sandbox,
  type SandboxAgent,
  type WorldObject,
} from '../shared/model.ts'
import { BUILDING, CHARACTER, GROUND, PROPS, SYMBOLS, pickSlot } from './mapStyle.ts'
import { drawGroundTile, drawTile, type TileRef } from './tiles.ts'

/** 一格地图像素（图集瓦片原始尺寸）。 */
export const TILE_PX = 16

/** 世界之外留一圈草地边，让小镇不顶到画布边缘。 */
const BORDER_TILES = 3

export interface View {
  scale: number
  offsetX: number
  offsetY: number
}

export interface RenderInput {
  sandbox: Sandbox
  view: View
  size: { w: number; h: number }
  agents: SandboxAgent[]
  selectedId?: string
  hover?: { objectId?: string; agentId?: string }
  bubbles?: Map<string, string>
  /** 世界步数：驱动行走动画与朝向（同一格不抖）。 */
  tick?: number
}

function hash2(x: number, y: number, salt = 0): number {
  let h = (Math.round(x) * 374761393 + Math.round(y) * 668265263 + salt * 2246822519) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// ── 地面 ──────────────────────────────────────────────────────────────────

function groundRefAt(sandbox: Sandbox, x: number, y: number): TileRef | undefined {
  const inMap = x >= 0 && y >= 0 && x < sandbox.map.width && y < sandbox.map.height
  if (!inMap) return pickSlot(GROUND, 'void', hash2(x, y, 9))
  const tiles = sandbox.map.tiles
  const char = tiles === undefined ? undefined : (tiles[y] ?? '')[x]
  const n = hash2(x, y, 1)
  if (char === 'w') return pickSlot(GROUND, 'stone', n)
  if (char === 'r' || char === 'p' || char === 'z') return pickSlot(GROUND, 'stone', n)
  if (char === 's') return pickSlot(GROUND, 'dirt', n)
  return pickSlot(GROUND, 'grass', n)
}

function drawGround(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { sandbox, view, size } = input
  const { scale, offsetX, offsetY } = view
  const step = TILE_PX * scale
  if (step <= 0.05) return

  const minX = Math.max(-BORDER_TILES, Math.floor(-offsetX / step) - 1)
  const maxX = Math.min(sandbox.map.width + BORDER_TILES, Math.ceil((size.w - offsetX) / step) + 1)
  const minY = Math.max(-BORDER_TILES, Math.floor(-offsetY / step) - 1)
  const maxY = Math.min(sandbox.map.height + BORDER_TILES, Math.ceil((size.h - offsetY) / step) + 1)

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const ref = groundRefAt(sandbox, x, y)
      if (ref === undefined) continue
      drawGroundTile(ctx, ref, offsetX + x * step, offsetY + y * step, step + 0.5)
    }
  }
}

// ── 建筑 ──────────────────────────────────────────────────────────────────

/** 屋顶族按地标 tags 分配（配色即语义：暖=社交、蓝=商业、绿=公共/户外、默认=住宅）。 */
function roofSlot(place: WorldObject): string {
  const tags = (place.tags ?? []).join(' ')
  if (tags.includes('社交') || tags.includes('餐饮')) return 'roofWarm'
  if (tags.includes('商业') || tags.includes('学术')) return 'roofCool'
  if (tags.includes('公共') || tags.includes('户外')) return 'roofGreen'
  return 'roofWarm'
}

/**
 * 建筑画法：把占地拆成"屋顶横条 + 墙体横条"，逐格铺图集瓦片。
 *
 * 为什么不用单个大 sprite：图集里的建筑瓦片是 16×16 的模块（屋顶/墙/门/窗分开），
 * 拼装才能适配任意 `w×h` 的地标——原版 Smallville 的地标包围盒差异很大（4×4 到 26×22），
 * 固定 sprite 要么被拉伸变形、要么盖不住。
 */
function drawBuilding(ctx: CanvasRenderingContext2D, view: View, place: WorldObject, hovered: boolean): void {
  const { scale, offsetX, offsetY } = view
  const wTiles = Math.max(2, Math.round(place.w ?? 4))
  const hTiles = Math.max(2, Math.round(place.h ?? 4))
  const step = TILE_PX * scale
  const left = Math.round(offsetX + (place.x - wTiles / 2) * step)
  const top = Math.round(offsetY + (place.y - hTiles / 2) * step)
  const roofRows = Math.max(1, Math.round(hTiles * 0.4))
  const roofSlotName = roofSlot(place)

  // 投影：先铺一层压暗的地面，让建筑"坐"下去（比画椭圆阴影更像素风）
  ctx.fillStyle = 'rgba(18,26,18,0.22)'
  ctx.fillRect(left, top + roofRows * step, wTiles * step, (hTiles - roofRows) * step + Math.max(2, step * 0.35))

  // 屋顶
  for (let ry = 0; ry < roofRows; ry += 1) {
    for (let rx = 0; rx < wTiles; rx += 1) {
      const ref = pickSlot(BUILDING, roofSlotName, hash2(place.x + rx, place.y + ry, 21))
      if (ref !== undefined) drawGroundTile(ctx, ref, left + rx * step, top + ry * step, step + 0.5)
    }
  }
  // 墙体
  for (let wy = roofRows; wy < hTiles; wy += 1) {
    for (let wx = 0; wx < wTiles; wx += 1) {
      const isDoor = wy === hTiles - 1 && wx === Math.floor(wTiles / 2)
      const isWindow = wy === Math.max(roofRows, hTiles - 2) && wx !== Math.floor(wTiles / 2) && wx % 2 === 0
      const ref = isDoor
        ? pickSlot(BUILDING, 'door', 0.5)
        : isWindow
          ? pickSlot(BUILDING, 'window', 0.5)
          : pickSlot(BUILDING, 'wall', hash2(place.x + wx, place.y + wy, 31))
      if (ref !== undefined) drawGroundTile(ctx, ref, left + wx * step, top + wy * step, step + 0.5)
    }
  }

  if (hovered) {
    ctx.strokeStyle = '#ffc861'
    ctx.lineWidth = Math.max(1.5, scale * 0.8)
    ctx.strokeRect(left - 1, top - 1, wTiles * step + 2, hTiles * step + 2)
  }
}

// ── 物件 ──────────────────────────────────────────────────────────────────

/** 物件 → 语义槽位：先按 id 认名字，再按 kind 兜底。 */
function propSlotOf(object: WorldObject): string {
  const id = `${object.id} ${object.name}`.toLowerCase()
  const named: Array<[RegExp, string]> = [
    [/lamp|灯/, 'streetlamp'],
    [/bench|椅/, 'bench'],
    [/bin|trash|垃圾/, 'bin'],
    [/fountain|泉/, 'fountain'],
    [/sign|notice|board|告示|牌/, 'sign'],
    [/stall|摊/, 'stall'],
    [/well|井/, 'well'],
    [/campfire|篝火|fire/, 'campfire'],
    [/windmill|风车|vehicle|truck|car|车/, 'vehicle'],
    [/tree|树/, 'tree'],
    [/bush|灌木|花丛/, 'bush'],
    [/rock|石/, 'rock'],
    [/fence|栅栏|篱/, 'fence'],
  ]
  for (const [re, slot] of named) if (re.test(id)) return slot
  switch (object.kind as ObjectKind) {
    case 'plant':
      return 'tree'
    case 'fixture':
      return 'streetlamp'
    case 'vehicle':
      return 'vehicle'
    case 'sign':
      return 'sign'
    default:
      return 'fallback'
  }
}

function drawObject(ctx: CanvasRenderingContext2D, view: View, object: WorldObject): void {
  const { scale, offsetX, offsetY } = view
  const slot = propSlotOf(object)
  const n = hash2(object.x, object.y, 41)
  const ref = pickSlot(PROPS, slot, n) ?? pickSlot(PROPS, 'fallback', n)
  if (ref === undefined) return
  const cx = offsetX + object.x * TILE_PX * scale
  const bottom = offsetY + (object.y + 0.75) * TILE_PX * scale
  drawTile(ctx, ref, cx, bottom, scale)

  // 状态符号：非"正常"就压一个小角标（来自 1-Bit 后备图集）
  const status = String(object.state.status ?? '正常')
  if (status !== '正常') {
    const badge = pickSlot(SYMBOLS, 'broken', 0)
    if (badge !== undefined) {
      drawTile(ctx, badge, cx + 7 * scale, bottom - 13 * scale, Math.max(0.45, scale * 0.65))
    }
  }
}

// ── 角色 ──────────────────────────────────────────────────────────────────

/** 朝向：由坐标派生（同一格稳定），步数驱动两帧切换。 */
function facingOf(agent: SandboxAgent): 'down' | 'up' | 'side' {
  const n = hash2(agent.x, agent.y, 51)
  return n < 0.55 ? 'down' : n < 0.8 ? 'side' : 'up'
}

function drawAgent(
  ctx: CanvasRenderingContext2D,
  view: View,
  agent: SandboxAgent,
  tick: number,
  selected: boolean,
  bubble?: string,
): void {
  const { scale, offsetX, offsetY } = view
  const cx = offsetX + (agent.x + 0.5) * TILE_PX * scale
  const bottom = offsetY + (agent.y + 1) * TILE_PX * scale
  const facing = facingOf(agent)
  const frame = Math.abs(Math.round(tick + hash2(agent.x, agent.y, 61) * 2)) % 2
  const ref = pickSlot(CHARACTER, facing, frame % 2) ?? pickSlot(CHARACTER, 'fallback', 0)

  // 脚下投影
  ctx.fillStyle = 'rgba(18,26,18,0.25)'
  ctx.beginPath()
  ctx.ellipse(cx, bottom - scale * 2, scale * 5.5, scale * 2, 0, 0, Math.PI * 2)
  ctx.fill()

  if (ref !== undefined) drawTile(ctx, ref, cx, bottom, scale)

  if (selected) {
    ctx.strokeStyle = '#ffc861'
    ctx.lineWidth = Math.max(1.5, scale)
    ctx.beginPath()
    ctx.arc(cx, bottom - scale * 8, scale * 9, 0, Math.PI * 2)
    ctx.stroke()
  }
  if (scale >= 0.55) drawNameplate(ctx, agent.name, cx, bottom - 16 * scale - 3, selected)
  if (bubble !== undefined && scale >= 1) drawBubble(ctx, bubble, cx, bottom - 16 * scale - 20)
}

/** 名牌：暖黑底 + 1px 亮描边，与像素素材的描边逻辑一致。 */
function drawNameplate(ctx: CanvasRenderingContext2D, text: string, cx: number, bottomY: number, strong: boolean): void {
  ctx.font = '10px ui-monospace, "PingFang SC", "Microsoft YaHei", monospace'
  const w = Math.round(ctx.measureText(text).width) + 8
  const h = 14
  const x = Math.round(cx - w / 2)
  const y = Math.round(bottomY - h)
  ctx.fillStyle = strong ? 'rgba(30,24,20,0.92)' : 'rgba(26,22,20,0.78)'
  ctx.fillRect(x, y, w, h)
  ctx.strokeStyle = strong ? '#ffc861' : 'rgba(244,246,250,0.35)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  ctx.fillStyle = strong ? '#ffe6b0' : '#f4f6fa'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, Math.round(cx), y + h / 2 + 0.5)
}

function drawBubble(ctx: CanvasRenderingContext2D, text: string, cx: number, topY: number): void {
  const clipped = text.length > 20 ? `${text.slice(0, 19)}…` : text
  ctx.font = '10px system-ui, "PingFang SC", sans-serif'
  const w = Math.min(190, Math.round(ctx.measureText(clipped).width) + 14)
  const h = 18
  const x = Math.round(cx - w / 2)
  const y = Math.round(topY - h - 6)
  // 像素风的"圆角"：切角而不是画圆角
  ctx.fillStyle = 'rgba(250,247,240,0.96)'
  ctx.fillRect(x + 1, y, w - 2, h)
  ctx.fillRect(x, y + 1, w, h - 2)
  ctx.strokeStyle = 'rgba(42,35,32,0.85)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  ctx.fillStyle = 'rgba(250,247,240,0.96)'
  ctx.fillRect(cx - 2, y + h, 4, 3)
  ctx.strokeRect(cx - 2.5, y + h - 0.5, 5, 3.5)
  ctx.fillStyle = '#2a231f'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(clipped, Math.round(cx), y + h / 2 + 0.5)
}

// ── 主入口 ────────────────────────────────────────────────────────────────

export function renderTown(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { sandbox, view, size, agents, selectedId, hover } = input
  const tick = input.tick ?? 0
  ctx.clearRect(0, 0, size.w, size.h)
  ctx.fillStyle = '#0d1014'
  ctx.fillRect(0, 0, size.w, size.h)
  ctx.imageSmoothingEnabled = false

  drawGround(ctx, input)

  // 植物先画（压在地面、建筑之下）
  for (const object of sandbox.objects) if (object.kind === 'plant') drawObject(ctx, view, object)

  // 建筑按 y 排序 → 后画的盖住前面，形成俯视遮挡
  for (const place of [...sandbox.places].sort((a, b) => a.y - b.y)) {
    drawBuilding(ctx, view, place, hover?.objectId === place.id)
  }

  // 非植物物件
  for (const object of sandbox.objects) if (object.kind !== 'plant') drawObject(ctx, view, object)

  // 角色同样按 y 排序；选中的最后画，保证不被别人盖住
  const walkers = [...agents].sort((a, b) =>
    a.y === b.y ? Number(a.id === selectedId) - Number(b.id === selectedId) : a.y - b.y,
  )
  for (const agent of walkers) {
    drawAgent(ctx, view, agent, tick, agent.id === selectedId, input.bubbles?.get(agent.id))
  }
}

/** 地图的像素尺寸（含边界留白），供视图换算。 */
export function mapPixelSize(sandbox: Sandbox): { w: number; h: number } {
  return {
    w: (sandbox.map.width + BORDER_TILES * 2) * TILE_PX,
    h: (sandbox.map.height + BORDER_TILES * 2) * TILE_PX,
  }
}

export { OBJECT_KIND_LABEL }
