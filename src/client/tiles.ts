/**
 * 像素图集加载器：把内嵌的 base64 图集解码成可绘制对象，并提供按「列/行」取图的接口。
 *
 * 与上一版的区别：上一版所有素材是**代码里画的点阵**（字符矩阵），这一版是
 * **真实图集**（Kenney CC0，见 `sheetData.ts` 与 `assets/pack/README.md`）。
 *
 * 三条设计约束：
 *  1. **异步但只等一次**：图集解码是异步的（Image.onload / createImageBitmap），
 *     但同一个图集只解码一次，之后取图是同步的——地图每帧要画上千个精灵，
 *     不能在绘制路径上 await。
 *  2. **像素风不插值**：所有绘制入口都强制 `imageSmoothingEnabled = false`。
 *     少了这一条，浏览器会把 16×16 的像素插值成糊边，整个像素风就没了。
 *  3. **失败可见**：图集没解码出来时 drawTile 直接不画，并**只报一次**警告，
 *     而不是静默地画一片空白——空白地图最难查。
 */
import { SHEETS, type SheetKey, type SheetMeta } from './sheetData.ts'

export type { SheetKey }

/** 一张已解码的图集。 */
export interface LoadedSheet extends SheetMeta {
  image: CanvasImageSource
  /** 原始像素尺寸。 */
  width: number
  height: number
}

const loaded = new Map<string, LoadedSheet>()
const pending = new Map<string, Promise<LoadedSheet>>()
let warned = false

function decode(meta: SheetMeta): Promise<LoadedSheet> {
  const existing = loaded.get(meta.file)
  if (existing !== undefined) return Promise.resolve(existing)
  const inFlight = pending.get(meta.file)
  if (inFlight !== undefined) return inFlight

  const task = new Promise<LoadedSheet>((resolve, reject) => {
    const image = new Image()
    image.onload = () => {
      const sheet: LoadedSheet = {
        ...meta,
        image,
        width: image.naturalWidth,
        height: image.naturalHeight,
      }
      loaded.set(meta.file, sheet)
      pending.delete(meta.file)
      resolve(sheet)
    }
    image.onerror = () => {
      pending.delete(meta.file)
      reject(new Error(`图集解码失败：${meta.file}`))
    }
    image.src = meta.dataUri
  })
  pending.set(meta.file, task)
  return task
}

/** 预加载全部（或指定）图集。返回是否全部成功。 */
export async function loadSheets(keys?: readonly SheetKey[]): Promise<{ ok: boolean; failed: string[] }> {
  const list = keys === undefined ? (Object.keys(SHEETS) as SheetKey[]) : keys
  const failed: string[] = []
  await Promise.all(
    list.map(async (key) => {
      const meta = SHEETS[key]
      if (meta === undefined) {
        failed.push(String(key))
        return
      }
      try {
        await decode(meta)
      } catch {
        failed.push(key)
      }
    }),
  )
  if (failed.length > 0 && !warned) {
    warned = true
    console.error(`[paranim] 以下图集未能解码，相关元素将不绘制：${failed.join(', ')}`)
  }
  return { ok: failed.length === 0, failed }
}

/** 同步取一张已加载的图集；未加载完成时返回 undefined。 */
export function sheet(key: SheetKey): LoadedSheet | undefined {
  const meta = SHEETS[key]
  if (meta === undefined) return undefined
  return loaded.get(meta.file)
}

export function allSheetsReady(keys?: readonly SheetKey[]): boolean {
  const list = keys === undefined ? (Object.keys(SHEETS) as SheetKey[]) : keys
  return list.every((key) => {
    const meta = SHEETS[key]
    return meta !== undefined && loaded.has(meta.file)
  })
}

/** 描述一次取图：图集 + 列 + 行 + 跨几格宽高。 */
export interface TileRef {
  sheet: SheetKey
  col: number
  row: number
  /** 横向跨几格（默认 1），用于 2×1 之类的宽精灵。 */
  w?: number
  /** 纵向跨几格（默认 1）。 */
  h?: number
}

/**
 * 画一个图集精灵。
 *
 * 定位按**底部中心**锚定（`bottomY` 是精灵底边）：俯视图里"贴地"这件事靠的就是
 * 底边对齐，按中心锚定会让角色随精灵高度不同而浮在半空。
 */
export function drawTile(
  ctx: CanvasRenderingContext2D,
  ref: TileRef,
  cx: number,
  bottomY: number,
  scale: number,
): void {
  const s = sheet(ref.sheet)
  if (s === undefined) return
  const tile = s.tile
  const wTiles = ref.w ?? 1
  const hTiles = ref.h ?? 1
  const sx = ref.col * tile
  const sy = ref.row * tile
  const sw = wTiles * tile
  const sh = hTiles * tile
  if (sx < 0 || sy < 0 || sx + sw > s.width || sy + sh > s.height) return
  const dw = Math.round(sw * scale)
  const dh = Math.round(sh * scale)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(s.image, sx, sy, sw, sh, Math.round(cx - dw / 2), Math.round(bottomY - dh), dw, dh)
}

/** 画一个整格地面瓦片（左上角锚定，避免平铺时出现 1px 缝）。 */
export function drawGroundTile(
  ctx: CanvasRenderingContext2D,
  ref: TileRef,
  x: number,
  y: number,
  size: number,
): void {
  const s = sheet(ref.sheet)
  if (s === undefined) return
  const tile = s.tile
  const sx = ref.col * tile
  const sy = ref.row * tile
  if (sx < 0 || sy < 0 || sx + tile > s.width || sy + tile > s.height) return
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(s.image, sx, sy, tile, tile, Math.round(x), Math.round(y), Math.ceil(size), Math.ceil(size))
}

/**
 * 从图集里取一格的**原始像素**（用于按角色换色之类的处理）。
 * 只在需要逐像素改色的地方用；普通绘制走 GPU 路径，不要在这里逐帧取像素。
 */
export function tilePixels(ref: TileRef): ImageData | undefined {
  const s = sheet(ref.sheet)
  if (s === undefined) return undefined
  const canvas = document.createElement('canvas')
  canvas.width = s.tile
  canvas.height = s.tile
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) return undefined
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(s.image, ref.col * s.tile, ref.row * s.tile, s.tile, s.tile, 0, 0, s.tile, s.tile)
  return ctx.getImageData(0, 0, s.tile, s.tile)
}

/** 一张图集的网格信息（给"对照表"界面用）。 */
export function sheetGrid(key: SheetKey): { cols: number; rows: number; note: string } | undefined {
  const meta = SHEETS[key]
  if (meta === undefined) return undefined
  return { cols: meta.cols, rows: meta.rows, note: meta.note }
}
