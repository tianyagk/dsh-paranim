/**
 * 把归一后的图集打到终端，逐格看清内容并标出列:行索引。
 *
 * 为什么需要它：瓦片序号不能靠猜。一张 140×100 的地图由几十种瓦片拼成，
 * 序号错一格就是整块地面画错，而在浏览器里**只表现为"有点怪"**——不报错、
 * typecheck 也看不见。我这一侧看不了图片链接，所以把图集转成终端可视的
 * 半角块（每像素一个色块），用 TUI 直接读出「第几行第几列是什么东西」。
 *
 * 用法：
 *   node scripts/inspect-sheet.mjs tiny-town.png            # 全部格子，每格 1px
 *   node scripts/inspect-sheet.mjs tiny-town.png --rows 0-3 # 只看某几行
 *   node scripts/inspect-sheet.mjs tiny-town.png --at 5:2   # 放大单格
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

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
    const f = raw[q]
    q += 1
    const line = Buffer.from(raw.subarray(q, q + stride))
    q += stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (f === 1) line[x] = (line[x] + a) & 255
      else if (f === 2) line[x] = (line[x] + b) & 255
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    for (let x = 0; x < width; x += 1) {
      const d = (y * width + x) * 4
      if (colorType === 3) {
        const i = idxAt(line, x)
        pixels[d] = plte[i * 3]
        pixels[d + 1] = plte[i * 3 + 1]
        pixels[d + 2] = plte[i * 3 + 2]
        pixels[d + 3] = trns !== null && i < trns.length ? trns[i] : 255
      } else {
        const s = x * channels
        if (channels === 4) {
          pixels[d] = line[s]; pixels[d + 1] = line[s + 1]; pixels[d + 2] = line[s + 2]; pixels[d + 3] = line[s + 3]
        } else if (channels === 3) {
          pixels[d] = line[s]; pixels[d + 1] = line[s + 1]; pixels[d + 2] = line[s + 2]; pixels[d + 3] = 255
        } else if (channels === 2) {
          pixels[d] = line[s]; pixels[d + 1] = line[s]; pixels[d + 2] = line[s]; pixels[d + 3] = line[s + 1]
        } else {
          pixels[d] = line[s]; pixels[d + 1] = line[s]; pixels[d + 2] = line[s]; pixels[d + 3] = 255
        }
      }
    }
    prev = line
  }
  return { width, height, pixels }
}

/** 把一格瓦片压成一串"主色字符"，用于横向速览。 */
const GLYPHS = ' .:-=+*#%@'
function summarize(pixels, sheetW, ox, oy, size = 16) {
  let r = 0
  let g = 0
  let b = 0
  let n = 0
  let alpha = 0
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const o = ((oy + y) * sheetW + ox + x) * 4
      if (pixels[o + 3] < 128) continue
      r += pixels[o]
      g += pixels[o + 1]
      b += pixels[o + 2]
      n += 1
      alpha += 1
    }
  }
  if (n === 0) return { hex: '------', lum: 0, fill: 0 }
  r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n)
  const lum = Math.round((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 * 9)
  return {
    hex: [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''),
    lum,
    fill: Math.round((alpha / (size * size)) * 9),
  }
}

const file = process.argv[2]
if (file === undefined) {
  console.error('用法：node scripts/inspect-sheet.mjs <图集.png> [--rows A-B] [--at 列:行] [--size 16]')
  process.exit(2)
}
const path = existsSync(join(root, 'assets', 'pack', file)) ? join(root, 'assets', 'pack', file) : join(root, file)
if (!existsSync(path)) {
  console.error(`找不到图集：${path}`)
  process.exit(2)
}
const args = process.argv.slice(3)
const rowsArg = args[args.indexOf('--rows') + 1]
const atArg = args[args.indexOf('--at') + 1]
const sizeArg = args[args.indexOf('--size') + 1]

const sheet = decodePng(readFileSync(path))
const SIZE = Number(sizeArg ?? 16)
const cols = Math.floor(sheet.width / SIZE)
const rows = Math.floor(sheet.height / SIZE)
console.log(`${file}  ${sheet.width}×${sheet.height}  每格 ${SIZE}px  →  ${cols} 列 × ${rows} 行 = ${cols * rows} 格\n`)

if (atArg !== undefined) {
  const [cx, cy] = atArg.split(':').map(Number)
  console.log(`放大 列${cx} 行${cy}：`)
  for (let y = 0; y < SIZE; y += 1) {
    let line = '  '
    for (let x = 0; x < SIZE; x += 1) {
      const o = ((cy * SIZE + y) * sheet.width + cx * SIZE + x) * 4
      const a = sheet.pixels[o + 3]
      if (a < 128) line += '\u001b[48;2;24;26;31m·\u001b[0m'
      else line += `\u001b[48;2;${sheet.pixels[o]};${sheet.pixels[o + 1]};${sheet.pixels[o + 2]}m \u001b[0m`
    }
    console.log(line)
  }
  process.exit(0)
}

const range = rowsArg === undefined ? [0, rows - 1] : rowsArg.split('-').map(Number)
console.log('每格显示为「主色」两字符 + 明度数字，便于快速定位；要看细节用 --at 列:行\n')
for (let y = range[0]; y <= Math.min(range[1], rows - 1); y += 1) {
  const cells = []
  for (let x = 0; x < cols; x += 1) {
    const s = summarize(sheet.pixels, sheet.width, x * SIZE, y * SIZE, SIZE)
    if (s.hex === '------') cells.push('\u001b[48;2;24;26;31m  \u001b[0m')
    else {
      const [r, g, b] = [0, 2, 4].map((i) => parseInt(s.hex.slice(i, i + 2), 16))
      cells.push(`\u001b[48;2;${r};${g};${b}m ${GLYPHS[Math.max(0, Math.min(9, s.lum))]}${s.fill < 6 ? '·' : GLYPHS[Math.max(0, Math.min(9, s.lum))]}\u001b[0m`)
    }
  }
  console.log(`r${String(y).padStart(2)} ${cells.join('')}`)
}
console.log('\n列号：' + Array.from({ length: cols }, (_, i) => String(i % 10)).join('').replace(/(.{10})/g, '$1 '))
