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
 * 地面。每一槽的实测色（每行以**槽位名**开头，scripts/check-assets.mjs 会
 * 逐槽核对首格像素——色值写错就等于取材依据变成了误导，比没有注释更糟）：
 *
 *  · grassPlain 草地 #528e4c —— tiny-farm 9:8/9:9 是整格纯绿（主色占比
 *    0.72–0.78），最适合大面积平铺；tiny-town 的 r0–r3 绿格带草簇/花，
 *    拿来做点缀变体。
 *  · dirt 泥土 #9b6738 —— tiny-town r1/r3 的 9–11 列（深棕压实土）。
 *    注意：同一行的 0–2 列是 #c1b06a 那种浅黄土路，两者都是"路"但深浅差很多。
 *    当前取的是深棕这一组；若要让镇上路面更像原版那条黄泥路，把列号改成 0–2 即可。
 *    （这条注释此前写的是 #c1b06a，与槽位实际用的格子对不上——是校验器揪出来的。）
 *  · stone 石板 #96a2a3 —— city 2:23。
 *  · concrete 水泥 #aeb1b5 —— city 18:2，比石板亮一档且偏中性灰：两者都是
 *    路面，但一个是石材一个是浇筑，图上必须分得开。
 *  · wood 木地板 #b38355 —— city 13:25，主色占比 0.89，室内平铺很干净；
 *    偏红棕，与土路的土黄一眼可分。
 *  · water 水面 #3cacd7 —— onebit 8:5 纯色格。此前 water 直接降级成 stone，
 *    玩家刷出"水面"却看到石地，只能当成笔刷坏了。
 */
export const GROUND: SlotTable = {
  grass: [at(T, 0, 0), at(T, 1, 0), at(T, 2, 0), at(T, 0, 1), at(T, 1, 1), at(T, 2, 1)],
  grassPlain: [at(F, 9, 8), at(F, 9, 9)],
  dirt: [at(T, 9, 1), at(T, 10, 1), at(T, 11, 1), at(T, 9, 3), at(T, 10, 3), at(T, 11, 3)],
  stone: [at('city', 2, 23), at('city', 6, 5), at('city', 6, 9)],
  sand: [at(T, 4, 3), at(T, 5, 3), at(T, 6, 3)],
  field: [at(F, 0, 0), at(F, 1, 0), at(F, 2, 0), at(F, 3, 0)],
  wood: [at('city', 13, 25), at('city', 14, 25), at('city', 13, 26), at('city', 14, 26)],
  water: [at('onebit', 8, 5), at('onebit', 11, 5)],
  concrete: [at('city', 18, 2), at('city', 23, 2), at('city', 16, 1), at('city', 17, 1)],
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
  // 轿车用 city 图集的 2x2 拼块(绿/银/橙三色,横置)。原槽位 (0,4) 是 tiny-battle
  // 的水面地块——之前物件画成"一滩水"就是它。
  vehicle: [at('city', 32, 15), at('city', 34, 15), at('city', 32, 19)],
  // 补绘的自行车/摩托/轮胎/手推车(38-41 列):素材库里原本没有自行车,
  // 用卡车凑数会违背"图标贴合物件",所以按 Kenney 调色板风格原创补了 8 格。
  bike: [at('city', 38, 0), at('city', 39, 0), at('city', 40, 0), at('city', 41, 0)],
  moto: [at('city', 38, 1), at('city', 39, 1)],
  tire: [at('city', 40, 1)],
  cart: [at('city', 41, 1)],
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
  chest: [at('city', 31, 14), at('city', 33, 14)],
  marker: [at('onebit', 22, 10)],
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

/**
 * 物件资源池：可放置进沙盒的**素材条目**。
 *
 * 三个用途：① 物件按 `sprite` 取图，同一类物件不再共用一张图；
 *          ② 界面上的「物件资源池」直接按这份清单渲染可选贴图；
 *          ③ 新建物件时从这里挑一个槽位。
 *
 * `slots` 里的每一格都经 `npm run find-tile` 按实测色反查或逐格看过，
 * 找不到合适贴图的条目**不放进清单**——宁可少一项，也不摆一个看不出来的东西。
 */
export interface ObjectEntry {
  /** 槽位名：写进物件的 `sprite` 字段。 */
  slot: string
  /** 中文显示名（也用于按名字自动识别）。 */
  label: string
  group: '自然' | '建筑' | '家具' | '器物' | '交通' | '人物'
  /** 同义写法：物件名里出现这些词就归到这个槽位。 */
  alias?: string[]
}

export const OBJECT_LIBRARY: readonly ObjectEntry[] = [
  // —— 自然 ——
  { slot: 'tree', label: '树', group: '自然', alias: ['树', '乔木', '橡树'] },
  { slot: 'bush', label: '灌木', group: '自然', alias: ['灌木', '花丛'] },
  { slot: 'flower', label: '花', group: '自然', alias: ['花', '花坛'] },
  { slot: 'rock', label: '石头', group: '自然', alias: ['石', '岩石'] },
  { slot: 'crop', label: '田垄', group: '自然', alias: ['田', '垄', '苗'] },
  // —— 建筑 ——
  { slot: 'fence', label: '栅栏', group: '建筑', alias: ['栅栏', '篱', '围栏'] },
  { slot: 'sign', label: '牌子', group: '建筑', alias: ['牌子', '告示', '招牌'] },
  { slot: 'streetlamp', label: '路灯', group: '建筑', alias: ['路灯', '街灯'] },
  // —— 家具 ——
  { slot: 'bed', label: '床', group: '家具', alias: ['床'] },
  { slot: 'sofa', label: '沙发', group: '家具', alias: ['沙发', '长椅'] },
  { slot: 'table', label: '桌', group: '家具', alias: ['桌', '案台'] },
  { slot: 'chair', label: '椅', group: '家具', alias: ['椅', '凳'] },
  { slot: 'bookshelf', label: '架', group: '家具', alias: ['架', '书柜', '货架'] },
  { slot: 'rug', label: '地毯', group: '家具', alias: ['地毯'] },
  // —— 器物 ——
  { slot: 'stove', label: '灶', group: '器物', alias: ['灶', '炉', '烤箱'] },
  { slot: 'counter', label: '柜台', group: '器物', alias: ['柜台', '操作台'] },
  { slot: 'sink', label: '水槽', group: '器物', alias: ['水槽', '洗手'] },
  { slot: 'chest', label: '箱柜', group: '器物', alias: ['箱', '柜', '桶'] },
  { slot: 'plant', label: '盆栽', group: '器物', alias: ['盆栽', '绿植'] },
  // —— 交通 ——
  { slot: 'vehicle', label: '车', group: '交通', alias: ['车', '卡车', '汽车'] },
  { slot: 'bike', label: '自行车', group: '交通', alias: ['自行车', '单车', '脚踏车'] },
  { slot: 'moto', label: '摩托', group: '交通', alias: ['摩托', '机车'] },
  { slot: 'tire', label: '轮胎', group: '交通', alias: ['轮胎', '废胎'] },
  { slot: 'cart', label: '手推车', group: '交通', alias: ['手推车', '推车', '板车'] },
  // —— 符号（1-Bit 后备，用于状态标记）——
  { slot: 'marker', label: '标记', group: '器物', alias: ['标记', '点位'] },
]

/** 槽位 → 中文名。 */
export const SLOT_LABEL: Record<string, string> = Object.fromEntries(OBJECT_LIBRARY.map((e) => [e.slot, e.label]))

/** 随机取一个候选（由调用方给的 0..1 决定，保证同一格每次重绘一致）。 */
export function pickSlot(table: SlotTable, slot: string, n: number): TileRef | undefined {
  const list = table[slot]
  if (list === undefined || list.length === 0) return undefined
  return list[Math.min(list.length - 1, Math.floor(n * list.length))]
}
