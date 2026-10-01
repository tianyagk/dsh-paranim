/**
 * 小镇画布渲染。
 *
 * 数据只有一份：**瓦片图**（见 shared/model.ts 的 MapLayers）。三个图层自下而上
 * 叠出来——background 地面、structure 墙体、object 门窗物件——再由上面画角色。
 *
 * 这里没有"按地标推导建筑"那一层了。上一版要根据 places 矩形反推墙在哪、屋顶
 * 铺几行、路怎么连，于是同一栋房子在数据里是一回事、画出来又是另一回事，两边
 * 一旦不一致就只能靠肉眼发现。现在墙就是墙的瓦片，画与判定读的是同一格数据。
 */
import type { Sandbox, SandboxAgent, TileLayer, Tileset } from '../shared/model.ts'
import { resolveRef, tileOrigin } from '../shared/tilemap.ts'
import { hash2 } from './grid.ts'
import { CHARACTER, pickSlot } from './mapStyle.ts'
import { sheet as builtinSheet } from './tiles.ts'
import { drawTile } from './tiles.ts'

/** 一格地图像素（素材瓦片原始尺寸的基准）。 */
export const TILE_PX = 16

export interface View {
  scale: number
  offsetX: number
  offsetY: number
}

export type LayerName = 'background' | 'structure' | 'object'

export interface RenderInput {
  sandbox: Sandbox
  view: View
  size: { w: number; h: number }
  agents: SandboxAgent[]
  /** 图集 id → 已解码的图片。渲染是同步的，加载由调用方先做完。 */
  images: Map<string, CanvasImageSource>
  selectedId?: string
  hover?: { x?: number; y?: number; agentId?: string }
  bubbles?: Map<string, string>
  tick?: number
  /**
   * 只画这一层（编辑镜像时用）。
   *
   * 不隔离的话，地面会被建筑、物件盖住——玩家刷的那一格若正好在谁下面，
   * 屏幕上不会有任何变化，看上去就是"涂了没反应"。
   */
  only?: LayerName
  /** 编辑时的格子辅助线。 */
  showGrid?: boolean
}


/** 地图的像素尺寸（缩放与平移的基准）。 */
export function mapPixelSize(sandbox: Sandbox): { w: number; h: number } {
  return { w: sandbox.map.width * TILE_PX, h: sandbox.map.height * TILE_PX }
}

/**
 * 一格占多少屏幕像素。
 *
 * **所有"格 ↔ 像素"的换算都必须走它**。曾经各处直接写 `TILE_PX * scale`，
 * 于是有的地方漏乘了——那一处把分母写成了 scale，整整差 16 倍：点画布正中
 * 算出 (255,191)，而地图只有 32×24，每次点击都被"格子越界"丢掉。笔刷没反应、
 * 右键点不中、悬停不亮全是这一个原因，而且画面上完全看不出异常（地图画得对，
 * 只有真的去点才暴露）。抽成一个函数是防它复发：新手写错的机会只剩一处。
 */
export function stepOf(view: View): number {
  return TILE_PX * view.scale
}

/**
 * 画布像素 → 世界格坐标（分母见 stepOf）。
 */
export function screenToWorld(px: number, py: number, view: View): { x: number; y: number } {
  const step = stepOf(view)
  return { x: (px - view.offsetX) / step, y: (py - view.offsetY) / step }
}

/** 世界格坐标 → 画布像素（左上角）。与 screenToWorld 互逆。 */
export function worldToScreen(x: number, y: number, view: View): { px: number; py: number } {
  const step = stepOf(view)
  return { px: view.offsetX + x * step, py: view.offsetY + y * step }
}

/** 一层的可见格范围（视口裁剪，别去画屏幕外的几千格）。 */
function visibleRange(input: RenderInput): { minX: number; maxX: number; minY: number; maxY: number } {
  const { sandbox, view, size } = input
  const step = stepOf(view)
  return {
    minX: Math.max(0, Math.floor(-view.offsetX / step) - 1),
    maxX: Math.min(sandbox.map.width - 1, Math.ceil((size.w - view.offsetX) / step) + 1),
    minY: Math.max(0, Math.floor(-view.offsetY / step) - 1),
    maxY: Math.min(sandbox.map.height - 1, Math.ceil((size.h - view.offsetY) / step) + 1),
  }
}

/** 画一层瓦片。上层的透明像素会露出下层，所以顺序就是层叠顺序。 */
function drawLayer(ctx: CanvasRenderingContext2D, input: RenderInput, which: LayerName): void {
  const { sandbox, view, images } = input
  const step = stepOf(view)
  if (step <= 0.05) return
  const layer = sandbox.map.layers[which]
  const { minX, maxX, minY, maxY } = visibleRange(input)
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const t = resolveRef(sandbox.map, layer.cells[y * sandbox.map.width + x])
      if (t === undefined) continue
      const img = images.get(t.tileset.id)
      if (img === undefined) continue
      const o = tileOrigin(t.tileset, t.col, t.row)
      // +0.5 是为了让相邻格之间不留缝：缩放后 step 常常不是整数
      ctx.drawImage(img, o.x, o.y, t.tileset.tileW, t.tileset.tileH,
        view.offsetX + x * step, view.offsetY + y * step, step + 0.5, step + 0.5)
    }
  }
}

/**
 * 编辑时的格子辅助线。
 *
 * 只画当前图层之后画面会失去参照（一片同色地面看不出自己站在哪一格）。
 * 网格不是"别的图层的内容"，它只帮人定位。
 */
function drawGrid(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { sandbox, view, size } = input
  const step = stepOf(view)
  if (step < 6) return   // 格子太小时画线会糊成一片
  const { minX, maxX, minY, maxY } = visibleRange(input)
  const left = view.offsetX + minX * step
  const right = view.offsetX + (maxX + 1) * step
  const top = view.offsetY + minY * step
  const bottom = view.offsetY + (maxY + 1) * step
  ctx.lineWidth = 1
  for (let x = minX; x <= maxX + 1; x += 1) {
    const px = Math.round(view.offsetX + x * step) + 0.5
    ctx.strokeStyle = x % 8 === 0 ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)'
    ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bottom); ctx.stroke()
  }
  for (let y = minY; y <= maxY + 1; y += 1) {
    const py = Math.round(view.offsetY + y * step) + 0.5
    ctx.strokeStyle = y % 8 === 0 ? 'rgba(255,255,255,0.20)' : 'rgba(255,255,255,0.07)'
    ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(right, py); ctx.stroke()
  }
  // 世界边界描一圈，免得刷到图外才发现
  ctx.strokeStyle = 'rgba(255,200,97,0.5)'
  ctx.lineWidth = 1
  ctx.strokeRect(Math.round(view.offsetX) + 0.5, Math.round(view.offsetY) + 0.5,
    sandbox.map.width * step, sandbox.map.height * step)
}

/**
 * 画布像素 → 整格坐标。
 *
 * `floor` 而不是 `round`：round 取的是"离最近格中心最近的那一格"，于是点
 * 在格子偏左/偏上的半边时会跳到相邻格——看上去就是"光标不在所选网格里"。
 * 拖拽智能体时这一点更要紧：落点就是这一格，吸不吸附全看它。
 */
export function cellAtPoint(px: number, py: number, view: View): { x: number; y: number } {
  const w = screenToWorld(px, py, view)
  return { x: Math.floor(w.x), y: Math.floor(w.y) }
}

/** 悬停格高亮：编辑时最要紧的反馈——知道下一笔会落在哪一格。 */
function drawHoverCell(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { view, hover } = input
  if (hover?.x === undefined || hover.y === undefined) return
  const step = stepOf(view)
  const { px, py } = worldToScreen(hover.x, hover.y, view)
  ctx.strokeStyle = '#ffc861'
  ctx.lineWidth = Math.max(1.5, step * 0.12)
  ctx.strokeRect(px + 0.5, py + 0.5, step - 1, step - 1)
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
  images: Map<string, CanvasImageSource>,
  sandbox: Sandbox,
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
  /**
   * 外观优先用自定义瓦片（用户挑的/上传的），否则退回内置角色表。
   * 自定义的那种要按**图集自己的格子尺寸**取图，不能假定 16×16。
   */
  const custom = agent.sprite === undefined ? undefined : resolveRef(sandbox.map, agent.sprite)
  const customImg = custom === undefined ? undefined : images.get(custom.tileset.id)
  if (custom !== undefined && customImg !== undefined) {
    const o = tileOrigin(custom.tileset, custom.col, custom.row)
    const side = TILE_PX * scale
    ctx.drawImage(customImg, o.x, o.y, custom.tileset.tileW, custom.tileset.tileH,
      cx - side / 2, bottom - side, side, side)
  } else if (ref !== undefined) {
    drawTile(ctx, ref, cx, bottom, scale)
  }

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
 * 主入口：按图层自下而上叠出地图，再把角色画在最上面。
 *
 * 角色的位置**不写进 object 层**——它们每一 tick 都在动，塞进瓦片图只会让
 * "地图数据"变成"某一帧的快照"。用户要求的"智能体属于最上层"是视觉层级，
 * 所以这里用绘制顺序表达，而不是数据位置。
 */
/** 图层的叠放次序（下 → 上）。 */
export const LAYER_ORDER: readonly LayerName[] = ['background', 'structure', 'object']

/**
 * 这一帧该画哪些层、各自的透明度是多少。
 *
 * 抽成纯函数是为了能单测：它决定了"编辑时看不看得见参照"，而这件事
 * 错了在画面上不一定看得出来（少一层就是少一层，不会报错）。
 *
 * 规则：当前层不透明；**它下面的层以 0.3 淡显当参照**；它上面的层不画
 * （还没轮到，而且会盖住正在编辑的东西）。
 * 已编辑 background 时没有下层，所以最底层永远是 1.0。
 */
export function layerDrawPlan(only?: LayerName): Array<{ layer: LayerName; alpha: number }> {
  if (only === undefined) return LAYER_ORDER.map((layer) => ({ layer, alpha: 1 }))
  const editing = LAYER_ORDER.indexOf(only)
  if (editing < 0) return LAYER_ORDER.map((layer) => ({ layer, alpha: 1 }))
  return LAYER_ORDER.slice(0, editing + 1).map((layer, i) => ({
    layer,
    alpha: i === editing ? 1 : 0.3,
  }))
}

export function renderTown(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { size, agents, selectedId, bubbles, only, showGrid } = input
  const tick = input.tick ?? 0

  ctx.clearRect(0, 0, size.w, size.h)
  ctx.fillStyle = '#0d1014'
  ctx.fillRect(0, 0, size.w, size.h)
  ctx.imageSmoothingEnabled = false

  /**
   * 图层自下而上。
   *
   * 编辑某一层时，**下层以低透明度显出来当参照**，上层完全不画。
   * 只画当前层是不行的：一片纯色地面上没有墙也没有路，根本判断不出
   * 这栋房子该摆在哪；而把上层也画出来又会盖住正在编辑的东西。
   * 上层（only 之上的那些）反正是"还没轮到画"的，保持不画即可。
   */
  for (const { layer, alpha } of layerDrawPlan(only)) {
    ctx.globalAlpha = alpha
    drawLayer(ctx, input, layer)
  }
  ctx.globalAlpha = 1

  if (showGrid === true) drawGrid(ctx, input)
  drawHoverCell(ctx, input)

  for (const agent of agents) {
    drawAgent(ctx, input.view, agent, tick, agent.id === selectedId, input.images, input.sandbox, bubbles?.get(agent.id))
  }
}

// ── 图集图片的取得 ────────────────────────────────────────────────────────

/** 内置图集的 key（sheetData 里登记过的）。 */
import type { SheetKey } from './sheetData.ts'

const SHEET_KEYS: readonly string[] = ['tiny-town', 'tiny-farm', 'tiny-battle', 'onebit', 'city', 'characters']

export function builtinImage(key: string): CanvasImageSource | undefined {
  if (!SHEET_KEYS.includes(key)) return undefined
  return builtinSheet(key as SheetKey)?.image
}

/** 用户图集（data URI）的解码缓存。 */
const userImages = new Map<string, HTMLImageElement>()

/**
 * 取某个图集的图片。内置的同步可得；用户载入的第一次可能还没解码完，
 * 返回 undefined 并开始加载，加载完成后由调用方触发重绘。
 */
export function tilesetImage(tileset: { id: string; image: string }): CanvasImageSource | undefined {
  if (tileset.image === '') return builtinImage(tileset.id)
  const hit = userImages.get(tileset.id)
  if (hit !== undefined) return hit
  if (userImages.has(tileset.id)) return undefined
  const img = new Image()
  userImages.set(tileset.id, img)
  img.onload = () => {
    // 加载完成没有回调链：调用方（MapCanvas）靠 sheetsReady 轮询或重渲染触发
    img.decode?.().catch(() => {})
  }
  img.src = tileset.image
  return undefined
}


/** 收集一个沙盒要用的所有图片。没就绪的图集会被跳过并开始加载。 */
export function collectImages(sandbox: Sandbox): Map<string, CanvasImageSource> {
  const out = new Map<string, CanvasImageSource>()
  for (const tileset of sandbox.map.tilesets) {
    const img = tilesetImage(tileset)
    if (img !== undefined) out.set(tileset.id, img)
  }
  return out
}
