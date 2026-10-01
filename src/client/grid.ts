/**
 * 网格工具：由坐标派生的确定性伪随机。
 *
 * 单独一个文件是因为它被两处用着（瓦片渲染与角色摆位），而其中一处要能
 * 脱离浏览器跑单测——不能从一个会 import 图集加载器的模块里取工具。
 */
export function hash2(x: number, y: number, salt = 0): number {
  let h = (Math.round(x) * 374761393 + Math.round(y) * 668265263 + salt * 2246822519) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
