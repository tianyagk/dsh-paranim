/**
 * 按原版栅格重建 Smallville 镜像：路网 + 全部地点的精确外接框。
 *
 * 数据来源是斯坦福 generative_agents 的 `arena_maze.csv`（140×100 的 tile id 栅格），
 * 它把"哪些格是建筑、哪些格是路"记得明明白白——这正是之前缺的东西：
 * 上一版只有 19 个地标的外接框，没有路网，所以地图看起来是"草地上一堆色块"。
 *
 * 这份 CSV 里：
 *   · 0 = 可通行的空地（街与院），非 0 = 建筑的内部格
 *   · tile id 从 32138 起，`(id - 32138) % 10` 是 tileset 的列（= 建筑族）
 *   · 建筑族恰好编码了地点的类型，可用来分配屋顶配色
 *
 * 做法：
 *   1. 把非 0 格聚成连通块（4-连通）→ 每块就是一处地点
 *   2. 取每块里"实心"的行列区间作为精确外接框（原版几何，不是拟合出来的）
 *   3. 用现有镜像里的地标名去认领最近的块（保留角色与叙事），余下的按族与位置命名
 *   4. 空地烘成 `map.tiles`（'r' = 泥土路），让路网真的出现在画面上
 *
 * 用法：node scripts/gen-smallville-layout.mjs [arena_maze.csv 路径]
 * 依赖：把 arena_maze.csv 放在 assets/source/ 下（脚本会提示怎么取）。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const csvPath = process.argv[2] ?? join(root, 'assets', 'source', 'arena_maze.csv')
// 命名基线：**只含名字与叙事**的原始地标表，是脚本的输入而不是它的输出。
// 直接读 smallville.json 会让第二次运行把上一次自动生成的名字当成原始名字认领，
// 阈值内的块被反复改名。
const mirrorPath = join(root, 'assets', 'source', 'smallville-places.json')
const outPath = join(root, 'assets', 'smallville.json')

if (!existsSync(csvPath)) {
  console.error(`找不到 ${csvPath}\n`)
  console.error('先取原版栅格（Apache-2.0，随 generative_agents 发布）：')
  console.error('  mkdir -p assets/source && curl -sL -o assets/source/arena_maze.csv \\')
  console.error('    https://raw.githubusercontent.com/joonspk-research/generative_agents/main/\\')
  console.error('    environment/frontend_server/static_dirs/assets/the_ville/matrix/maze/arena_maze.csv')
  process.exit(2)
}

const WIDTH = 140
const HEIGHT = 100
const TILE_BASE = 32138
/** tileset 列 → 建筑族名。列值来自栅格统计，含义按"同一列即同一类建筑"分组。 */
const FAMILY_NAMES = ['住宅', '住宅', '公寓', '公寓', '商业', '商业', '住宅', '住宅', '住宅', '住宅']
/** 建筑族 → 屋顶配色槽位（对应 mapStyle.BUILDING）。 */
const FAMILY_ROOF = {
  住宅: 'roofHome',
  公寓: 'roofCool',
  商业: 'roofWarm',
}

const raw = readFileSync(csvPath, 'utf8')
const values = raw
  .split(/[\n,]/)
  .map((t) => t.trim())
  .filter((t) => t !== '')
  .map(Number)
if (values.length !== WIDTH * HEIGHT) {
  console.error(`栅格尺寸不对：读到 ${values.length} 格，期望 ${WIDTH * HEIGHT}`)
  process.exit(2)
}
const at = (x, y) => values[y * WIDTH + x]
const tileFamily = (v) => (v === 0 ? undefined : (v - TILE_BASE) % 10)

// ── 1) 连通块 → 地点 ──────────────────────────────────────────────────────
const seen = Array.from({ length: HEIGHT }, () => new Uint8Array(WIDTH))
const blocks = []
for (let y0 = 0; y0 < HEIGHT; y0 += 1) {
  for (let x0 = 0; x0 < WIDTH; x0 += 1) {
    if (at(x0, y0) === 0 || seen[y0][x0] === 1) continue
    const stack = [[x0, y0]]
    seen[y0][x0] = 1
    const cells = []
    while (stack.length > 0) {
      const [x, y] = stack.pop()
      cells.push([x, y])
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= WIDTH || ny >= HEIGHT) continue
        if (seen[ny][nx] === 1 || at(nx, ny) === 0) continue
        seen[ny][nx] = 1
        stack.push([nx, ny])
      }
    }
    if (cells.length < 10) continue // 零星装饰格，不是地点
    const xs = cells.map((c) => c[0])
    const ys = cells.map((c) => c[1])
    const x0b = Math.min(...xs)
    const x1b = Math.max(...xs)
    const y0b = Math.min(...ys)
    const y1b = Math.max(...ys)
    // 只保留"实心"的行列：连通块常把相邻房间与它们的走廊连在一起，
    // 直接用极值会把空隙也算进来，得到虚胖的框。
    const solidXs = []
    for (let x = x0b; x <= x1b; x += 1) {
      let n = 0
      for (let y = y0b; y <= y1b; y += 1) if (at(x, y) !== 0) n += 1
      if (n > 0.6 * (y1b - y0b + 1)) solidXs.push(x)
    }
    const solidYs = []
    for (let y = y0b; y <= y1b; y += 1) {
      let n = 0
      for (let x = x0b; x <= x1b; x += 1) if (at(x, y) !== 0) n += 1
      if (n > 0.6 * (x1b - x0b + 1)) solidYs.push(y)
    }
    const famCount = new Map()
    for (const [x, y] of cells) {
      const f = tileFamily(at(x, y))
      famCount.set(f, (famCount.get(f) ?? 0) + 1)
    }
    const fam = [...famCount.entries()].sort((a, b) => b[1] - a[1])[0][0]
    blocks.push({
      x0: solidXs.length > 0 ? Math.min(...solidXs) : x0b,
      x1: solidXs.length > 0 ? Math.max(...solidXs) : x1b,
      y0: solidYs.length > 0 ? Math.min(...solidYs) : y0b,
      y1: solidYs.length > 0 ? Math.max(...solidYs) : y1b,
      area: cells.length,
      family: FAMILY_NAMES[fam] ?? '住宅',
    })
  }
}
console.log(`从栅格解出 ${blocks.length} 处地点`)

// ── 2) 用现有镜像的名字认领最近的块（保留角色与叙事）────────────────────
const baseline = JSON.parse(readFileSync(mirrorPath, 'utf8'))
void baseline.map // 基线可能不带 map，下面用 ?? {} 兜底
const named = baseline.places.map((p) => ({
  name: p.name,
  desc: p.desc,
  tags: p.tags,
  x: p.x,
  y: p.y,
}))
const claimed = new Set()
const centres = blocks.map((b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 }))
const resolved = blocks.map((b, i) => {
  let best = -1
  let bestD = Number.POSITIVE_INFINITY
  for (let j = 0; j < named.length; j += 1) {
    if (claimed.has(j)) continue
    const d = Math.hypot(centres[i].x - named[j].x, centres[i].y - named[j].y)
    if (d < bestD) {
      bestD = d
      best = j
    }
  }
  if (best >= 0 && bestD <= 14) claimed.add(best)
  const src = best >= 0 && bestD <= 14 ? named[best] : undefined
  return { ...b, name: src?.name, desc: src?.desc, tags: src?.tags }
})
const unnamed = resolved.filter((r) => r.name === undefined).length
console.log(`  其中 ${resolved.length - unnamed} 处沿用原有名，${unnamed} 处按类型与位置新命名`)

// ── 3) 命名补缺：按族与相对位置起一个符合语境的房间名 ────────────────────
const ordinal = { 住宅: ['起居室', '厨房', '卧室', '书房'], 公寓: ['客厅', '卧室', '阳台'], 商业: ['店面', '后厨', '仓库'] }
const counters = new Map()
function autoName(block) {
  const list = ordinal[block.family] ?? ['房间']
  const n = counters.get(block.family) ?? 0
  counters.set(block.family, n + 1)
  return `${list[n % list.length]} ${Math.floor(n / list.length) + 1}`
}

// ── 4) 输出：地点 + 路网 tiles ───────────────────────────────────────────
const places = resolved.map((b, i) => {
  const name = b.name ?? autoName(b)
  const w = b.x1 - b.x0 + 1
  const h = b.y1 - b.y0 + 1
  return {
    id: `place-${i + 1}`,
    name,
    kind: 'place',
    // 中心取整：外接框宽度为偶数时 (w-1)/2 会得到 .5，归一化再四舍五入，
    // 于是镜像与种入副本逐字段比对会差半格。半格坐标没有意义，直接取整。
    x: Math.round(b.x0 + (w - 1) / 2),
    y: Math.round(b.y0 + (h - 1) / 2),
    w,
    h,
    color: b.family === '商业' ? '#c9843f' : b.family === '公寓' ? '#6b7f9c' : '#a8623f',
    interactive: true,
    state: { open: true },
    desc: b.desc ?? `${b.family}·按原版栅格外接框还原`,
    tags: b.tags ?? [b.family],
    roofSlot: FAMILY_ROOF[b.family] ?? 'roofHome',
  }
})

// 路网：把"非建筑格"里的通路烘成泥土路。
// 判据不是"非零"而是"离建筑足够近的空地"——整张 140×100 全铺路既不合理也不好看。
const tiles = []
for (let y = 0; y < HEIGHT; y += 1) {
  let row = ''
  for (let x = 0; x < WIDTH; x += 1) {
    if (at(x, y) !== 0) {
      row += 'g' // 建筑占地：由地点矩形与建筑渲染层负责，tiles 里留草地
      continue
    }
    // 到最近建筑格的距离（只查 2 格半径）。半径放大到 3 会让路网占到 25% 的图面，
    // 看起来像整张地图都是路；2 格恰好描述"贴着建筑的通路"。
    let touching = false
    for (let dy = -2; dy <= 2 && !touching; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        const nx = x + dx
        const ny = y + dy
        if (nx < 0 || ny < 0 || nx >= WIDTH || ny >= HEIGHT) continue
        if (at(nx, ny) !== 0) {
          touching = true
          break
        }
      }
    }
    row += touching ? 'r' : 'g'
  }
  tiles.push(row)
}
const roadTiles = tiles.join('').split('').filter((c) => c === 'r').length
console.log(`  路网覆盖 ${roadTiles} 格（${((roadTiles / (WIDTH * HEIGHT)) * 100).toFixed(1)}%）`)

const next = {
  ...baseline,
  // 镜像版本：升级时 store.ensureSeed 据此决定要不要更新玩家目录里的副本
  mirrorVersion: '2',
  desc: '复刻斯坦福 generative_agents 的 Smallville：地点外接框与路网全部按原版 140×100 栅格还原。',
  attribution:
    '地点外接框与路网解自 joonspk-research/generative_agents 的 arena_maze.csv（Stanford Generative Agents, UIST 2023, Apache-2.0）；' +
    '居民设定取自 storage/base_the_ville_n25/personas/<Name>/bootstrap_memory/scratch.json；' +
    '像素图集取自 Kenney（kenney.nl）CC0。',
  map: { ...(baseline.map ?? {}), width: WIDTH, height: HEIGHT, tiles },
  places,
  // 物件、居民与关系与地点几何无关，**原样带过去**。
  // 这条曾经漏过：脚本只输出 places，一次运行就把 24 件物件与 8 位居民抹掉了。
  objects: baseline.objects ?? [],
  agents: baseline.agents ?? [],
  relations: baseline.relations ?? [],
}
writeFileSync(outPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
console.log(`\n已写入 ${outPath}：${places.length} 处地点`)
console.log('  商业', places.filter((p) => (p.tags ?? []).includes('商业')).length,
  '| 公寓', places.filter((p) => (p.tags ?? []).includes('公寓')).length,
  '| 住宅', places.filter((p) => (p.tags ?? []).includes('住宅')).length)
