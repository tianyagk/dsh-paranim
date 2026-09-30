/**
 * 小镇渲染层 —— 像素风 RPG 的俯视图。
 *
 * 全部图元来自 `pixelart.ts` 的**内联点阵素材**（16×16 地面瓦片、16×24 建筑、
 * 16×18 四向行走图、以及路灯/长椅/喷泉/摊位等物件），因此：
 *  · 画风统一——同一份调色板、同样的 1px 暖黑描边、同样的硬边分阶；
 *  · 体积可控——整套素材是几十 KB 的源码，不是 MB 级 PNG 图集；
 *  · 可审计——玩家想改路灯的样子，改几行字符即可。
 *
 * 三条硬约束（沿用上一版，都是踩过坑换来的）：
 *  1. **确定性**：地面变体、树位、装饰全部由坐标派生，同一份沙盒每次重绘一致，
 *     拖动缩放不会抖。
 *  2. **不臆造**：地标、物件、角色坐标全部来自沙盒数据（原版 arena_maze.csv 解析），
 *     程序只决定"怎么画"。
 *  3. **不参与布局**：画布由 CSS 绝对定位铺满容器，渲染层不写影响父容器尺寸的属性。
 */
import {
  OBJECT_KIND_LABEL,
  type ObjectKind,
  type Sandbox,
  type SandboxAgent,
  type WorldObject,
} from '../shared/model.ts'
import {
  BUILDING_SPRITES,
  GROUND_SPRITES,
  PROP_SPRITES,
  ROAD_SPRITES,
  TREE_SPRITES,
  WALKER_FRAMES,
  WATER_SPRITES,
  clearSpriteCache,
  drawSprite,
  drawTile,
  recolorWalker,
  spriteCanvas,
  type Facing,
  type Sprite,
} from './pixelart.ts'

/** 一格地图像素（精灵原始尺寸）。视图缩放小于 1 时按最近邻缩绘，不糊。 */
export const TILE_PX = 16

/** 天空之外的留白：地图四周留一圈草地边，让小镇不顶到画布边缘。 */
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
  /** 世界步数：用来驱动行走动画的帧选择（同一格不抖）。 */
  tick?: number
}

// ── 确定性伪随机 ──────────────────────────────────────────────────────────

function hash2(x: number, y: number, salt = 0): number {
  let h = (Math.round(x) * 374761393 + Math.round(y) * 668265263 + salt * 2246822519) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

function pick<T>(list: readonly T[], n: number): T {
  return list[Math.min(list.length - 1, Math.floor(n * list.length))]
}

// ── 建筑配色：按 tags 归类，同一类共享一套屋顶色 ─────────────────────────

type BuildingFamily = keyof typeof BUILDING_SPRITES

function buildingFamily(place: WorldObject): BuildingFamily {
  const tags = (place.tags ?? []).join(' ')
  if (tags.includes('社交') || tags.includes('餐饮')) return 'warm'
  if (tags.includes('商业')) return 'cool'
  if (tags.includes('学术')) return 'violet'
  if (tags.includes('公共')) return 'moss'
  if (tags.includes('住宅')) return 'clay'
  if (tags.includes('户外')) return 'moss'
  return 'clay'
}

/** 物件的精灵选择：先按 id 认名字，再按 kind 兜底。 */
function propSpriteOf(object: WorldObject): { sprite: Sprite; key: string } | undefined {
  const id = object.id.toLowerCase()
  const named: Array<[RegExp, string]> = [
    [/lamp|灯/, 'lamp'],
    [/bench|椅/, 'bench'],
    [/bin|trash|垃圾/, 'bin'],
    [/fountain|喷泉/, 'fountain'],
    [/sign|notice|board|告示|牌/, 'sign'],
    [/stall|摊/, 'stall'],
    [/well|井/, 'well'],
    [/vending|售货/, 'vending'],
    [/campfire|篝火|fire/, 'campfire'],
    [/windmill|风车/, 'windmill'],
    [/bike|自行车/, 'bike'],
    [/tree|树/, 'tree'],
    [/bush|灌木|花丛/, 'bush'],
  ]
  for (const [re, name] of named) {
    if (re.test(id)) {
      const sprite = PROP_SPRITES[name]
      if (sprite !== undefined) return { sprite, key: `prop.${name}` }
    }
  }
  switch (object.kind as ObjectKind) {
    case 'plant':
      return { sprite: TREE_SPRITES[1], key: 'tree.1' }
    case 'fixture':
      return { sprite: PROP_SPRITES.lamp, key: 'prop.lamp' }
    case 'vehicle':
      return { sprite: PROP_SPRITES.bike, key: 'prop.bike' }
    case 'sign':
      return { sprite: PROP_SPRITES.sign, key: 'prop.sign' }
    default:
      return { sprite: PROP_SPRITES.bin, key: 'prop.bin' }
  }
}

/** 角色的四向与发色/衣色：由 id 派生，所以每次重绘同一个人长得一样。 */
function walkerOf(agent: SandboxAgent, tick: number, moving: boolean) {
  const seed = hash2(agent.name.length * 7 + agent.id.length, agent.id.charCodeAt(0), 11)
  const hair = pick(['2', '3', '4'], seed)
  const cloth = pick(['5', '6', '7', '8', '9'], hash2(seed * 1000, 3, 5))
  const facingIndex = Math.floor(hash2(agent.x, agent.y, 21) * 3)
  const facing: Facing = (['down', 'side', 'up'] as const)[facingIndex]
  const frames = WALKER_FRAMES[facing]
  const frame = moving ? Math.abs(Math.round(tick + hash2(agent.x, agent.y, 33) * 2)) % 2 : 0
  const spriteData = recolorWalker(frames[frame].rows, hair, cloth)
  return { sprite: spriteData, key: `walker.${facing}.${frame}.${hair}.${cloth}` }
}

// ── 地面 ──────────────────────────────────────────────────────────────────

/**
 * 地面层：逐格铺。
 *
 * 只画视口内的格子——140×100 全画是 14000 次 drawImage，缩放到 1 倍时其中九成
 * 在画布外。裁剪之后帧率稳定，滚到哪画到哪。
 */
function drawGround(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { sandbox, view, size } = input
  const { scale, offsetX, offsetY } = view
  const step = TILE_PX * scale
  if (step <= 0.05) return

  const minX = Math.max(-BORDER_TILES, Math.floor((0 - offsetX) / step) - 1)
  const maxX = Math.min(sandbox.map.width + BORDER_TILES, Math.ceil((size.w - offsetX) / step) + 1)
  const minY = Math.max(-BORDER_TILES, Math.floor((0 - offsetY) / step) - 1)
  const maxY = Math.min(sandbox.map.height + BORDER_TILES, Math.ceil((size.h - offsetY) / step) + 1)

  // 沙盒可以自带 tiles（字符画），没给就用草/路/石板三层的推导结果
  const tiles = sandbox.map.tiles

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const px = offsetX + x * step
      const py = offsetY + y * step
      const n = hash2(x, y, 1)
      const inside = x >= 0 && y >= 0 && x < sandbox.map.width && y < sandbox.map.height
      const char = inside && tiles !== undefined ? (tiles[y] ?? '')[x] ?? 'g' : inside ? undefined : 'o'

      let layer: { sprite: Sprite; key: string } | undefined
      if (char === 'o') {
        // 边界外的草地边：用最暗的草，视觉上"收口"
        layer = { sprite: GROUND_SPRITES[3], key: 'ground.out.3' }
      } else if (char === 'w') {
        layer = { sprite: pick(WATER_SPRITES, n), key: `water.${Math.floor(n * WATER_SPRITES.length)}` }
      } else if (char === 'r') {
        layer = { sprite: pick(ROAD_SPRITES, n), key: `road.${Math.floor(n * ROAD_SPRITES.length)}` }
      } else if (char === 'p' || char === 's') {
        layer = { sprite: ROAD_SPRITES[1], key: 'road.stone' }
      } else if (char === 'z') {
        layer = { sprite: ROAD_SPRITES[1], key: 'road.stone' }
      } else {
        layer = { sprite: pick(GROUND_SPRITES, n), key: `ground.${Math.floor(n * GROUND_SPRITES.length)}` }
      }
      drawTile(ctx, layer.sprite, layer.key, px, py, step + 1)
    }
  }
}

// ── 物件与建筑 ────────────────────────────────────────────────────────────

function drawObjectSprite(ctx: CanvasRenderingContext2D, view: View, object: WorldObject): void {
  const chosen = propSpriteOf(object)
  if (chosen === undefined) return
  const { scale, offsetX, offsetY } = view
  const cx = offsetX + object.x * TILE_PX * scale
  const bottom = offsetY + (object.y + 0.6) * TILE_PX * scale

  // 精灵按原始格宽等比缩放：路灯是 1 格宽，树是 1~2 格，长椅略宽
  const spriteScale = Math.max(0.35, scale)
  drawSprite(ctx, chosen.sprite, chosen.key, cx, bottom, spriteScale)

  // 故障状态：在物件上方压一个红点，而不是给整个精灵染色
  const status = String(object.state.status ?? '正常')
  if (status !== '正常') {
    const r = Math.max(1.5, spriteScale * 1.6)
    ctx.fillStyle = '#f07178'
    ctx.beginPath()
    ctx.arc(cx + spriteScale * 5, bottom - chosen.sprite.h * spriteScale - r, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = 'rgba(20,16,20,0.7)'
    ctx.lineWidth = 1
    ctx.stroke()
  }
}

function drawBuilding(ctx: CanvasRenderingContext2D, view: View, place: WorldObject, hovered: boolean): void {
  const family = buildingFamily(place)
  const spriteData = BUILDING_SPRITES[family]
  const { scale, offsetX, offsetY } = view
  const wTiles = Math.max(2, place.w ?? 4)
  const hTiles = Math.max(2, place.h ?? 4)
  const cx = offsetX + place.x * TILE_PX * scale
  const bottom = offsetY + (place.y + hTiles / 2) * TILE_PX * scale

  // 建筑按占地宽度拉伸到合适大小（精灵只有一种尺寸，靠缩放适配不同占地）
  const targetW = wTiles * TILE_PX * scale * 0.95
  const spriteScale = Math.max(0.4, targetW / spriteData.w)
  drawSprite(ctx, spriteData, `building.${family}`, cx, bottom, spriteScale)

  // 投影：一条压在地面的暗带，让建筑"坐"在草地上
  ctx.fillStyle = 'rgba(24,32,24,0.22)'
  const shadowH = Math.max(2, spriteScale * 3)
  ctx.beginPath()
  ctx.ellipse(cx, bottom + shadowH * 0.2, targetW * 0.46, shadowH, 0, 0, Math.PI * 2)
  ctx.fill()

  if (hovered) {
    ctx.strokeStyle = '#ffd479'
    ctx.lineWidth = Math.max(1.5, scale * 0.8)
    ctx.strokeRect(
      cx - targetW / 2 - 2,
      bottom - spriteData.h * spriteScale - 2,
      targetW + 4,
      spriteData.h * spriteScale + 4,
    )
  }
}

// ── 名牌与气泡 ────────────────────────────────────────────────────────────

/** 像素风名牌：暖黑底 + 1px 亮描边 + 浅字，和精灵的描边同一套逻辑。 */
function drawLabel(ctx: CanvasRenderingContext2D, text: string, cx: number, bottomY: number, strong: boolean): void {
  ctx.font = '10px ui-monospace, "PingFang SC", "Microsoft YaHei", monospace'
  const metrics = ctx.measureText(text)
  const padX = 4
  const boxW = metrics.width + padX * 2
  const boxH = 14
  const x = Math.round(cx - boxW / 2)
  const y = Math.round(bottomY - boxH)
  // 底 + 描边（不用阴影：像素风靠硬边）
  ctx.fillStyle = strong ? 'rgba(32,26,22,0.92)' : 'rgba(28,24,22,0.78)'
  ctx.fillRect(x, y, Math.round(boxW), boxH)
  ctx.strokeStyle = strong ? '#ffd479' : 'rgba(244,246,250,0.35)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, Math.round(boxW) - 1, boxH - 1)
  ctx.fillStyle = strong ? '#ffe9b0' : '#f4f6fa'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, Math.round(cx), y + boxH / 2 + 0.5)
}

function drawBubble(ctx: CanvasRenderingContext2D, text: string, cx: number, topY: number): void {
  const clipped = text.length > 20 ? `${text.slice(0, 19)}…` : text
  ctx.font = '10px system-ui, "PingFang SC", sans-serif'
  const w = Math.min(190, ctx.measureText(clipped).width + 14)
  const h = 18
  const x = Math.round(cx - w / 2)
  const y = Math.round(topY - h - 6)
  // 像素风的圆角感：切掉四角而不是画圆角
  ctx.fillStyle = 'rgba(250,247,240,0.96)'
  ctx.fillRect(x + 1, y, w - 2, h)
  ctx.fillRect(x, y + 1, w, h - 2)
  ctx.strokeStyle = 'rgba(42,35,32,0.85)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  // 指向下方的小尖角
  ctx.fillStyle = 'rgba(250,247,240,0.96)'
  ctx.fillRect(cx - 2, y + h, 4, 3)
  ctx.strokeStyle = 'rgba(42,35,32,0.85)'
  ctx.strokeRect(cx - 2.5, y + h - 0.5, 5, 3.5)
  ctx.fillStyle = '#2a2320'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(clipped, Math.round(cx), y + h / 2 + 0.5)
}

function drawAgent(ctx: CanvasRenderingContext2D, view: View, agent: SandboxAgent, tick: number, selected: boolean, bubble?: string): void {
  const { scale, offsetX, offsetY } = view
  const cx = offsetX + (agent.x + 0.5) * TILE_PX * scale
  const bottom = offsetY + (agent.y + 1) * TILE_PX * scale
  const spriteScale = Math.max(0.4, scale)

  // 脚下投影（椭圆，硬边）
  ctx.fillStyle = 'rgba(24,32,24,0.25)'
  ctx.beginPath()
  ctx.ellipse(cx, bottom - spriteScale, spriteScale * 6, spriteScale * 2.4, 0, 0, Math.PI * 2)
  ctx.fill()

  const walker = walkerOf(agent, tick, tick > 0)
  drawSprite(ctx, walker.sprite, walker.key, cx, bottom, spriteScale)

  if (selected) {
    ctx.strokeStyle = '#ffd479'
    ctx.lineWidth = Math.max(1.5, scale)
    const r = spriteScale * 9
    ctx.beginPath()
    ctx.arc(cx, bottom - spriteScale * 9, r, 0, Math.PI * 2)
    ctx.stroke()
  }

  if (scale >= 0.55) {
    drawLabel(ctx, agent.name, cx, bottom - spriteScale * 18 - 3, selected)
  }
  if (bubble !== undefined && scale >= 1) {
    drawBubble(ctx, bubble, cx, bottom - spriteScale * 18 - 18)
  }
}

// ── 主入口 ────────────────────────────────────────────────────────────────

export function renderTown(ctx: CanvasRenderingContext2D, input: RenderInput): void {
  const { sandbox, view, size, agents, selectedId, hover } = input
  const tick = input.tick ?? 0
  ctx.clearRect(0, 0, size.w, size.h)
  // 世界之外是暗色工作台，小镇边界一眼看得清
  ctx.fillStyle = '#0d1014'
  ctx.fillRect(0, 0, size.w, size.h)
  ctx.imageSmoothingEnabled = false

  drawGround(ctx, input)

  // 物件：植物先画（压在地面上、建筑下），其它物件后画
  const plants = sandbox.objects.filter((o) => o.kind === 'plant')
  const rest = sandbox.objects.filter((o) => o.kind !== 'plant')
  for (const object of plants) drawObjectSprite(ctx, view, object)

  // 建筑按 y 排序：靠后的先画，靠前的后画，形成俯视遮挡关系
  const places = [...sandbox.places].sort((a, b) => a.y - b.y)
  for (const place of places) drawBuilding(ctx, view, place, hover?.objectId === place.id)
  for (const object of rest) drawObjectSprite(ctx, view, object)

  // 角色按 y 排序（同一套遮挡规则），选中者最后画
  const walkers = [...agents].sort((a, b) => (a.y === b.y ? Number(a.id === selectedId) - Number(b.id === selectedId) : a.y - b.y))
  for (const agent of walkers) {
    drawAgent(ctx, view, agent, tick, agent.id === selectedId, input.bubbles?.get(agent.id))
  }
}

export { OBJECT_KIND_LABEL, clearSpriteCache, spriteCanvas }

/** 一张索引色像素贴图在给定尺寸下需要的原始像素数（供视图换算用）。 */
export function mapPixelSize(sandbox: Sandbox): { w: number; h: number } {
  return { w: (sandbox.map.width + BORDER_TILES * 2) * TILE_PX, h: (sandbox.map.height + BORDER_TILES * 2) * TILE_PX }
}
