/**
 * 地图风格配置：**「哪一类东西用图集里的哪几格」**全在这一个文件里。
 *
 * 为什么单独抽成配置而不是写死在渲染代码里：瓦片序号是"看着定的"，不是算出来的。
 * 我的终端检查器（`npm run assets:inspect <图集>`）能读出大致分区，但**逐格辨认
 * 只能靠眼睛**；把序号摊在这个文件里，改一格就是改一行，不必进渲染逻辑翻找。
 *
 * 配置形状刻意做成"一个键 = 一个语义槽位，值 = 候选格列表（随机取一个）"：
 *  - 像 `grass` 给 4 个候选，地面就不会是一片完全相同的绿，也不会像棋盘；
 *  - 像 `roofWarm` 只给 1 个，因为它本来就是"暖瓦这套"；
 *  - 候选为空数组表示"这个槽位暂时没有素材"，渲染层会**跳过**而不是画错格子。
 *
 * ⚠️ 下面的序号是**初版估计值**，请用 `npm run assets:inspect <图集>` 核对后直接改。
 * 设计上允许"先跑起来再调"：候选为空只会少画东西，不会画错东西。
 */
import type { TileRef } from './tiles.ts'

/** 语义槽位 → 候选瓦片。空数组 = 该槽位暂无素材。 */
export type SlotTable = Record<string, readonly TileRef[]>

function refs(sheet: TileRef['sheet'], cells: ReadonlyArray<readonly [number, number]>): readonly TileRef[] {
  return cells.map(([col, row]) => ({ sheet, col, row }))
}

const T = 'tiny-town' as const
const F = 'tiny-farm' as const
const B = 'tiny-battle' as const
const C = 'city' as const
const O = 'onebit' as const

/**
 * 地面与道路。tiny-town 的前三行是地形带：
 *  r0–r2 草（左侧几格是纯草，右侧过渡到土/石）；
 *  r3 是土路带；r4–r5 左侧是石板/蓝灰。
 */
export const GROUND: SlotTable = {
  // 草地：取 4 个轻微不同的变体做抖动，避免整屏同色
  grass: refs(T, [[0, 0], [1, 0], [2, 0], [0, 1]]),
  // 土路 / 踩出来的小径
  dirt: refs(T, [[3, 0], [9, 0], [10, 0], [11, 0]]),
  // 石板路（镇上主路）
  stone: refs(T, [[0, 3], [1, 3], [2, 3], [3, 3]]),
  // 田垄（Tiny Farm 的地）
  field: refs(F, [[0, 0], [1, 0], [2, 0], [3, 0]]),
  // 草地边缘/世界之外
  void: refs(T, [[3, 1], [4, 1]]),
}

/** 建筑：屋顶按类别分族，墙体与门窗单列，便于自由组合。 */
export const BUILDING: SlotTable = {
  roofWarm: refs(T, [[4, 6], [5, 6], [6, 6]]),
  roofCool: refs(T, [[4, 4], [5, 4], [6, 4]]),
  roofGreen: refs(F, [[4, 6], [5, 6], [6, 6]]),
  wall: refs(T, [[4, 7], [5, 7], [6, 7]]),
  door: refs(T, [[9, 7], [10, 7], [11, 7]]),
  window: refs(T, [[8, 8], [9, 8], [10, 8]]),
}

/** 物件与设施：没列到的种类会回落到 `fallback`。 */
export const PROPS: SlotTable = {
  tree: refs(T, [[0, 8], [1, 8], [2, 8], [3, 8]]),
  bush: refs(T, [[0, 9], [1, 9], [2, 9]]),
  rock: refs(T, [[4, 9], [5, 9]]),
  fence: refs(F, [[8, 0], [9, 0], [10, 0]]),
  streetlamp: refs(C, [[0, 0], [1, 0]]),
  bench: refs(C, [[2, 0], [3, 0]]),
  bin: refs(C, [[4, 0], [5, 0]]),
  sign: refs(C, [[6, 0], [7, 0]]),
  well: refs(C, [[8, 0], [9, 0]]),
  fountain: refs(C, [[10, 0], [11, 0]]),
  stall: refs(C, [[12, 0], [13, 0]]),
  vehicle: refs(B, [[0, 0], [1, 0], [2, 0]]),
  campfire: refs(T, [[6, 9], [7, 9]]),
  /** 认不出的物件用它，至少画个东西出来，而不是空白。 */
  fallback: refs(T, [[8, 9], [9, 9]]),
}

/**
 * 状态与事件符号 —— 这一组**主用 1-Bit**（后备图集）。
 * 它们是"叠在东西上的一张小图"，需要轮廓清楚、与场景不打架；
 * Tiny 系列里没有专门的符号位，1-Bit 的线条正好干这个。
 */
export const SYMBOLS: SlotTable = {
  /** 故障 / 损坏 */
  broken: refs(O, [[0, 0], [1, 0]]),
  /** 可用 / 正常 */
  ok: refs(O, [[2, 0], [3, 0]]),
  /** 正在发生的事（事件气泡角标） */
  event: refs(O, [[4, 0], [5, 0]]),
  /** 判定成功 */
  rollOk: refs(O, [[6, 0], [7, 0]]),
  /** 判定失败 */
  rollFail: refs(O, [[8, 0], [9, 0]]),
  /** 对话 */
  speech: refs(O, [[10, 0], [11, 0]]),
}

/**
 * 角色——Roguelike Characters 的 16×16 网格。
 *
 * 图集是 54 列 × 12 行。Kenney 这个包的排布是"每个角色占 6 列（3 个朝向 × 2 帧）"，
 * 但**具体行列必须核对**：`npm run assets:inspect characters.png --rows 0-3`。
 * 下面的取值按"每行 9 个角色、前 3 列是朝下"的常见排布给初值。
 */
export const CHARACTER: SlotTable = {
  down: refs('characters', [[0, 0], [2, 0]]),
  up: refs('characters', [[6, 0], [8, 0]]),
  side: refs('characters', [[3, 0], [5, 0]]),
  /** 找不到朝向时用它。 */
  fallback: refs('characters', [[0, 0]]),
}



/** 随机取一个候选（确定性：由调用方给的 0..1 决定，保证同一格每次重绘一致）。 */
export function pickSlot(table: SlotTable, slot: string, n: number): TileRef | undefined {
  const list = table[slot]
  if (list === undefined || list.length === 0) return undefined
  return list[Math.min(list.length - 1, Math.floor(n * list.length))]
}

