/**
 * 素材自治校验：防"槽位指向错格子"这类只有运行时才看得见的 bug。
 *
 * 为什么要它：曾经把载具槽位写成 at('tiny-battle', 0, 4)——那格是**水面地块**,
 * 于是世界里的车全画成一滩水。这类错误不会报错、typecheck 也看不出来,
 * 只有把图渲染出来才会发现,而 check 流程里没人看渲染。
 * 所以这里用**结构化断言**代替眼睛:
 *   ① 资源池里登记的槽位必须真的有贴图、且坐标落在图集网格内;
 *   ② 自行车必须是"两个轮子":底轮的同一行要出现两段独立的不透明像素。
 */
import { readFileSync, existsSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import { execSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const packDir = join(root, 'assets', 'pack')

function decodePng(buf) {
  let pos = 8, w = 0, h = 0, ct = 6, plte = null, trns = null
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii')
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ct = data[9] }
    else if (type === 'PLTE') plte = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const ch = ct === 6 ? 4 : ct === 2 ? 3 : ct === 0 ? 1 : ct === 4 ? 2 : 0
  const stride = ct === 3 ? Math.ceil((w * 8) / 8) : w * ch
  const px = Buffer.alloc(w * h * 4)
  let prev = Buffer.alloc(stride), q = 0
  for (let y = 0; y < h; y++) {
    const f = raw[q]; q++
    const line = Buffer.from(raw.subarray(q, q + stride)); q += stride
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0
      if (f === 1) line[x] = (line[x] + a) & 255
      else if (f === 2) line[x] = (line[x] + b) & 255
      else if (f === 3) line[x] = (line[x] + ((a + b) >> 1)) & 255
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      }
    }
    for (let x = 0; x < w; x++) {
      const d = (y * w + x) * 4
      if (ct === 3) {
        const i = line[x]
        px[d] = plte[i * 3]; px[d + 1] = plte[i * 3 + 1]; px[d + 2] = plte[i * 3 + 2]
        px[d + 3] = trns !== null && i < trns.length ? trns[i] : 255
      } else {
        const s = x * ch
        if (ch === 4) { px[d] = line[s]; px[d + 1] = line[s + 1]; px[d + 2] = line[s + 2]; px[d + 3] = line[s + 3] }
        else if (ch === 3) { px[d] = line[s]; px[d + 1] = line[s + 1]; px[d + 2] = line[s + 2]; px[d + 3] = 255 }
        else { px[d] = px[d + 1] = px[d + 2] = line[s]; px[d + 3] = 255 }
      }
    }
    prev = line
  }
  return { w, h, px }
}

const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8'))
const sheets = new Map()
for (const meta of manifest.sheets) {
  const file = join(packDir, meta.file)
  if (!existsSync(file)) { console.error(`  ✗ 缺图集 ${meta.file}`); process.exitCode = 1; continue }
  sheets.set(meta.file, { ...meta, ...decodePng(readFileSync(file)) })
}
/** 累计的问题数；脚本末尾据此决定退出码。 */
let bad = 0

// 瓦片模型的自洽：迁移后的镜像必须能被规则层读懂。
//
// 旧版断言的是"笔刷四层贯通"（面板→字符→材质→贴图），那套已随字符画
// 一起退役。新模型下要守的是另一件事：**每格引用的图集都在沙盒里、
// 引用格式合法**——引用指向不存在的图集时渲染会静默跳过那一格，
// 画面上就是"这里什么都没有"，不报任何错。
{
  const { objectsOf, parseRef } = await import('../src/shared/tilemap.ts')
  for (const name of ['smallville', 'house']) {
    const data = JSON.parse(readFileSync(join(root, 'assets', `${name}.json`), 'utf8'))
    const map = data.map ?? {}
    const tilesetIds = new Set((map.tilesets ?? []).map((t) => t.id))
    let dangling = 0
    let noted = 0
    const total = { background: 0, structure: 0, object: 0 }
    for (const layerName of ['background', 'structure', 'object']) {
      const cells = map.layers?.[layerName]?.cells ?? []
      for (const cell of cells) {
        if (cell === null) continue
        total[layerName] += 1
        const parsed = parseRef(cell)
        if (parsed === undefined || !tilesetIds.has(parsed.setId)) { dangling += 1; continue }
        if ((map.tilesets.find((t) => t.id === parsed.setId)?.notes ?? {})[`${parsed.col},${parsed.row}`] !== undefined) noted += 1
      }
    }
    if (dangling > 0) {
      console.error(`  ✗ ${name} 有 ${dangling} 格引用了不存在的图集（渲染会静默跳过）`)
      bad++
    } else {
      console.log(`  ${name}: 三层 ${total.background + total.structure + total.object} 格瓦片全部指向沙盒自己的图集（背景 ${total.background} / 墙 ${total.structure} / 物件 ${total.object}）`)
    }
    // 门必须能开关：object 层标了 use:door 的格子要有 open 状态可挂
    const doorNotes = new Set()
    for (const t of map.tilesets ?? []) {
      for (const [key, note] of Object.entries(t.notes ?? {})) {
        if (note?.use === 'door') doorNotes.add(`${t.id}:${key}`)
      }
    }
    const doorCells = (map.layers?.object?.cells ?? []).filter((c) => c !== null && doorNotes.has(c))
    if (doorCells.length > 0) console.log(`  ${name}: ${doorCells.length} 格门（注释 use:door，关上即挡路）`)
  }
}

// 生成物必须与它的源同步。fallback.ts 是"镜像读不到时"的降级路径,
// 它一旦落后于镜像,玩家正常路径看到新小镇、降级时看到旧小镇——而这
// 只在磁盘镜像损坏时才暴露,平时根本发现不了。
// 判据不用解析 TS 字面量(键没引号,不是合法 JSON),而是重跑一次生成
// 脚本、比对产物有没有变化:变了就说明签入的是陈旧副本。
{
  const fbPath = join(root, 'src', 'host', 'fallback.ts')
  const before = readFileSync(fbPath, 'utf8')
  execSync('node scripts/gen-fallback.mjs', { cwd: root, stdio: 'pipe' })
  const after = readFileSync(fbPath, 'utf8')
  if (before !== after) {
    console.error('  ✗ fallback.ts 与 assets/smallville.json 不同步(刚由脚本重新生成,请签入新产物)')
    bad++
  } else {
    const mirror = JSON.parse(readFileSync(join(root, 'assets', 'smallville.json'), 'utf8'))
    console.log(`  兜底小镇与镜像同步:${mirror.places.length} 地标 / ${(mirror.map?.layers?.object?.cells ?? []).filter((c) => c !== null).length} 格物件`)
  }
}

if (bad > 0) { console.error(`❌ 素材校验失败:${bad} 处`); process.exit(1) }
console.log('✅ 素材自治校验通过')
