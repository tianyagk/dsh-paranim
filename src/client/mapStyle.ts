/**
 * 角色表的唯一去处。
 *
 * 这个文件曾是整个"语义槽位表"（地面/屋顶/物件/符号 → 图集格子）——那是
 * **按平均色反查格子**的产物：对纯色地面有效，对有形状的物件完全无效，
 * 于是出现"把路面当树画出来"这类错误，而且不报错。
 *
 * 瓦片模型下，瓦片的语义由人在图集注释里标（见 shared/tilemap.ts 的
 * TileNote），渲染直接读引用。那些槽位表连同它们的色值注释一起退役了。
 * 只剩角色：角色的朝向与帧仍然是一张固定的表，没有别的去处。
 */
import type { TileRef } from './tiles.ts'

/** 语义槽位 → 候选瓦片。 */
export type SlotTable = Record<string, readonly TileRef[]>

function at(sheet: TileRef['sheet'], col: number, row: number): TileRef {
  return { sheet, col, row }
}

/**
 * 角色。Roguelike Characters 是 54×12，每行 9 个角色、每个 3 朝向 × 2 帧。
 *
 * ⚠️ 这张表的朝向/行号仍待核对：用 `npm run assets:inspect characters.png
 * --rows 0-2` 看第 0 行前 6 格是否就是"同一角色朝下/侧/上"。角色画错不会
 * 报错，只会一直画错，所以这条提醒留着。
 */
export const CHARACTER: SlotTable = {
  down: [at('characters', 0, 0), at('characters', 1, 0)],
  side: [at('characters', 2, 0), at('characters', 3, 0)],
  up: [at('characters', 4, 0), at('characters', 5, 0)],
  fallback: [at('characters', 0, 0)],
}

/** 按 0..1 的 n 取一个候选（同一格每次重绘一致，避免角色闪帧）。 */
export function pickSlot(table: SlotTable, slot: string, n: number): TileRef | undefined {
  const list = table[slot]
  if (list === undefined || list.length === 0) return undefined
  return list[Math.min(list.length - 1, Math.floor(n * list.length))]
}
