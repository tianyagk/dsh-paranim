/**
 * 生成「图集标注器」——把每张图集的**每一格**连编号铺开，供人点击标注它是什么。
 *
 * 为什么需要它：选贴图这件事，按平均色反查只对**纯色地面**有效（草地、石板
 * 整格同色，颜色就是身份）。对**有形状的物件**（树、床、灶台）颜色完全不能
 * 说明问题——一棵树和一片灌木的平均色可以一模一样。这件事只能靠眼睛，所以
 * 工具的作用不是替人判断，而是把"编号"这个人和代码之间的共同语言摆到眼前。
 *
 * 用法：node scripts/make-sheet-annotator.mjs [输出路径]
 * 打开后：先点左边一个槽位，再点格子，该格就记到那个槽位名下；右下角导出。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = process.argv[2] ?? join(root, '图集标注器.html')

const sheetText = readFileSync(join(root, 'src/client/sheetData.ts'), 'utf8')
const sheets = {}
for (const m of sheetText.matchAll(/"([a-z-]+)":\s*\{([\s\S]*?)\n  \},/g)) {
  const body = m[2]
  const uri = body.match(/dataUri:\s*'([^']+)'/)
  const cols = body.match(/cols:\s*(\d+)/)
  const rows = body.match(/rows:\s*(\d+)/)
  if (uri === null || cols === null || rows === null) continue
  sheets[m[1]] = { uri: uri[1], cols: +cols[1], rows: +rows[1] }
}

const styleText = readFileSync(join(root, 'src/client/mapStyle.ts'), 'utf8')

/** 把 mapStyle 里当前的 PROPS 映射读出来，作为标注器的初始状态。 */
const SHEET_ALIAS = new Map([['T', 'tiny-town'], ['F', 'tiny-farm']])
function readRefs(tableName) {
  const tail = styleText.slice(styleText.indexOf(`export const ${tableName}`))
  const body = tail.slice(0, tail.indexOf('\n}'))
  const out = {}
  for (const m of body.matchAll(/^\s*([a-zA-Z]+):\s*\[([^\]]*)\]/gm)) {
    const cells = []
    for (const c of m[2].matchAll(/at\(\s*('[a-z-]+'|[A-Z])\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g)) {
      const bare = c[1].replaceAll("'", '')
      cells.push([SHEET_ALIAS.get(bare) ?? bare, +c[2], +c[3]])
    }
    if (cells.length > 0) out[m[1]] = cells
  }
  return out
}
const confirmed = { ...readRefs('PROPS'), ...readRefs('BUILDING'), ...readRefs('SYMBOLS') }

const libText = styleText.slice(styleText.indexOf('export const OBJECT_LIBRARY'))
const library = []
for (const m of libText.split('\n').slice(0, 60).join('\n').matchAll(/\{ slot: '([a-z]+)', label: '([^']+)', group: '([^']+)', alias: \[([^\]]*)\]/g)) {
  library.push({
    slot: m[1], label: m[2], group: m[3],
    alias: [...m[4].matchAll(/'([^']+)'/g)].map((a) => a[1]),
  })
}

/**
 * 建筑槽位不在 OBJECT_LIBRARY 里（那是资源池清单），但它们同样需要核对——
 * 墙、窗、门、屋顶画错了，整张地图的建筑就都是错的。所以一并列进标注器。
 */
const EXTRA_SLOTS = [
  { slot: 'wall', label: '墙体', group: '建筑', alias: [] },
  { slot: 'door', label: '门', group: '建筑', alias: [] },
  { slot: 'window', label: '窗', group: '建筑', alias: [] },
  { slot: 'roofHome', label: '屋顶·住宅', group: '建筑', alias: [] },
  { slot: 'roofWarm', label: '屋顶·社交餐饮', group: '建筑', alias: [] },
  { slot: 'roofCool', label: '屋顶·商业学术', group: '建筑', alias: [] },
  { slot: 'roofGreen', label: '屋顶·公共户外', group: '建筑', alias: [] },
]
const ALL_SLOTS = [...library, ...EXTRA_SLOTS]

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>图集标注器</title>
<style>
  :root{--bg:#12151b;--panel:#1a1f28;--line:#2b3240;--dim:#8b96a9;--fg:#e6ebf3;--gold:#ffc861}
  *{box-sizing:border-box}
  body{font:13px/1.5 system-ui,"PingFang SC",sans-serif;background:var(--bg);color:var(--fg);margin:0;display:flex;height:100vh;overflow:hidden}
  #side{width:300px;flex:0 0 auto;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column}
  #side h2{font-size:13px;margin:0;padding:10px 12px;border-bottom:1px solid var(--line);color:var(--dim);font-weight:500}
  #slots{flex:1;overflow:auto;padding:6px}
  .slot{display:flex;align-items:center;gap:8px;padding:5px 7px;border-radius:5px;cursor:pointer;border:1px solid transparent}
  .slot:hover{background:#232a36}
  .slot.on{border-color:var(--gold);background:#2a2117}
  .slot .nm{flex:1;min-width:0}
  .slot .nm b{font-weight:600}
  .slot .nm div{color:var(--dim);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .cell{display:inline-block;image-rendering:pixelated;background-repeat:no-repeat;border:1px solid #232a36;border-radius:2px;cursor:pointer}
  .cell.on{border-color:var(--gold);box-shadow:0 0 0 1px var(--gold)}
  #main{flex:1;overflow:auto;padding:14px 18px}
  .sheet{margin-bottom:22px}
  .sheet h3{font-size:14px;margin:0 0 6px;color:var(--dim);font-weight:500}
  .grid{display:grid;gap:2px;width:max-content}
  .cellwrap{position:relative}
  .cellwrap .no{position:absolute;left:0;bottom:-2px;font-size:8px;color:#4d586b;font-family:ui-monospace,monospace;pointer-events:none}
  #bar{position:fixed;right:14px;bottom:14px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px 12px;max-width:460px;box-shadow:0 8px 24px rgba(0,0,0,.5)}
  #bar textarea{width:440px;height:96px;background:#0b0e13;color:#cfe3ff;border:1px solid var(--line);border-radius:5px;font:11px/1.4 ui-monospace,monospace;padding:6px}
  button{background:#232a36;color:var(--fg);border:1px solid var(--line);border-radius:5px;padding:3px 9px;cursor:pointer;font-size:12px}
  button:hover{border-color:var(--gold)}
  .hint{color:var(--dim);font-size:11px;margin:4px 0 0}
</style></head><body>
<div id="side">
  <h2>1. 选一个槽位</h2>
  <div id="slots"></div>
</div>
<div id="main">
  <div class="hint">2. 然后在下面点格子——点哪个格子，就把它记到当前槽位名下（一个槽位可以点多个候选）。再点一次取消。</div>
  <div id="sheets"></div>
</div>
<div id="bar">
  <div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
    <button id="clear">全部清空</button>
    <button id="copy">复制结果</button>
    <span class="hint" id="stat"></span>
  </div>
  <textarea id="out" spellcheck="false"></textarea>
</div>
<script>
const SHEETS = ${JSON.stringify(Object.fromEntries(Object.entries(sheets).map(([k, v]) => [k, { cols: v.cols, rows: v.rows }])))}
const LIB = ${JSON.stringify(ALL_SLOTS)}
/** 当前映射：slot -> [[sheet,col,row], ...]。**预填自 mapStyle**，所以打开就能看到
 *  哪些已经确认；要改就在格子上点（点已选中的格子＝取消）。 */
const picked = ${JSON.stringify(confirmed)}
let current = null

const slotsEl = document.getElementById('slots')
const sheetsEl = document.getElementById('sheets')
for (const e of LIB) {
  const d = document.createElement('div')
  d.className = 'slot'
  d.dataset.slot = e.slot
  d.innerHTML = '<span class="nm"><b>' + e.label + '</b> <span style="color:#5a6577">' + e.slot + '</span>'
    + '<div>' + e.alias.join(' / ') + '</div></span><span class="cnt" style="color:#8b96a9">—</span>'
  d.onclick = () => { current = e.slot; refresh() }
  slotsEl.appendChild(d)
}

for (const [name, meta] of Object.entries(SHEETS)) {
  const box = document.createElement('div')
  box.className = 'sheet'
  box.innerHTML = '<h3>' + name + ' — ' + meta.cols + '×' + meta.rows + ' 格</h3>'
  const g = document.createElement('div')
  g.className = 'grid'
  g.style.gridTemplateColumns = 'repeat(' + meta.cols + ', 34px)'
  for (let row = 0; row < meta.rows; row++) {
    for (let col = 0; col < meta.cols; col++) {
      const w = document.createElement('div')
      w.className = 'cellwrap'
      const c = document.createElement('div')
      c.className = 'cell s-' + name
      c.style.width = '32px'
      c.style.height = '32px'
      c.dataset.sheet = name
      c.dataset.col = col
      c.dataset.row = row
      c.style.backgroundSize = (meta.cols * 32) + 'px auto'
      c.style.backgroundPosition = (-col * 32) + 'px ' + (-row * 32) + 'px'
      c.title = name + ' ' + col + ':' + row
      c.onclick = () => toggle(name, col, row)
      w.appendChild(c)
      const no = document.createElement('span')
      no.className = 'no'
      no.textContent = col + ':' + row
      w.appendChild(no)
      g.appendChild(w)
    }
  }
  box.appendChild(g)
  sheetsEl.appendChild(box)
}

function toggle(sheet, col, row) {
  if (current === null) { alert('先在左边选一个槽位'); return }
  const list = picked[current] ?? (picked[current] = [])
  const i = list.findIndex((x) => x[0] === sheet && x[1] === col && x[2] === row)
  if (i >= 0) list.splice(i, 1)
  else list.push([sheet, col, row])
  refresh()
}

function refresh() {
  for (const d of slotsEl.children) d.classList.toggle('on', d.dataset.slot === current)
  for (const d of slotsEl.children) {
    const n = (picked[d.dataset.slot] ?? []).length
    const c = d.querySelector('.cnt')
    c.textContent = n === 0 ? '待确认' : n + ' 格'
    c.style.color = n === 0 ? '#e8b45f' : '#7fc98b'
  }
  const all = new Set()
  for (const list of Object.values(picked)) for (const [s, c, r] of list) all.add(s + ':' + c + ':' + r)
  for (const c of document.querySelectorAll('.cell')) {
    c.classList.toggle('on', all.has(c.dataset.sheet + ':' + c.dataset.col + ':' + c.dataset.row))
  }
  const lines = []
  const missing = []
  for (const e of LIB) {
    const list = picked[e.slot]
    if (list && list.length) lines.push('  ' + e.slot + ': ' + JSON.stringify(list) + ',  // ' + e.label)
    else missing.push(e.label)
  }
  document.getElementById('out').value = '{\n' + lines.join('\n') + '\n}'
  document.getElementById('stat').textContent =
    (current === null ? '未选槽位' : ('当前槽位：' + current)) + (missing.length ? '　|　还缺：' + missing.join('、') : '　|　全部已确认')
}
document.getElementById('clear').onclick = () => { for (const k of Object.keys(picked)) delete picked[k]; refresh() }
document.getElementById('copy').onclick = () => {
  const t = document.getElementById('out')
  t.select(); document.execCommand('copy')
  document.getElementById('stat').textContent = '已复制'
}
refresh()
</script>
<style>
${Object.entries(sheets).map(([k, v]) => `.s-${k}{background-image:url(${v.uri})}`).join('\n')}
</style>
</body></html>
`
writeFileSync(out, html)
const total = Object.values(sheets).reduce((n, s) => n + s.cols * s.rows, 0)
const missing = ALL_SLOTS.filter((e) => (confirmed[e.slot] ?? []).length === 0)
console.log(`已生成 ${out}`)
console.log(`  图集 ${Object.keys(sheets).length} 张，共 ${total} 格；槽位 ${ALL_SLOTS.length} 个`)
console.log(`  已预填 ${ALL_SLOTS.length - missing.length} 个（当前 mapStyle 里的映射）`)
console.log(`  待确认 ${missing.length} 个：${missing.map((e) => e.label).join('、')}`)
