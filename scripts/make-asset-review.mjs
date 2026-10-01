/**
 * 生成「素材核对表」——把每个槽位的贴图、以及"物件名 → 实际用图"的推断结果
 * 并排列出来，交给人来判断对应关系对不对。
 *
 * 为什么要给人看：贴图是否"像"那个东西，是视觉判断，代码无法自证。
 * 脚本能做的是把判断依据摆出来——用的是哪张图、靠名字里的哪个字匹配上的。
 * 一眼扫过去就能发现"画架→书架"这种靠单字误配的情况。
 *
 * 用法：node scripts/make-asset-review.mjs [输出路径]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] ?? join(root, '素材核对表.html')

// ── 1) 图集：key → dataUri（直接用 CSS sprite 定位，不需要裁图）──
const sheetText = readFileSync(join(root, 'src/client/sheetData.ts'), 'utf8')
const sheets = new Map()
const sheetCols = {}
for (const m of sheetText.matchAll(/"([a-z-]+)":\s*\{([\s\S]*?)\n  \},/g)) {
  const body = m[2]
  // 注意是单引号：sheetData.ts 里整个对象用单引号写字符串字面量
  const uri = body.match(/dataUri:\s*'([^']+)'/)
  const cols = body.match(/cols:\s*(\d+)/)
  if (uri !== null) sheets.set(m[1], uri[1])
  if (cols !== null) sheetCols[m[1]] = +cols[1]
}

const ALIAS = new Map([['T', 'tiny-town'], ['F', 'tiny-farm']])
function resolveSheet(token) {
  const bare = token.replaceAll("'", '')
  return ALIAS.get(bare) ?? bare
}

// ── 2) 槽位表：PROPS 与 OBJECT_LIBRARY ──
const styleText = readFileSync(join(root, 'src/client/mapStyle.ts'), 'utf8')
const propsText = styleText.slice(styleText.indexOf('export const PROPS'))
const props = new Map()
for (const m of propsText.split('\n').slice(0, 120).join('\n').matchAll(/^\s*([a-zA-Z]+):\s*\[([^\]]*)\]/gm)) {
  const cells = []
  for (const c of m[2].matchAll(/at\(\s*('[a-z-]+'|[A-Z])\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
    cells.push({ sheet: resolveSheet(c[1]), col: +c[2], row: +c[3] })
  }
  props.set(m[1], cells)
}

const libText = styleText.slice(styleText.indexOf('export const OBJECT_LIBRARY'))
const library = []
for (const m of libText.split('\n').slice(0, 60).join('\n').matchAll(/\{\s*slot:\s*'([a-z]+)',\s*label:\s*'([^']+)',\s*group:\s*'([^']+)',\s*alias:\s*\[([^\]]*)\]/g)) {
  library.push({
    slot: m[1], label: m[2], group: m[3],
    alias: [...m[4].matchAll(/'([^']+)'/g)].map((a) => a[1]),
  })
}

// ── 3) 复刻物件的推断：完全照 town.propSlotOf 的规则来，不另写一套 ──
const KINDS = { plant: 'tree', vehicle: 'vehicle', sign: 'sign' }
function infer(object) {
  if (typeof object.sprite === 'string' && object.sprite !== '') return { slot: object.sprite, why: '显式 sprite 字段' }
  const text = `${object.id} ${object.name}`.toLowerCase()
  for (const entry of library) {
    const hit = entry.alias.find((word) => text.includes(word.toLowerCase()))
    if (hit !== undefined) return { slot: entry.slot, why: `名字含「${hit}」` }
  }
  return { slot: KINDS[object.kind] ?? 'fallback', why: object.kind in KINDS ? `按类型 ${object.kind}` : '无匹配，兜底' }
}

const objects = []
for (const name of ['house', 'smallville']) {
  const data = JSON.parse(readFileSync(join(root, `assets/${name}.json`), 'utf8'))
  for (const o of data.objects ?? []) objects.push({ ...o, from: name })
}

// ── 4) 渲染 ──
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
/**
 * 贴图预览：靠 CSS sprite 定位到图集里的某一格。
 *
 * 图集本体只在 <style> 里出现一次（类名 s-<图集>）——每张贴图都内嵌一遍
 * 会让文件涨到几 MB，而浏览器本来就会缓存同一份 data URI。
 */
function tileHtml(cell, size) {
  const box = `width:${size}px;height:${size}px`
  if (cell === undefined) return `<span class="tile empty" style="${box}"></span>`
  if (!sheets.has(cell.sheet)) return `<span class="tile empty" style="${box}">?</span>`
  return `<span class="tile s-${cell.sheet}" data-sheet="${cell.sheet}" data-col="${cell.col}" data-row="${cell.row}" style="${box}"></span>`
}

const slotRows = library.map((entry) => {
  const cells = props.get(entry.slot) ?? []
  const previews = cells.slice(0, 4).map((c) => tileHtml(c, 48)).join('')
  return `<tr>
    <td class="mono">${esc(entry.slot)}</td>
    <td><b>${esc(entry.label)}</b><div class="dim">${esc(entry.group)}</div></td>
    <td class="tiles">${previews || '<span class="warn">无贴图</span>'}</td>
    <td class="dim mono">${cells.map((c) => `${c.sheet.split('.')[0]} ${c.col}:${c.row}`).join(', ') || '—'}</td>
    <td class="dim">${esc(entry.alias.join(' / '))}</td>
  </tr>`
}).join('\n')

const objRows = objects.map((o) => {
  const r = infer(o)
  const cells = props.get(r.slot) ?? []
  /**
   * 只把"完全没匹配到贴图"标成确定可疑。
   *
   * 靠单字匹配**不一定错**——「双人床」含一个「床」字落到 bed 就是对的，
   * 而「画架」含一个「架」字落到 bookshelf 是错的。脚本分不清这两种，
   * 所以不替人下判断，只在"匹配依据"列把它显出来，由眼睛定夺。
   */
  const suspicious = r.slot === 'fallback'
  const rough = /含「(.)」/.test(r.why)
  return `<tr class="${suspicious ? 'sus' : ''}">
    <td class="dim mono">${esc(o.from)}</td>
    <td><b>${esc(o.name)}</b></td>
    <td class="tiles">${tileHtml(cells[0], 40)}</td>
    <td class="mono">${esc(r.slot)}${r.slot === 'fallback' ? ' <span class="warn">（无匹配）</span>' : ''}</td>
    <td class="dim${rough ? ' rough' : ''}">${esc(r.why)}${rough ? '（单字匹配，可能是误配）' : ''}</td>
  </tr>`
}).join('\n')

const sheetCss = [...sheets].map(([key, uri]) => `.s-${key}{background-image:url(${uri})}`).join('\n')

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>dsh-paranim 素材核对表</title>
<style>
  body{font:14px/1.6 system-ui,"PingFang SC",sans-serif;background:#14171d;color:#e6ebf3;margin:0;padding:24px 28px}
  h1{font-size:19px;margin:0 0 4px} h2{font-size:16px;margin:30px 0 8px;padding-bottom:6px;border-bottom:1px solid #2b3240}
  .note{color:#9aa5b8;margin-bottom:6px} .dim{color:#8b96a9;font-size:12px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  table{border-collapse:collapse;width:100%;margin-top:6px}
  th,td{text-align:left;padding:6px 10px;border-bottom:1px solid #232a36;vertical-align:middle}
  th{color:#9aa5b8;font-weight:500;font-size:12px}
  tr.sus{background:#2a2117} .warn{color:#e8b45f}
  .rough{color:#c9a26a}
  .tiles{display:flex;gap:6px;flex-wrap:wrap}
  .tile{display:inline-block;image-rendering:pixelated;background-repeat:no-repeat;flex:0 0 auto;
        border:1px solid #2b3240;border-radius:3px;background-color:#0b0e13}
${sheetCss}
  .tile.empty{background:#0b0e13;display:flex;align-items:center;justify-content:center;color:#5a6577}
  tr.sus .tile{border-color:#e8b45f}
</style></head><body>
<h1>dsh-paranim 素材核对表</h1>
<div class="note">左边是程序实际会画出来的贴图。判断标准只有一个：<b>它像不像那个名字</b>。</div>
<div class="note">第 2 节里<b>黄色高亮</b>的行是脚本判定的可疑项（没有匹配到任何别名，或靠单字误配），请重点看。</div>

<h2>1. 物件资源池：槽位与贴图</h2>
<div class="table"><table>
<tr><th>槽位</th><th>名称</th><th>贴图（前 4 个候选）</th><th>图集与格号</th><th>按哪些词匹配</th></tr>
${slotRows}
</table></div>

<h2>2. 复刻镜像里每件物件实际会用哪张图</h2>
<div class="note">“匹配依据”是程序挑选贴图时实际用的那一步。若某件东西明显应该有自己的样子却落到了“无匹配”，把它的名字加进 OBJECT_LIBRARY 的 alias，或直接在界面上选中它换一张贴图。</div>
<table>
<tr><th>来源</th><th>物件名</th><th>会画成</th><th>槽位</th><th>匹配依据</th></tr>
${objRows}
</table>

<script>
// 按图集真实列数算 background-size，否则 sprite 定位会错位
const COLS = ${JSON.stringify(sheetCols)}
const TILE = ${JSON.stringify(Object.fromEntries([]))}
for (const el of document.querySelectorAll('.tile[data-sheet]')) {
  const sheet = el.dataset.sheet
  const cols = COLS[sheet] ?? 12
  const size = parseFloat(el.style.width)
  const scale = size / 16
  el.style.backgroundSize = cols * 16 * scale + 'px auto'
  el.style.backgroundPosition = (-el.dataset.col * 16 * scale) + 'px ' + (-el.dataset.row * 16 * scale) + 'px'
}
</script>
</body></html>
`
writeFileSync(out, html)
console.log(`已生成 ${out}`)
console.log(`  槽位 ${library.length} 个，复刻物件 ${objects.length} 件`)
const sus = objects.filter((o) => infer(o).slot === 'fallback')
console.log(`  无匹配贴图的物件 ${sus.length} 件：${sus.map((o) => o.name).join('、')}`)
