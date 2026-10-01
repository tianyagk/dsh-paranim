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
import { BUILDING, CHARACTER, GROUND, OBJECT_LIBRARY, PROPS, SYMBOLS, pickSlot } from './mapStyle.ts'
import { buildLayout, layoutKey, type TownLayout } from './layout.ts'
import { hash2 } from './grid.ts'
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

/** 镜像的三个图层。 */
export type LayerName = 'background' | 'structure' | 'object'

export interface RenderInput {
  sandbox: Sandbox
  view: View
  size: { w: number; h: number }
  agents: SandboxAgent[]
  selectedId?: string
  hover?: { objectId?: string; agentId?: string }
  bubbles?: Map<string, string>
  tick?: number
  /**
   * 只画这一层（编辑镜像时用）。
   *
   * 不隔离的话，地面在建筑、植物、物件之下——玩家刷的那一格若正好被谁盖住，
   * 屏幕上不会有任何变化，看上去就是"涂了没反应"。分层显示让当前层的改动
   * 独占画面，所见即所改。
   */
  only?: LayerName
}

// 布局缓存：同一份沙盒只算一次。键是地标几何 + 地图尺寸 + 自带地形长度。
let cachedLayout: { key: string; layout: TownLayout } | null = null

function townLayout(sandbox: Sandbox): TownLayout {
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
  water: 'water',
  field: 'field',
  wood: 'wood',
  concrete: 'concrete',
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

  // 室内小房间（占地 ≤ 8×6）：**只画墙圈**，不铺屋顶。
  // 铺了屋顶就把房间里的家具与地面全盖住了——那正是"house 布局"最需要看见的东西。
  const isInterior = w <= 8 && h <= 6
  if (isInterior) {
    const wallRef = pickSlot(BUILDING, 'wall', hash2(b.left, b.top, 71))
    if (wallRef !== undefined) {
      for (let y = b.top; y <= b.bottom; y += 1) {
        for (let x = b.left; x <= b.right; x += 1) {
          const isEdge = x === b.left || x === b.right || y === b.bottom || y === b.top
          if (!isEdge) continue
          drawGroundTile(ctx, wallRef, px(x), py(y), step + 0.5)
        }
      }
    }
    ctx.fillStyle = 'rgba(20,28,20,0.18)'
    ctx.fillRect(px(b.left), py(b.bottom) + step * 0.55, (b.right - b.left + 1) * step, Math.max(2, step * 0.4))
    return
  }

  // 落地投影（压在墙脚外侧，让房子"坐"在草地上）
  ctx.fillStyle = 'rgba(20,28,20,0.22)'
  ctx.fillRect(px(b.left), py(b.bottom) + step * 0.55, w * step, Math.max(2, step * 0.45))

  const wallRef = pickSlot(BUILDING, 'wall', hash2(b.left, b.top, 71))
  // 屋顶族优先取数据里的 roofSlot（沙盒可以显式指定，例如 Smallville 镜像按原版
  // 建筑族写好了每处地点的屋顶配色）；没给才回落到按 tags 推导。
  const roofKey = b.roofSlot
  const roofRef =
    pickSlot(BUILDING, roofKey, hash2(b.left, b.top, 73)) ?? pickSlot(BUILDING, 'roofWarm', 0)

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

/**
 * 物件用哪张图。
 *
 * 优先级：**物件自己的 `sprite` 字段** → 资源池别名表 → 形状兜底。
 * 显式字段优先是刻意的：物件的样子是数据，玩家在资源池里挑了哪张贴图就该用哪张，
 * 不该被名字里的某个字重新决定。
 */
export function propSlotOf(object: WorldObject): string {
  if (typeof object.sprite === 'string' && object.sprite !== '') return object.sprite
  const text = `${object.id} ${object.name}`.toLowerCase()
  for (const entry of OBJECT_LIBRARY) {
    if (entry.alias === undefined) continue
    if (entry.alias.some((word) => text.includes(word.toLowerCase()))) return entry.slot
  }
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

/**
 * 该槽位还没有确认过的贴图时，画一个问号占位。
 *
 * 刻意**不**回退到别的图：把路面当成灌木画出来，看图的人只会怀疑自己的眼睛，
 * 而问题会一直藏在地图里。问号是明确的"这里缺一张图"，一眼就能数出还差几处。
 */
function drawPending(ctx: CanvasRenderingContext2D, cx: number, bottom: number, scale: number): void {
  const side = TILE_PX * scale
  const x = cx - side / 2
  const y = bottom - side
  ctx.save()
  ctx.strokeStyle = 'rgba(255,200,97,0.7)'
  ctx.lineWidth = Math.max(1, scale * 0.5)
  ctx.setLineDash([3 * scale, 2 * scale])
  ctx.strokeRect(x + 0.5, y + 0.5, side - 1, side - 1)
  ctx.setLineDash([])
  ctx.fillStyle = 'rgba(255,200,97,0.85)'
  ctx.font = `${Math.max(8, side * 0.55)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('?', cx, y + side / 2)
  ctx.restore()
}

function drawObject(ctx: CanvasRenderingContext2D, view: View, object: WorldObject): void {
  const { scale, offsetX, offsetY } = view
  const slot = propSlotOf(object)
  const n = hash2(object.x, object.y, 41)
  const ref = pickSlot(PROPS, slot, n) ?? pickSlot(PROPS, slot, 0)
  const cx = offsetX + object.x * TILE_PX * scale
  const bottom = offsetY + (object.y + 0.85) * TILE_PX * scale
  if (ref === undefined) {
    drawPending(ctx, cx, bottom, scale)
    return
  }
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

/**
 * 编辑时的格子辅助线。
 *
 * 只画当前图层之后，画面会失去参照（一片同色地面看不出自己站在哪一格）。
 * 网格不是"别的图层的内容"，它只帮人定位。
 */
function drawGrid(ctx: CanvasRenderingContext2D, view: View, size: { w: number; h: number }, sandbox: Sandbox): void {
  const step = TILE_PX * view.scale
  // 格子小于 6 像素时画线会糊成一片，直接不画
  if (step < 6) return
  const minX = Math.max(0, Math.floor(-view.offsetX / step))
  const maxX = Math.min(sandbox.map.width, Math.ceil((size.w - view.offsetX) / step))
  const minY = Math.max(0, Math.floor(-view.offsetY / step))
  const maxY = Math.min(sandbox.map.height, Math.ceil((size.h - view.offsetY) / step))
  // 每 8 格加粗一条，便于数格子
  ctx.lineWidth = 1
  for (let x = minX; x <= maxX; x += 1) {
    const px = Math.round(view.offsetX + x * step) + 0.5
    ctx.strokeStyle = x % 8 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)'
    ctx.beginPath()
    ctx.moveTo(px, view.offsetY + minY * step)
    ctx.lineTo(px, view.offsetY + maxY * step)
    ctx.stroke()
  }
  for (let y = minY; y <= maxY; y += 1) {
    const py = Math.round(view.offsetY + y * step) + 0.5
    ctx.strokeStyle = y % 8 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)'
    ctx.beginPath()
    ctx.moveTo(view.offsetX + minX * step, py)
    ctx.lineTo(view.offsetX + maxX * step, py)
    ctx.stroke()
  }
}

/**
 * structure 层的编辑视图：画**墙圈与门窗**，不画屋顶。
 *
 * 屋顶是给"看世界"用的；编辑边界时要看的是墙在哪、门开在哪一格——
 * 盖着屋顶就什么都判断不了。门的可通行位置直接决定智能体能不能进去。
 */
function drawStructureLayer(ctx: CanvasRenderingContext2D, view: View, sandbox: Sandbox): void {
  const step = TILE_PX * view.scale
  if (step <= 0.05) return
  const structs = sandbox.map.layers?.structure ?? []
  for (const s of structs) {
    const x = view.offsetX + s.x * step
    const y = view.offsetY + s.y * step
    const w = s.w * step
    const h = s.h * step
    // 墙体：实心描边围一圈
    ctx.fillStyle = 'rgba(122,162,247,0.10)'
    ctx.fillRect(x, y, w, h)
    ctx.strokeStyle = '#7aa2f7'
    ctx.lineWidth = Math.max(2, step * 0.28)
    ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth)
    // 门：绿色（可通行）
    ctx.fillStyle = '#7fc98b'
    for (const d of s.doors ?? []) {
      ctx.fillRect(view.offsetX + d.x * step, view.offsetY + d.y * step, step, step)
    }
    // 窗：青色（不可通行，只供隔窗相望）
    ctx.fillStyle = '#7ac7d9'
    for (const win of s.windows ?? []) {
      ctx.fillRect(view.offsetX + win.x * step, view.offsetY + win.y * step, step, step)
    }
    // 名字：格子够大才画，否则会糊成一团
    if (step >= 10) {
      ctx.fillStyle = 'rgba(238,242,248,0.85)'
      ctx.font = `${Math.max(9, Math.min(13, step))}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(s.name, x + w / 2, y + h / 2)
    }
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────

/**
 * 画布像素 → 世界格坐标。
 *
 * **一格占多少屏幕像素**是 `TILE_PX * scale`，分母必须是它。
 * 这里曾经写成 `scale`，整整差了一个 TILE_PX（16 倍）：点在画布正中会算出
 * (255,191)，而地图只有 32×24——每次点击都被"格子越界"挡掉。笔刷没反应、
 * 右键点不中物件、悬停不亮，全是这一个原因，而且不报任何错。
 *
 * 抽成纯函数是为了能单测：这类换算错了，画面上看不出异常（地图本身画得对），
 * 只有真的去点才暴露，所以必须有一条断言钉着它。
 */
export function screenToWorld(px: number, py: number, view: View): { x: number; y: number } {
  const step = TILE_PX * view.scale
  return { x: (px - view.offsetX) / step, y: (py - view.offsetY) / step }
}

/** 世界格坐标 → 画布像素（左上角）。与 screenToWorld 互为逆运算。 */
export function worldToScreen(x: number, y: number, view: View): { px: number; py: number } {
  const step = TILE_PX * view.scale
  return { px: view.offsetX + x * step, py: view.offsetY + y * step }
}

export function renderTown(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { sandbox, view, size, agents, selectedId, hover, only } = input
  const tick = input.tick ?? 0
  const layout = townLayout(sandbox)

  ctx.clearRect(0, 0, size.w, size.h)
  ctx.fillStyle = '#0d1014'
  ctx.fillRect(0, 0, size.w, size.h)
  ctx.imageSmoothingEnabled = false

  if (only !== undefined) {
    drawGrid(ctx, view, size, sandbox)
    if (only === 'background') {
      drawTerrain(ctx, input, layout)
    } else if (only === 'structure') {
      drawStructureLayer(ctx, view, sandbox)
    } else {
      // 物件层：只画物件（含植物，它们也是物件层的东西）
      for (const object of sandbox.objects) drawObject(ctx, view, object)
    }
    return
  }

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
