/**
 * 像素素材归一层：把第三方图集（带间隙/不同网格）统一成**规范网格**，
 * 并生成运行时用的坐标表。
 *
 * 为什么要归一：各家的图集都有 1px 间隙（tile 16 + margin 1 = 步长 17），
 * 而 canvas 的 drawImage 按像素矩形取图——间隙不处理，取出来的每一格右下角
 * 都会带一条邻居的边。把间隙在**构建期**消掉，运行时就只有干净的 16×16 网格，
 * 也省掉了每个 sprite 都要记 (x*17+1) 这种容易写错的算式。
 *
 * 做法是纯手工像素搬运，不依赖 canvas / sharp / ImageMagick：
 * 只解析 PNG 的 IHDR + IDAT，按 5 种 filter 还原，再按矩形重排，最后写回 PNG。
 * 这样脚本可以在任何有 node 的地方跑，不引入原生依赖。
 *
 * 用法：node scripts/normalize-assets.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync, inflateSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const src = join(root, 'assets', 'style-preview')
const out = join(root, 'assets', 'pack')

// ── 最小 PNG 读写 ─────────────────────────────────────────────────────────

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function readChunks(buf) {
  if (!buf.subarray(0, 8).equals(SIGNATURE)) throw new Error('不是 PNG')
  const chunks = []
  let pos = 8
  while (pos + 8 <= buf.length) {
    const length = buf.readUInt32BE(pos)
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii')
    const data = buf.subarray(pos + 8, pos + 8 + length)
    chunks.push({ type, data })
    if (type === 'IEND') break
    pos += 12 + length
  }
  return chunks
}

/** 解码一张 8 位 PNG（支持色型 2/6，即 RGB / RGBA）。返回 RGBA 像素。 */
function decodePng(buf) {
  const chunks = readChunks(buf)
  const ihdr = chunks.find((c) => c.type === 'IHDR')
  if (ihdr === undefined) throw new Error('缺少 IHDR')
  const width = ihdr.data.readUInt32BE(0)
  const height = ihdr.data.readUInt32BE(4)
  const bitDepth = ihdr.data[8]
  const colorType = ihdr.data[9]
  const interlace = ihdr.data[12]
  if (bitDepth !== 8 && colorType !== 3) throw new Error(`只支持 8 位色深，收到 ${bitDepth}`)
  if (interlace !== 0) throw new Error('不支持隔行扫描的 PNG')
  // 每条扫描线在**原始字节流**里的长度：索引色按每像素的位宽算，
  // 并且行尾要补到整字节（4 位索引在奇数宽度下会多出半个字节）。
  const bitsPerPixel = colorType === 3 ? bitDepth : 0
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : colorType === 4 ? 2 : 0
  if (colorType !== 3 && channels === 0) throw new Error(`不支持的色型 ${colorType}（需要 0/2/3/4/6）`)
  if (colorType === 3 && bitDepth !== 8 && bitDepth !== 4 && bitDepth !== 1) {
    throw new Error(`索引色只支持 1/4/8 位，收到 ${bitDepth}`)
  }

  // 调色板（色型 3 必需）与透明度表
  const plte = chunks.find((c) => c.type === 'PLTE')?.data
  const trns = chunks.find((c) => c.type === 'tRNS')?.data
  if (colorType === 3 && plte === undefined) throw new Error('索引色缺少 PLTE')

  const idat = Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data))
  const raw = inflateSync(idat)
  const stride = colorType === 3
    ? Math.ceil((width * bitsPerPixel) / 8)
    : width * channels
  const pixels = Buffer.alloc(width * height * 4)
  let prev = Buffer.alloc(stride)
  let pos = 0

  /** 从一条已还原的扫描线里取第 x 个像素的索引/分量。 */
  const indexAt = (line, x) => {
    if (bitsPerPixel === 8) return line[x]
    if (bitsPerPixel === 4) return (x % 2 === 0 ? line[x >> 1] >> 4 : line[x >> 1] & 0x0f)
    return (line[x >> 3] >> (7 - (x & 7))) & 1
  }

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = Buffer.from(raw.subarray(pos, pos + stride))
    pos += stride
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + a) & 0xff
      else if (filter === 2) line[x] = (line[x] + b) & 0xff
      else if (filter === 3) line[x] = (line[x] + ((a + b) >> 1)) & 0xff
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
        line[x] = (line[x] + pr) & 0xff
      } else if (filter !== 0) throw new Error(`未知 filter ${filter}`)
    }
    for (let x = 0; x < width; x += 1) {
      const d = (y * width + x) * 4
      if (colorType === 3) {
        const idx = indexAt(line, x)
        pixels[d] = plte[idx * 3]
        pixels[d + 1] = plte[idx * 3 + 1]
        pixels[d + 2] = plte[idx * 3 + 2]
        // tRNS 缺失时索引色按不透明处理；表比索引短则超出部分不透明
        pixels[d + 3] = trns !== undefined && idx < trns.length ? trns[idx] : 255
      } else {
        const s = x * channels
        if (channels === 4) {
          pixels[d] = line[s]
          pixels[d + 1] = line[s + 1]
          pixels[d + 2] = line[s + 2]
          pixels[d + 3] = line[s + 3]
        } else if (channels === 3) {
          pixels[d] = line[s]
          pixels[d + 1] = line[s + 1]
          pixels[d + 2] = line[s + 2]
          pixels[d + 3] = 255
        } else if (channels === 2) {
          pixels[d] = line[s]
          pixels[d + 1] = line[s]
          pixels[d + 2] = line[s]
          pixels[d + 3] = line[s + 1]
        } else {
          pixels[d] = line[s]
          pixels[d + 1] = line[s]
          pixels[d + 2] = line[s]
          pixels[d + 3] = 255
        }
      }
    }
    prev = line
  }
  return { width, height, pixels }
}

function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i += 1) {
    c ^= buf[i]
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const out = Buffer.alloc(body.length + 8)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), body.length + 4)
  return out
}

/** 编码 RGBA 像素为 PNG（filter 0，不做自适应）。 */
function encodePng(width, height, pixels) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 从带间隙的图集里取一个瓦片，拼成规范网格图集。
 * @param sheet 源图（已解码）
 * @param tile 瓦片边长
 * @param margin 瓦片之间的间隙
 * @param cols/rows 需要的列行数（默认取整张图的全部）
 */
function normalize(sheet, tile, margin, cols, rows) {
  const step = tile + margin
  const outW = cols * tile
  const outH = rows * tile
  const pixels = Buffer.alloc(outW * outH * 4)
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const sx = x * step
      const sy = y * step
      for (let ty = 0; ty < tile; ty += 1) {
        const srcRow = (sy + ty) * sheet.width + sx
        const dstRow = ((y * tile + ty) * outW + x * tile) * 4
        sheet.pixels.copy(pixels, dstRow, srcRow * 4, (srcRow + tile) * 4)
      }
    }
  }
  return { width: outW, height: outH, pixels }
}

// ── 清单 ──────────────────────────────────────────────────────────────────

const JOBS = [
  { out: 'tiny-town.png', from: 'tiny-town-tilemap.png', tile: 16, margin: 1, cols: 12, rows: 11, note: 'Kenney Tiny Town · CC0' },
  { out: 'tiny-farm.png', from: 'tiny-farm-tilemap.png', tile: 16, margin: 1, cols: 12, rows: 11, note: 'Kenney Tiny Farm · CC0' },
  { out: 'tiny-battle.png', from: 'tiny-battle-tilemap.png', tile: 16, margin: 1, cols: 19, rows: 11, note: 'Kenney Tiny Battle · CC0' },
  { out: 'onebit.png', from: 'onebit-colored-packed.png', tile: 16, margin: 0, cols: 49, rows: 22, note: 'Kenney 1-Bit Pack 彩色 · CC0（后备，4 位索引色）' },
  { out: 'city.png', from: 'rogue-city-tilemap.png', tile: 16, margin: 1, cols: 37, rows: 28, note: 'Kenney Roguelike Modern City · CC0' },
  { out: 'characters.png', from: 'roguelike-characters.png', tile: 16, margin: 1, cols: 54, rows: 12, note: 'Kenney Roguelike Characters · CC0' },
]

mkdirSync(out, { recursive: true })
const manifest = []

for (const job of JOBS) {
  const from = join(src, job.from)
  if (!existsSync(from)) {
    console.log(`  跳过（缺源文件）：${job.out}  ←  ${job.from}`)
    continue
  }
  const sheet = decodePng(readFileSync(from))
  const maxCols = Math.floor((sheet.width + job.margin) / (job.tile + job.margin))
  const maxRows = Math.floor((sheet.height + job.margin) / (job.tile + job.margin))
  const cols = Math.min(job.cols ?? maxCols, maxCols)
  const rows = Math.min(job.rows ?? maxRows, maxRows)
  const grid = normalize(sheet, job.tile, job.margin, cols, rows)
  const file = join(out, job.out)
  writeFileSync(file, encodePng(grid.width, grid.height, grid.pixels))
  manifest.push({ file: job.out, cols, rows, tile: job.tile, note: job.note, source: job.from })
  console.log(
    `  ${job.out.padEnd(18)} ${String(cols).padStart(3)}×${String(rows).padStart(3)} = ${String(cols * rows).padStart(4)} 格  (源 ${sheet.width}×${sheet.height}, margin ${job.margin})  ${job.note}`,
  )
}

writeFileSync(join(out, 'manifest.json'), `${JSON.stringify({ normalizedFrom: 'assets/style-preview', sheets: manifest }, null, 2)}\n`)
console.log(`\n已归一 ${manifest.length} 张图集 → assets/pack/`)
