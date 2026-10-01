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

// 从源码里抽出 OBJECT_LIBRARY 与 PROPS 的槽位→坐标映射(不引入运行时依赖)
const styleSrc = readFileSync(join(root, 'src', 'client', 'mapStyle.ts'), 'utf8')

/**
 * `mapStyle.ts` 里图集是用缩写常量写的(`at(T, 4, 10)`)。这里从源码里**解析**
 * 这张缩写表,而不是把 `T→tiny-town.png` 硬编码进脚本——硬编码会让两边悄悄漂移。
 */
const ALIAS = new Map()
for (const m of styleSrc.matchAll(/^const ([A-Z]+)\s*=\s*'([a-z-]+)' as const$/gm)) ALIAS.set(m[1], m[2] + '.png')
if (ALIAS.size === 0) { console.error('  ✗ 没解析出图集缩写表'); process.exit(1) }
const libraryText = styleSrc.slice(styleSrc.indexOf('export const OBJECT_LIBRARY'))
const slots = [...libraryText.matchAll(/\{ slot: '([a-z]+)'/g)].map((m) => m[1])
if (slots.length === 0) { console.error('  ✗ 没解析出资源池槽位'); process.exit(1) }

const propsText = styleSrc.slice(styleSrc.indexOf('export const PROPS'))
const refs = new Map() // slot → [{sheet,col,row}]
for (const line of propsText.split('\n')) {
  const m = line.match(/^\s*([a-z]+):\s*\[(.*)\],/)
  if (m === null) continue
  const slot = m[1]
  const cells = []
  for (const c of m[2].matchAll(/at\(('[a-z-]+'|[A-Za-z][A-Za-z-]*)\s*,\s*(\d+)\s*,\s*(\d+)\)/g)) {
    const [, rawSheet, col, row] = c
    const isQuoted = rawSheet.startsWith("'")
    const sheet = isQuoted
      ? rawSheet.replaceAll("'", '') + '.png'
      : ALIAS.get(rawSheet)
    cells.push({ sheet: sheet ?? rawSheet, col: +col, row: +row, raw: rawSheet })
  }
  refs.set(slot, cells)
}

let bad = 0
/**
 * 空槽位是**允许**的——它表示"这个槽位还没有目视确认过的贴图"，渲染时会画问号。
 * 但数量必须报出来：全空也"通过"就等于没有校验，那种绿是假的。
 */
const pending = []
for (const slot of slots) {
  const cells = refs.get(slot) ?? []
  if (cells.length === 0) { pending.push(slot); continue }
  for (const cell of cells) {
    const meta = sheets.get(cell.sheet)
    if (meta === undefined) { console.error(`  ✗ 槽位 ${slot} 引用了不存在的图集 ${cell.raw ?? cell.sheet}`); bad++; continue }
    if (cell.col >= meta.cols || cell.row >= meta.rows) {
      console.error(`  ✗ 槽位 ${slot} 的贴图越界:${cell.sheet} ${cell.col},${cell.row}(图集 ${meta.cols}×${meta.rows})`)
      bad++
    }
  }
}
const filled = slots.length - pending.length
if (filled === 0) { console.error('  ✗ 资源池一个槽位都没有贴图'); bad++ }
else {
  console.log(`  资源池 ${filled}/${slots.length} 个槽位有贴图，贴图都落在图集网格内`)
  if (pending.length > 0) console.log(`  待确认(画问号占位)：${pending.join('、')}`)
}

// 自行车必须有两个轮子:轮圈那几行里,至少有一行呈现"左右两段独立像素"。
// 判据不取单一行——轮圈闭合的那一行中间会连起来——而是取轮心上下三行里任一行成立即可。
const bikeCells = refs.get('bike') ?? []
const city = sheets.get('city.png')
for (const cell of bikeCells) {
  if (cell.sheet !== 'city.png' || city === undefined) continue
  let twoWheelRows = 0
  for (const rowAt of [10, 11, 12]) {
    const runs = []
    let inside = false, start = 0
    for (let x = 0; x < 16; x++) {
      const o = ((cell.row * 16 + rowAt) * city.w + cell.col * 16 + x) * 4
      const opaque = city.px[o + 3] >= 128
      if (opaque && !inside) { inside = true; start = x }
      else if (!opaque && inside) { inside = false; runs.push([start, x - 1]) }
    }
    if (inside) runs.push([start, 15])
    // 宽度 >= 2 才算轮子;车架是 1px 连线,不该被算进来
    if (runs.filter(([a, b]) => b - a >= 1).length === 2) twoWheelRows++
  }
  if (twoWheelRows === 0) {
    console.error(`  ✗ 自行车贴图 ${cell.col},${cell.row} 看不到分离的两个轮子`)
    bad++
  }
}
if (bikeCells.length === 0) { console.error('  ✗ 没有自行车贴图'); bad++ }
else console.log(`  自行车贴图 ${bikeCells.length} 张,轮圈行均呈现前后两个轮子`)

// 注释里声称的"实测色"必须真的对得上。mapStyle.ts 靠这些色值说明每格取材依据,
// 色值一旦漂移(比如图集被重新归一),注释就成了误导——比没有注释更糟。
// 清单里每行以**槽位名**开头,所以能逐槽核对而不是抽样。
{
  const styleText = readFileSync(join(root, 'src', 'client', 'mapStyle.ts'), 'utf8')
  const claims = new Map()
  for (const m of styleText.matchAll(/·\s*([a-zA-Z][a-zA-Z0-9]*)\s+\S+\s*(#[0-9a-fA-F]{6})/g)) {
    claims.set(m[1], m[2].toLowerCase())
  }

  const groundText = styleText.slice(styleText.indexOf('export const GROUND'))
  const groundRefs = new Map()
  for (const gm of groundText.split('\n').slice(0, 60).join('\n').matchAll(/^\s*([a-zA-Z]+):\s*\[(.*)\]/gm)) {
    const cells = []
    for (const c of gm[2].matchAll(/at\(('[a-z-]+'|[A-Za-z][A-Za-z-]*)\s*,\s*(\d+)\s*,\s*(\d+)\)/g)) {
      const rawSheet = c[1]
      const sheet = rawSheet.startsWith("'") ? rawSheet.replaceAll("'", '') + '.png' : ALIAS.get(rawSheet)
      cells.push({ sheet: sheet ?? rawSheet, col: +c[2], row: +c[3] })
    }
    groundRefs.set(gm[1], cells)
    if (gm[1] === 'void') break
  }

  const avgOf = (cell) => {
    const meta = sheets.get(cell.sheet)
    let R = 0, G = 0, B = 0, n = 0
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const o = ((cell.row * 16 + y) * meta.w + cell.col * 16 + x) * 4
      if (meta.px[o + 3] < 128) continue
      n++; R += meta.px[o]; G += meta.px[o + 1]; B += meta.px[o + 2]
    }
    return n === 0 ? undefined : '#' + [R / n, G / n, B / n].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  }

  let checked = 0
  let mismatched = 0
  for (const [slot, claimed] of claims) {
    const cell = (groundRefs.get(slot) ?? [])[0]
    if (cell === undefined) continue
    const actual = avgOf(cell)
    if (actual === undefined) continue
    checked++
    if (actual !== claimed) {
      mismatched++
      console.error(`  ✗ 注释声称 ${slot} 是 ${claimed},实测 ${actual}(图集被改过?改注释或改槽位)`)
      bad++
    }
  }
  // 措辞要跟着结果走:一句话里既报错又说"一致"会让人以为只有一处坏
  if (checked > 0) {
    console.log(
      mismatched === 0
        ? `  地面实测色与注释一致:${checked} 个槽位`
        : `  地面实测色:${checked - mismatched}/${checked} 个槽位一致,${mismatched} 个对不上`,
    )
  }
}

// 笔刷必须真的能画出来 —— 这是"涂了没反应"这类静默失败的唯一防线。
//
// 一次涂抹要穿过四层才落到画面上:
//   ① index.tsx 的 GROUND_PALETTE(面板上有这个笔刷)
//   ② store.ts 的 GROUND_CHARS(材质名 ↔ 字符)
//   ③ layout.ts 的字符映射(字符 → Terrain)
//   ④ town.ts 的 TERRAIN_SLOT + mapStyle 的 GROUND(材质 → 非空贴图槽)
// 任何一层漏掉一种材质,玩家点下去都毫无变化、且**不报错**。四层逐一断言。
{
  const paletteText = readFileSync(join(root, 'src', 'client', 'index.tsx'), 'utf8')
  const storeText = readFileSync(join(root, 'src', 'host', 'store.ts'), 'utf8')
  const layoutText = readFileSync(join(root, 'src', 'client', 'layout.ts'), 'utf8')
  const townText = readFileSync(join(root, 'src', 'client', 'town.ts'), 'utf8')
  const styleText = readFileSync(join(root, 'src', 'client', 'mapStyle.ts'), 'utf8')

  const kinds = [...paletteText.matchAll(/\{\s*kind:\s*'([a-z]+)'/g)].map((m) => m[1])
  const charOf = new Map([...storeText.matchAll(/\['([a-z])',\s*'([a-z]+)'\]/g)].map((m) => [m[2], m[1]]))
  const terrainOfChar = new Map(
    // 宽松匹配到行尾第一个引号词:'g' 那行是三元表达式(grassAlt : grass),
    // 只要拿到其中一个能落地的材质即可。
    [...layoutText.matchAll(/ch === '([a-z])'[^\n]*?'([a-zA-Z]+)'/g)].map((m) => [m[1], m[2]]),
  )
  const slotOfTerrain = new Map([...townText.matchAll(/^\s*([a-zA-Z]+):\s*'([a-zA-Z]+)',/gm)].map((m) => [m[1], m[2]]))
  const groundSlots = new Set(
    [...styleText.slice(styleText.indexOf('export const GROUND')).split('\n').slice(0, 60).join('\n')
      .matchAll(/^\s*([a-zA-Z]+):\s*\[([^\]]*)\]/gm)]
      .filter((m) => m[2].trim() !== '').map((m) => m[1]),
  )

  if (kinds.length === 0) { console.error('  ✗ 没解析到笔刷面板的材质清单'); bad++ }
  for (const kind of kinds) {
    const ch = charOf.get(kind)
    if (ch === undefined) { console.error(`  ✗ 笔刷「${kind}」没有字符映射(store.GROUND_CHARS)`); bad++; continue }
    const terrain = terrainOfChar.get(ch)
    if (terrain === undefined) { console.error(`  ✗ 笔刷「${kind}」的字符 '${ch}' 在 layout 里没有去向`); bad++; continue }
    const slot = slotOfTerrain.get(terrain)
    if (slot === undefined) { console.error(`  ✗ 材质「${terrain}」在 TERRAIN_SLOT 里没有槽位`); bad++; continue }
    if (!groundSlots.has(slot)) { console.error(`  ✗ 材质「${terrain}」指向的槽位 ${slot} 没有贴图`); bad++; continue }
  }
  if (bad === 0) console.log(`  笔刷 ${kinds.length} 种材质四层贯通(面板→字符→材质→贴图)`)
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
    console.log(`  兜底小镇与镜像同步:${mirror.places.length} 地标 / ${mirror.objects.length} 物件`)
  }
}

if (bad > 0) { console.error(`❌ 素材校验失败:${bad} 处`); process.exit(1) }
console.log('✅ 素材自治校验通过')
