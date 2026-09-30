/**
 * 把归一后的图集快照成 TypeScript 模块（base64 内嵌）。
 *
 * 为什么内嵌而不是运行时读文件：客户端是浏览器，拿不到本地路径。要么起一条
 * HTTP 路由去发图（多一层接口、多一次请求、多一份缓存策略），要么把字节直接
 * 编进产物。前者对"六张图集合计约 100 KB"这个体量不划算，而且内嵌让插件
 * 保持**原子**——一个 bundle 就是全部，离线也不缺图。
 *
 * 产物是**生成物**，不要手改：改了图集就重跑本脚本。
 *
 * 用法：node scripts/snapshot-assets.mjs
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const packDir = join(root, 'assets', 'pack')

const manifestPath = join(packDir, 'manifest.json')
if (!existsSync(manifestPath)) {
  console.error('缺少 assets/pack/manifest.json —— 先跑 node scripts/normalize-assets.mjs')
  process.exit(2)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const entries = []
let total = 0
for (const sheet of manifest.sheets) {
  const file = join(packDir, sheet.file)
  if (!existsSync(file)) {
    console.error(`  跳过（缺文件）：${sheet.file}`)
    continue
  }
  const bytes = readFileSync(file)
  total += bytes.length
  entries.push({ ...sheet, b64: bytes.toString('base64') })
  console.log(`  ${sheet.file.padEnd(18)} ${String(sheet.cols).padStart(3)}×${String(sheet.rows).padStart(3)}  ${(bytes.length / 1024).toFixed(1)} KB`)
}

const out = `/**
 * 像素图集快照 —— **生成物，不要手改**（node scripts/snapshot-assets.mjs）。
 *
 * 六张 Kenney 图集（全部 CC0 1.0，16×16，间隙已由 normalize-assets.mjs 消掉），
 * 以 base64 内嵌，运行时经 createImageBitmap / Image 解码后按 \`col/row\` 取格子。
 *
 * 素材分工（按确认的方案）：
 *  · tiny-town / tiny-farm / tiny-battle —— 主素材（地面、建筑、道路、物件）
 *  · city —— 镇上物件与设施的补充（1036 格，城市题材）
 *  · onebit —— **后备**：Tiny 系列缺的标记/状态/事件符号从这里取
 *  · characters —— 角色（4 向，16×16）
 *
 * 图源许可逐字保留在 assets/style-preview/LICENSE-kenney-*.txt。
 * 制作者 Kenney（kenney.nl），CC0 1.0：可商用、免署名、无传染性。
 */

export interface SheetMeta {
  /** 图集文件名（assets/pack 下的名字）。 */
  file: string
  cols: number
  rows: number
  tile: number
  /** 人类可读的出处说明。 */
  note: string
  /** data URI，可直接喂给 Image / createImageBitmap。 */
  dataUri: string
}

export const SHEETS: Record<string, SheetMeta> = {
${entries
  .map(
    (e) => `  ${JSON.stringify(e.file.replace(/\.png$/, ''))}: {
    file: ${JSON.stringify(e.file)},
    cols: ${e.cols},
    rows: ${e.rows},
    tile: ${e.tile},
    note: ${JSON.stringify(e.note)},
    dataUri: 'data:image/png;base64,${e.b64}',
  },`,
  )
  .join('\n')}
}

/** 图集键名（与 SHEETS 的键一致）。 */
export type SheetKey = ${entries.map((e) => JSON.stringify(e.file.replace(/\.png$/, ''))).join(' | ')}

export const TOTAL_BYTES = ${total}
`

const target = join(root, 'src', 'client', 'sheetData.ts')
writeFileSync(target, out, 'utf8')
console.log(`\n生成 src/client/sheetData.ts（${entries.length} 张图集，${(total / 1024).toFixed(1)} KB → base64 后约 ${(total * 1.37 / 1024).toFixed(0)} KB）`)
