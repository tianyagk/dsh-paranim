/**
 * 地图风格配置：**「哪一类东西用图集里的哪几格」**全在这一个文件里。
 *
 * ⚠️ 序号不是猜的：每一格都用 `npm run find-tile --near R,G,B` 按**实测平均色**
 * 反查过（脚本在 scripts/find-tile.mjs，读的是归一后的网格）。改动请沿用这个流程——
 * 序号错一格，地图就变成一堆无意义色块，而且不报错、typecheck 也看不见。
 *
 * 配置形状：一个键 = 一个语义槽位，值 = 候选格列表（渲染时按坐标确定性挑一个）。
 * 地面给多个候选是为了不做成棋盘；屋顶/墙只给 1–2 个，因为它们本来就该一致。
 * 候选为空数组 = 该槽位暂无素材，渲染层**跳过而不是画错格子**。
 */
import type { TileRef } from './tiles.ts'

/** 语义槽位 → 候选瓦片。 */
export type SlotTable = Record<string, readonly TileRef[]>

function at(sheet: TileRef['sheet'], col: number, row: number): TileRef {
  return { sheet, col, row }
}

const T = 'tiny-town' as const
const F = 'tiny-farm' as const

/**
 * 地面。实测色：
 *  · 草地 #528e4c —— tiny-farm 9:8/9:9 是整格纯绿（主色占比 0.72–0.78），
 *    最适合大面积平铺；tiny-town 的 r0–r3 绿格带草簇/花，拿来做点缀变体。
 *  · 土路 #c1b06a —— tiny-town 的 r1/r3 倒数几列（原版那条黄泥路的色）。
 *  · 石板 #96a2a3 —— city 2:23（灰色路面）。
 */
export const GROUND: SlotTable = {
  grass: [at(T, 0, 0), at(T, 1, 0), at(T, 2, 0), at(T, 0, 1), at(T, 1, 1), at(T, 2, 1)],
  grassPlain: [at(F, 9, 8), at(F, 9, 9)],
  dirt: [at(T, 9, 1), at(T, 10, 1), at(T, 11, 1), at(T, 9, 3), at(T, 10, 3), at(T, 11, 3)],
  stone: [at('city', 2, 23), at('city', 6, 5), at('city', 6, 9)],
  sand: [at(T, 4, 3), at(T, 5, 3), at(T, 6, 3)],
  field: [at(F, 0, 0), at(F, 1, 0), at(F, 2, 0), at(F, 3, 0)],
  void: [at(F, 9, 9)],
}

/** 建筑：屋顶按类别分族（配色即语义），墙体/门/窗单列。 */
export const BUILDING: SlotTable = {
  /** 暖瓦（社交/餐饮）：实测 #be604c，主色占比 0.46–0.48 */
  roofWarm: [at(T, 4, 5), at(T, 6, 5), at(T, 4, 4), at(T, 6, 4)],
  /** 冷瓦（商业/学术）：实测 #62708b */
  roofCool: [at('tiny-battle', 2, 8), at('tiny-battle', 4, 9), at('tiny-battle', 2, 7), at('tiny-battle', 1, 8)],
  /** 苔绿与暖瓦同族换色太生硬，先用 tiny-town 的深色瓦顶当"公共/户外" */
  roofGreen: [at(T, 4, 6), at(T, 5, 6), at(T, 6, 6)],
  roofHome: [at(T, 3, 4), at(T, 5, 4), at(T, 7, 4)],
  wall: [at('city', 4, 21), at('city', 3, 21), at('city', 25, 2)],
  door: [at('city', 12, 20), at('city', 13, 20)],
  window: [at('city', 0, 19), at('city', 1, 19), at('city', 2, 19)],
}

/**
 * 物件与设施。
 *
 * 户外用 tiny-town / tiny-farm，**室内家具用 city**（那是唯一有室内物件的图集）。
 * 每一条同样按实测色反查过：
 *  · 木家具 #976f46 → city 21:11（不透明率仅 0.19，是薄薄一件小家具，正好当桌椅）
 *  · 床品 #d9dde5 → city 14:9/14:11（近白的整格物件）
 *  · 深色台面 #505152 → city 12:19（flat 0.86，最"实"的一块，当灶台/柜面）
 *  · 洁具 #86929a → city 32:20 / 35:20
 */
export const PROPS: SlotTable = {
  // —— 户外 ——
  tree: [at(T, 0, 8), at(T, 1, 8), at(T, 2, 8), at(T, 3, 8)],
  bush: [at(T, 0, 9), at(T, 1, 9), at(T, 2, 9)],
  rock: [at(T, 4, 10), at(T, 5, 10)],
  flower: [at(T, 4, 0), at(T, 5, 0), at(T, 4, 2)],
  streetlamp: [at(T, 8, 9), at(T, 8, 10)],
  sign: [at(T, 0, 9), at(T, 1, 9)],
  vehicle: [at('tiny-battle', 0, 4), at('tiny-battle', 1, 4)],
  fence: [at(F, 0, 4), at(F, 1, 4)],
  crop: [at(F, 2, 6), at(F, 3, 6)],
  // —— 室内 ——
  bed: [at('city', 14, 11), at('city', 14, 9)],
  table: [at('city', 21, 11), at('city', 22, 11)],
  chair: [at('city', 21, 15), at('city', 23, 15)],
  sofa: [at('city', 21, 22), at('city', 21, 23)],
  stove: [at('city', 12, 19), at('city', 15, 23)],
  counter: [at('city', 16, 23), at('city', 15, 24)],
  sink: [at('city', 32, 20), at('city', 35, 20)],
  rug: [at('city', 30, 25)],
  plant: [at('city', 21, 12)],
  bookshelf: [at('city', 25, 2), at('city', 27, 2)],
  fallback: [at(T, 4, 10)],
}

/** 状态与事件符号 —— 用 1-Bit 后备图集（轮廓清楚，不与场景打架）。 */
export const SYMBOLS: SlotTable = {
  broken: [at('onebit', 20, 10), at('onebit', 21, 10)],
  event: [at('onebit', 22, 10)],
  speech: [at('onebit', 23, 10)],
}

/**
 * 角色。Roguelike Characters 是 54×12，每行 9 个角色、每个 3 朝向 × 2 帧。
 * ⚠️ 这张表的朝向/行号仍待核对：用 `npm run assets:inspect characters.png --rows 0-2`
 * 看第 0 行前 6 格是否就是"同一角色朝下/侧/上"。
 */
export const CHARACTER: SlotTable = {
  down: [at('characters', 0, 0), at('characters', 1, 0)],
  side: [at('characters', 2, 0), at('characters', 3, 0)],
  up: [at('characters', 4, 0), at('characters', 5, 0)],
  fallback: [at('characters', 0, 0)],
}

/** 随机取一个候选（由调用方给的 0..1 决定，保证同一格每次重绘一致）。 */
export function pickSlot(table: SlotTable, slot: string, n: number): TileRef | undefined {
  const list = table[slot]
  if (list === undefined || list.length === 0) return undefined
  return list[Math.min(list.length - 1, Math.floor(n * list.length))]
}
