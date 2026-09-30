/**
 * 小镇渲染层 —— 用真实像素图集（Kenney CC0）绘制俯视图。
 *
 * 绘制分三层，顺序不能变（后画的压住先画的）：
 *   1. **地形**：草地/土/石板/水，大面积连续，纹理靠少量变体而不是撒点
 *   2. **路网**：由 layout.ts 显式铺出来（Smallville 的辨识度就在那条贯穿全镇的
 *      黄泥路；没有它，房子只是散落在草地上的方块）
 *   3. **建筑**：每栋房子**有轮廓**——墙围一圈、屋顶在墙内、门朝路、窗按间距排。
 *      上一版是把整个占地用随机瓦片填满，那必然是一堆格子，矩形填色不构成建筑。
 *
 * 另外两条硬约束：
 *   · **只画视口内的格子**：140×100 全画是 14000 次 drawImage，缩小时九成在画布外
 *   · **不参与布局**：画布由 CSS 绝对定位铺满容器，渲染层不写影响父容器尺寸的属性
 */
import {
  OBJECT_KIND_LABEL,
  type ObjectKind,
  type Sandbox,
  type SandboxAgent,
  type WorldObject,
} from '../shared/model.ts'
import { BUILDING, CHARACTER, GROUND, PROPS, SYMBOLS, pickSlot } from './mapStyle.ts'
import { buildLayout, layoutKey, type TownLayout } from './layout.ts'
import { drawGroundTile, drawTile, type TileRef } from './tiles.ts'

/** 一格地图像素（图集瓦片原始尺寸）。 */
export const TILE_PX = 16
/** 世界之外留一圈草地边。 */
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
  tick?: number
}

function hash2(x: number, y: number, salt = 0): number {
  let h = (Math.round(x) * 374761393 + Math.round(y) * 668265263 + salt * 2246822519) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

// 布局缓存：同一份沙盒只算一次。键是地标几何 + 地图尺寸 + 自带地形长度。
let cachedLayout: { key: string; layout: TownLayout } | null = null

export function townLayout(sandbox: Sandbox): TownLayout {
  const key = layoutKey(sandbox)
  if (cachedLayout !== null && cachedLayout.key === key) return cachedLayout.layout
  const layout = buildLayout(sandbox)
  cachedLayout = { key, layout }
  return layout
}

// ── 地形 ──────────────────────────────────────────────────────────────────

const TERRAIN_SLOT: Record<string, string> = {
  grass: 'grass',
  grassAlt: 'grassPlain',
  dirt: 'dirt',
  stone: 'stone',
  sand: 'sand',
  water: 'stone',
  field: 'field',
}

function drawTerrain(ctx: CanvasRenderingContext2D, input: RenderInput, layout: TownLayout): void {
  const { sandbox, view, size } = input
  const { scale, offsetX, offsetY } = view
  const step = TILE_PX * scale
  if (step <= 0.05) return

  // 视口裁剪：只画看得见的格子
  const minX = Math.max(-BORDER_TILES, Math.floor(-offsetX / step) - 1)
  const maxX = Math.min(sandbox.map.width + BORDER_TILES, Math.ceil((size.w - offsetX) / step) + 1)
  const minY = Math.max(-BORDER_TILES, Math.floor(-offsetY / step) - 1)
  const maxY = Math.min(sandbox.map.height + BORDER_TILES, Math.ceil((size.h - offsetY) / step) + 1)

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const inside = x >= 0 && y >= 0 && x < layout.width && y < layout.height
      const slot = inside ? TERRAIN_SLOT[layout.terrain[y][x]] ?? 'grass' : 'void'
      // 草地用多候选做纹理；其它地形只给少数候选，避免路面花掉
      const n = slot === 'grass' ? hash2(x, y, 3) : hash2(x, y, 11)
      const ref = pickSlot(GROUND, slot, n) ?? pickSlot(GROUND, 'grassPlain', n)
      if (ref === undefined) continue
      drawGroundTile(ctx, ref, offsetX + x * step, offsetY + y * step, step + 0.5)
    }
  }
}

// ── 建筑 ──────────────────────────────────────────────────────────────────

/**
 * 画一栋房子：**墙围一圈，屋顶在墙内**。
 *
 * 关键约束（上一版就是在这里错的）：屋顶不能铺满整个占地，否则看到的是一个
 * 配色块而不是房子。墙必须留在最外一圈——它给出轮廓、门与窗的位置。
 */
function drawBuilding(ctx: CanvasRenderingContext2D, view: View, layout: TownLayout, index: number): void {
  const b = layout.buildings[index]
  const { scale, offsetX, offsetY } = view
  const step = TILE_PX * scale
  const px = (x: number): number => offsetX + x * step
  const py = (y: number): number => offsetY + y * step
  const w = b.right - b.left + 1
  const h = b.bottom - b.top + 1

  // 落地投影（压在墙脚外侧，让房子"坐"在草地上）
  ctx.fillStyle = 'rgba(20,28,20,0.22)'
  ctx.fillRect(px(b.left), py(b.bottom) + step * 0.55, w * step, Math.max(2, step * 0.45))

  const wallRef = pickSlot(BUILDING, 'wall', hash2(b.left, b.top, 71))
  const roofRef =
    pickSlot(BUILDING, b.roofSlot, hash2(b.left, b.top, 73)) ?? pickSlot(BUILDING, 'roofWarm', 0)

  for (let y = b.top; y <= b.bottom; y += 1) {
    for (let x = b.left; x <= b.right; x += 1) {
      const isEdge = x === b.left || x === b.right || y === b.bottom || y === b.top
      if (isEdge) {
        // 墙：外圈始终是墙——这是"房子"与"色块"的区别
        const isDoor = x === b.doorX && y === b.doorY
        const isWindow = b.windows.some((win) => win.x === x && win.y === y)
        const ref = isDoor
          ? pickSlot(BUILDING, 'door', 0)
          : isWindow
            ? pickSlot(BUILDING, 'window', 0)
            : wallRef
        if (ref !== undefined) drawGroundTile(ctx, ref, px(x), py(y), step + 0.5)
        continue
      }
      // 内部：屋顶区铺瓦，其余铺墙（俯视下看不到地板，用墙色更整洁）
      const inRoof = y >= b.roofTop && y <= b.roofBottom
      const ref = inRoof ? roofRef : wallRef
      if (ref !== undefined) drawGroundTile(ctx, ref, px(x), py(y), step + 0.5)
    }
  }
  // 屋脊：屋顶最上一行压一道深色，读起来才有"坡"
  if (scale >= 1 && roofRef !== undefined) {
    ctx.fillStyle = 'rgba(0,0,0,0.18)'
    ctx.fillRect(px(b.left), py(b.roofTop), w * step, Math.max(1, step * 0.22))
  }
}

// ── 物件 ──────────────────────────────────────────────────────────────────

function propSlotOf(object: WorldObject): string {
  const id = `${object.id} ${object.name}`.toLowerCase()
  const named: Array<[RegExp, string]> = [
    [/tree|树/, 'tree'],
    [/bush|灌木|花丛/, 'bush'],
    [/flower|花/, 'flower'],
    [/rock|石/, 'rock'],
    [/lamp|灯/, 'streetlamp'],
    [/sign|notice|board|告示|牌/, 'sign'],
    [/vehicle|truck|car|车|风车/, 'vehicle'],
  ]
  for (const [re, slot] of named) if (re.test(id)) return slot
  switch (object.kind as ObjectKind) {
    case 'plant':
      return 'tree'
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
  const bottom = offsetY + (object.y + 0.85) * TILE_PX * scale
  drawTile(ctx, ref, cx, bottom, scale)

  const status = String(object.state.status ?? '正常')
  if (status !== '正常') {
    const badge = pickSlot(SYMBOLS, 'broken', 0)
    if (badge !== undefined) drawTile(ctx, badge, cx + 6 * scale, bottom - 12 * scale, Math.max(0.45, scale * 0.6))
  }
}

// ── 角色 ──────────────────────────────────────────────────────────────────

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
  // 名牌只在放大到一定倍率才画：整镇视野下每格不到 1 像素，画了只是噪点
  if (scale >= 1.4) drawNameplate(ctx, agent.name, cx, bottom - 16 * scale - 3, selected)
  if (bubble !== undefined && scale >= 2) drawBubble(ctx, bubble, cx, bottom - 16 * scale - 20)
}

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
  const layout = townLayout(sandbox)

  ctx.clearRect(0, 0, size.w, size.h)
  ctx.fillStyle = '#0d1014'
  ctx.fillRect(0, 0, size.w, size.h)
  ctx.imageSmoothingEnabled = false

  drawTerrain(ctx, input, layout)

  // 植物先画（压在地面、建筑之下）
  for (const object of sandbox.objects) if (object.kind === 'plant') drawObject(ctx, view, object)

  // 建筑按 y 排序 → 后画的盖住前面，形成俯视遮挡
  const order = layout.buildings.map((_, i) => i).sort((a, b) => layout.buildings[a].bottom - layout.buildings[b].bottom)
  for (const i of order) drawBuilding(ctx, view, layout, i)
  if (hover?.objectId !== undefined) {
    // 悬停高亮：单独描一次边框（不重画建筑本体）
    const idx = layout.buildings.findIndex((b) => b.place.id === hover.objectId)
    if (idx >= 0) {
      const b = layout.buildings[idx]
      const step = TILE_PX * view.scale
      ctx.strokeStyle = '#ffc861'
      ctx.lineWidth = Math.max(1.5, view.scale * 0.8)
      ctx.strokeRect(
        view.offsetX + b.left * step - 1,
        view.offsetY + b.top * step - 1,
        (b.right - b.left + 1) * step + 2,
        (b.bottom - b.top + 1) * step + 2,
      )
    }
  }

  for (const object of sandbox.objects) if (object.kind !== 'plant') drawObject(ctx, view, object)

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
