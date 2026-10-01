/**
 * 把 assets/ 下的旧格式镜像（字符画 + places 矩形 + objects 数组）
 * 迁移成瓦片模型（tilesets + 三图层）。
 *
 * 迁移的关键不是"搬数据"，是**给每个瓦片带上注释**：旧字符画里的 'g'
 * 迁过去必须是一个标了"草地、可走"的瓦片，否则移动判定会把整个镜像
 * 当成未知地形。所以这里维护一张 字符 → (图集, 格子, 注释) 的映射表，
 * 迁移后的镜像开箱即用。
 *
 * 用法：node scripts/migrate-mirrors.mjs   （原地改写 assets/*.json）
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const assetsDir = join(root, 'assets')

/**
 * 迁移用的标准图集：tiny-town（12×11）。
 *
 * 每条是 字符 → [col, row, 注释]。格子的选取参考了 mapStyle.ts 的历史
 * 取材（草地 r0、土路 r1 等），但语义注释是**这里**定的——迁移产物里的
 * 每个瓦片都要带着它的通行性，这是新模型能直接跑的前提。
 */
const CHAR_MAP = {
  g: [0, 0, { name: '草地', pass: 'walk' }],
  r: [9, 1, { name: '土路', pass: 'walk' }],
  w: [4, 10, { name: '水面', pass: 'water' }],
  s: [4, 3, { name: '沙地', pass: 'walk' }],
  p: [2, 23 - 23, { name: '石板', pass: 'walk' }],   // city 2:23 不在 tiny-town，用占位
  z: [0, 0, { name: '空地', pass: 'walk' }],
  f: [0, 0, { name: '田垄', pass: 'walk' }],
  o: [0, 0, { name: '木地板', pass: 'walk' }],
}
// tiny-town 没有石板/田垄/木地板，统一落到草地的格子上但保留各自的名字注释。
// 这不完美——但迁移的底线是"地形语义对"，外观差异以后在切片器里换。

const TILESET = {
  id: 'tiny-town',
  name: 'Tiny Town',
  image: '',
  imageW: 192, imageH: 176,
  tileW: 16, tileH: 16,
  margin: 0, spacing: 0,
  notes: Object.fromEntries(
    Object.entries(CHAR_MAP).map(([ch, [col, row, note]]) => [`${col},${row}`, note]),
  ),
}
// 同一格子可能被多个字符引用（都是草地格），notes 只要一份。

function tileRef(ch) {
  const [col, row] = CHAR_MAP[ch] ?? CHAR_MAP.g
  return `tiny-town:${col},${row}`
}

function migrate(file) {
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  const map = raw.map ?? {}
  const W = map.width ?? 140
  const H = map.height ?? 100
  const tiles = Array.isArray(map.tiles) ? map.tiles : []

  // ── background：字符画逐格转瓦片 ──
  const bgCells = new Array(W * H).fill(null)
  for (let y = 0; y < Math.min(H, tiles.length); y += 1) {
    const row = tiles[y] ?? ''
    for (let x = 0; x < Math.min(W, row.length); x += 1) {
      bgCells[y * W + x] = tileRef(row[x] ?? 'g')
    }
  }
  // 没有字符画的（house）：全部铺草地
  for (let i = 0; i < bgCells.length; i += 1) {
    if (bgCells[i] === null) bgCells[i] = tileRef('g')
  }

  // ── structure：places 矩形 → 四面墙圈 ──
  // 用户定的画法：不画完整带屋顶的房子，只画墙。门的位置留在 object 层补。
  const stCells = new Array(W * H).fill(null)
  const objCells = new Array(W * H).fill(null)
  const objStates = {}
  for (const place of raw.places ?? []) {
    const { x, y } = place
    const w = place.w ?? 6
    const h = place.h ?? 5
    // 四面墙（沿矩形边一圈）
    for (let dx = 0; dx < w; dx += 1) {
      stCells[y * W + (x + dx)] = 'tiny-town:1,0'            // 上墙
      stCells[(y + h - 1) * W + (x + dx)] = 'tiny-town:1,0'  // 下墙
    }
    for (let dy = 0; dy < h; dy += 1) {
      stCells[(y + dy) * W + x] = 'tiny-town:1,0'            // 左墙
      stCells[(y + dy) * W + (x + w - 1)] = 'tiny-town:1,0'  // 右墙
    }
    // 南墙正中开一道门（放进 object 层，标 use: door，默认开）
    const doorX = x + Math.floor(w / 2)
    const doorY = y + h - 1
    stCells[doorY * W + doorX] = null
    objCells[doorY * W + doorX] = 'tiny-town:2,0'
    objStates[String(doorY * W + doorX)] = { open: true }
  }

  // ── object：旧 objects 数组 → 格子瓦片 ──
  // 旧物件没有瓦片引用——给它们一个统一的"物件格"（问号占位由渲染层处理），
  // 名字塞进注释。真正贴切的外观要等人在切片器里换。
  for (const object of raw.objects ?? []) {
    const idx = object.y * W + object.x
    objCells[idx] = 'tiny-town:3,0'
    objStates[String(idx)] = object.state ?? {}
    TILESET.notes['3,0'] = { name: '物件', pass: 'walk' }
  }

  raw.map = {
    width: W,
    height: H,
    tilesets: [TILESET],
    layers: {
      background: { cells: bgCells },
      structure: { cells: stCells },
      object: { cells: objCells, states: objStates },
    },
  }
  // 旧字段清理：interior 已被 background 吸收；objects 已进 object 层
  delete raw.objects
  raw.migratedTo = 'tilemap-v1'
  return raw
}

for (const name of readdirSync(assetsDir)) {
  if (!name.endsWith('.json') || name.startsWith('.')) continue
  const file = join(assetsDir, name)
  const before = JSON.parse(readFileSync(file, 'utf8'))
  if (before.migratedTo === 'tilemap-v1') {
    console.log(`  · ${name}: 已是瓦片格式，跳过`)
    continue
  }
  const after = migrate(file)
  writeFileSync(file, JSON.stringify(after, null, 2) + '\n')
  const bg = after.map.layers.background.cells.filter((c) => c !== null).length
  const st = after.map.layers.structure.cells.filter((c) => c !== null).length
  const ob = after.map.layers.object.cells.filter((c) => c !== null).length
  console.log(`  · ${name}: background ${bg} 格 / structure ${st} 格 / object ${ob} 格`)
}
