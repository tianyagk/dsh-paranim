/**
 * 按颜色反查图集里的瓦片序号 —— 把"猜序号"换成"查序号"。
 *
 * 背景：瓦片序号错一格，地图就变成一堆无意义的色块，而且**不报错**——
 * 只有肉眼对着屏幕才知道。我这一侧看不了图片，所以用颜色当锚点：
 * 给定一个目标色（例如草地应有的 (79,133,68)），在整本图集里找平均色最接近的格子。
 *
 * 用法：
 *   node scripts/find-tile.mjs --list tiny-town.png           # 列出全部格子的平均色
 *   node scripts/find-tile.mjs --near 74,124,63               # 全图集找最接近的格子
 *   node scripts/find-tile.mjs --near 74,124,63 --only flat   # 只要"整格同色"的（平铺用）
 *   node scripts/find-tile.mjs --sheet city.png --near 130,120,110 --top 8
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const packDir = join(root, 'assets', 'pack')

function decodePng(buf) {
  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 6
  let plte = null
  let trns = null
  const idat = []
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii')
    const data = buf.subarray(pos + 8, pos + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'PLTE') plte = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const bpp = colorType === 3 ? bitDepth : 0
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0
  const stride = colorType === 3 ? Math.ceil((width * bpp) / 8) : width * channels
  const pixels = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  let q = 0
  const idxAt = (line, x) =>
    bpp === 8 ? line[x] : bpp === 4 ? (x % 2 === 0 ? line[x >> 1] >> 4 : line[x >> 1] & 15) : (line[x >> 3] >> (7 - (x & 7))) & 1
  for (let y = 0; y < height; y += 1) {
    const f = raw[q]; q += 1
    const line = Buffer.from(raw.subarray(q, q + stride)); q += stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (f === 1) line[x] = (line[x] + a) & 255
      else if (f === 2) line[x] = (line[x] + b) & 255
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    for (let x = 0; x < width; x += 1) {
      const d = (y * width + x) * 4
      if (colorType === 3) {
        const i = idxAt(line, x)
        pixels[d] = plte[i * 3]; pixels[d + 1] = plte[i * 3 + 1]; pixels[d + 2] = plte[i * 3 + 2]
        pixels[d + 3] = trns !== null && i < trns.length ? trns[i] : 255
      } else {
        const s2 = x * channels
        if (channels === 4) { pixels[d] = line[s2]; pixels[d + 1] = line[s2 + 1]; pixels[d + 2] = line[s2 + 2]; pixels[d + 3] = line[s2 + 3] }
        else if (channels === 3) { pixels[d] = line[s2]; pixels[d + 1] = line[s2 + 1]; pixels[d + 2] = line[s2 + 2]; pixels[d + 3] = 255 }
        else if (channels === 2) { pixels[d] = line[s2]; pixels[d + 1] = line[s2]; pixels[d + 2] = line[s2]; pixels[d + 3] = line[s2 + 1] }
        else { pixels[d] = line[s2]; pixels[d + 1] = line[s2]; pixels[d + 2] = line[s2]; pixels[d + 3] = 255 }
      }
    }
    prev = line
  }
  return { width, height, pixels }
}

/** 统计一格瓦片的颜色特征：平均色、不透明率、主色占比（越高越"平"）。 */
function analyzeSheet(sheet, tile = 16) {
  const cols = Math.floor(sheet.width / tile)
  const rows = Math.floor(sheet.height / tile)
  const out = []
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const hist = new Map()
      let r = 0, g = 0, b = 0, opaque = 0
      for (let y = 0; y < tile; y += 1) {
        for (let x = 0; x < tile; x += 1) {
          const o = ((row * tile + y) * sheet.width + col * tile + x) * 4
          if (sheet.pixels[o + 3] < 128) continue
          const key = (sheet.pixels[o] << 16) | (sheet.pixels[o + 1] << 8) | sheet.pixels[o + 2]
          hist.set(key, (hist.get(key) ?? 0) + 1)
          r += sheet.pixels[o]; g += sheet.pixels[o + 1]; b += sheet.pixels[o + 2]; opaque += 1
        }
      }
      const area = tile * tile
      if (opaque === 0) { out.push({ col, row, empty: true, avg: [0, 0, 0], fill: 0, flat: 0, colors: 0 }); continue }
      let top = 0
      for (const v of hist.values()) if (v > top) top = v
      out.push({
        col, row, empty: false,
        avg: [Math.round(r / opaque), Math.round(g / opaque), Math.round(b / opaque)],
        fill: opaque / area,
        flat: top / opaque,
        colors: hist.size,
      })
    }
  }
  return out
}

const args = process.argv.slice(2)
const pick = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)
const sheetName = pick('--sheet')
const only = pick('--only')
const topN = Number(pick('--top') ?? 12)

if (args.includes('--list')) {
  const file = args[args.indexOf('--list') + 1]
  const path = join(packDir, file)
  if (!existsSync(path)) { console.error(`找不到 ${path}`); process.exit(2) }
  const sheet = decodePng(readFileSync(path))
  const cells = analyzeSheet(sheet)
  const cols = Math.floor(sheet.width / 16)
  console.log(`${file}  每格平均色（列:行  avg  fill  flat/colors）\n`)
  for (const c of cells) {
    if (c.empty) continue
    const hex = '#' + c.avg.map((v) => v.toString(16).padStart(2, '0')).join('')
    console.log(`${String(c.col).padStart(2)}:${String(c.row).padStart(2)}  ${hex}  fill=${c.fill.toFixed(2)} flat=${c.flat.toFixed(2)} colors=${c.colors}`)
  }
  void cols
  process.exit(0)
}

const near = pick('--near')
if (near === undefined) {
  console.error('用法：node scripts/find-tile.mjs --near R,G,B [--sheet 文件] [--only flat] [--top N]')
  console.error('      node scripts/find-tile.mjs --list tiny-town.png')
  process.exit(2)
}
const target = near.split(',').map(Number)
if (target.length !== 3 || target.some((v) => !Number.isFinite(v))) {
  console.error('--near 需要 R,G,B 三个数字，例如 --near 74,124,63')
  process.exit(2)
}

const files = sheetName === undefined
  ? ['tiny-town.png', 'tiny-farm.png', 'tiny-battle.png', 'city.png', 'onebit.png']
  : [sheetName]

const results = []
for (const file of files) {
  const path = join(packDir, file)
  if (!existsSync(path)) continue
  const sheet = decodePng(readFileSync(path))
  for (const c of analyzeSheet(sheet)) {
    if (c.empty) continue
    if (only === 'flat' && (c.flat < 0.55 || c.fill < 0.9)) continue
    if (only === 'solid' && c.fill < 0.98) continue
    const dist = Math.hypot(c.avg[0] - target[0], c.avg[1] - target[1], c.avg[2] - target[2])
    results.push({ file: file.replace('.png', ''), ...c, dist })
  }
}
results.sort((a, b) => a.dist - b.dist)
console.log(`目标色 rgb(${target.join(',')})${only === undefined ? '' : `  only=${only}`} —— 最近的 ${topN} 格：\n`)
console.log('  图集            列:行   平均色    色距   不透明  主色占比  色数')
for (const r of results.slice(0, topN)) {
  const hex = '#' + r.avg.map((v) => v.toString(16).padStart(2, '0')).join('')
  console.log(
    `  ${r.file.padEnd(14)} ${String(r.col).padStart(2)}:${String(r.row).padStart(2)}  ${hex}  ${r.dist.toFixed(1).padStart(6)}  ${r.fill.toFixed(2)}   ${r.flat.toFixed(2)}    ${String(r.colors).padStart(3)}`,
  )
}
