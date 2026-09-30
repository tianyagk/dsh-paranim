/**
 * 把 `src/client/pixelart.ts` 里的点阵素材用 ANSI 真彩打到终端，肉眼校验像素画。
 *
 * 为什么值得留一个终端预览：点阵素材最容易错的地方是"行宽不一致""某个索引字符
 * 在调色板里没有""描边漏了一行"——这些在浏览器里往往表现为"看着有点怪"而不是报错，
 * 只有把像素一排排打出来才发现得了。构建前跑一次，比截图比对快得多。
 *
 * 用法：node scripts/preview-sprites.mjs [建筑|角色|地面|物件|全部]
 */
import { readFileSync } from 'node:fs'
const src = readFileSync('src/client/pixelart.ts', 'utf8')
const pal = {}
for (const m of src.matchAll(/^\s{2}'?([.:;a-zA-Z0-9])'?:\s*'(#[0-9a-fA-F]{6})'/gm)) pal[m[1]] = m[2]
const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
function rowsToLines(rows) {
  return rows.map((row) => {
    let out = ''
    for (const ch of row) {
      const c = pal[ch]
      if (c === undefined || ch === '.') { out += '\u001b[48;2;30;30;36m \u001b[0m'; continue }
      const [r, g, b] = rgb(c)
      out += `\u001b[48;2;${r};${g};${b}m \u001b[0m`
    }
    return out
  })
}
// 并排显示多组：建筑（换色族）与行走图
const grab = (marker, n) => {
  const i = src.indexOf(marker)
  if (i < 0) throw new Error(`预览：在 pixelart.ts 里找不到 ${marker}`)
  const seg = src.slice(i, i + 4000)
  const m = seg.match(/sprite\(\[(.*?)\]\)/s)
  if (m === null) throw new Error(`预览：${marker} 之后没有 sprite([...]) 块`)
  const rows = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
  return rows.slice(0, n)
}
function sideBySide(title, groups) {
  console.log('\n\u001b[1m' + title + '\u001b[0m')
  const lines = groups.map((g) => rowsToLines(g.rows))
  const height = Math.max(...lines.map((l) => l.length))
  for (let i = 0; i < height; i++) {
    console.log(lines.map((l, gi) => (l[i] ?? ' '.repeat(groups[gi].rows[0].length * 8)) + '  ').join(''))
  }
  console.log(groups.map((g) => g.name.padEnd(g.rows[0].length + 1)).join(''))
}

// 建筑 5 个配色族（用 recolor 表手工复现）
const base = grab('BUILDING_ROWS = [', 24)
const rec = (rows, map) => rows.map((r) => [...r].map((c) => map[c] ?? c).join(''))
sideBySide('建筑（暖 / 靛 / 紫 / 苔 / 陶）', [
  { name: 'warm', rows: base },
  { name: 'cool', rows: rec(base, { q: 'a', r: 'b', R: 'B', Q: 'A' }) },
  { name: 'violet', rows: rec(base, { q: 'o', r: 'p', R: 'P', Q: 'P' }) },
  { name: 'moss', rows: rec(base, { q: 'n', r: 'm', R: 'M', Q: 'M' }) },
  { name: 'clay', rows: rec(base, { q: 'x', r: 'y', R: 'Y', Q: 'Y' }) },
])

const walker = grab('WALKER_BASE = [', 18)
const recolor = (rows, hair, cloth) => rows.map((r) => [...r].map((c) => (c === '2' ? hair : c === '6' ? cloth : c)).join(''))
sideBySide('行走图（正面 / 侧面 / 背面 × 三种发色衣色）', [
  { name: 'down', rows: walker },
  { name: 'side', rows: grab('WALKER_SIDE = [', 18) },
  { name: 'back', rows: grab('WALKER_BACK = [', 18) },
  { name: 'hair3', rows: recolor(walker, '3', '7') },
  { name: 'hair4', rows: recolor(walker, '4', '8') },
])
