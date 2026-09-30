/**
 * 生成「像素素材风格确认」对比页（自包含 HTML，图集以 base64 内嵌）。
 *
 * 为什么做成自包含单文件：预览要在**离线**也能看。图集外链在 file:// 下会被
 * 浏览器的同源策略挡掉（canvas 也会被污染，导不出 PNG），而走 http 又要求
 * 起一个静态服务。base64 内嵌把这两个问题一起消掉，代价是文件变大几十 KB。
 *
 * 页面上每一格都标出**图集内的列/行索引**——这是本页的核心用途：
 * 让"挑风格"与"定瓦片序号"在同一次确认里完成，避免我凭猜测写序号
 * （猜错的代价是一整张地图画错）。
 *
 * 用法：node scripts/make-style-preview.mjs
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const dir = join(root, 'assets', 'style-preview')

function dataUri(file) {
  const path = join(dir, file)
  if (!existsSync(path)) return null
  return `data:image/png;base64,${readFileSync(path).toString('base64')}`
}

/** 读 PNG 的 IHDR 拿到尺寸（不解码像素，只读头 24 字节）。 */
function pngSize(file) {
  const path = join(dir, file)
  if (!existsSync(path)) return null
  const head = readFileSync(path).subarray(0, 24)
  if (head.subarray(1, 4).toString() !== 'PNG') return null
  return { w: head.readUInt32BE(16), h: head.readUInt32BE(20) }
}

const sheets = [
  { id: 'tiny-town', label: 'Kenney Tiny Town', pack: 'tiny-town-tilemap.png', tile: 16, license: 'CC0 · kenney.nl' },
  { id: 'tiny-farm', label: 'Kenney Tiny Farm', pack: 'tiny-farm-tilemap.png', tile: 16, license: 'CC0 · kenney.nl' },
  { id: 'tiny-battle', label: 'Kenney Tiny Battle', pack: 'tiny-battle-tilemap.png', tile: 16, license: 'CC0 · kenney.nl' },
  { id: 'onebit', label: 'Kenney 1-Bit Pack（彩色）', pack: 'onebit-colored-packed.png', tile: 16, license: 'CC0 · kenney.nl' },
]

const samples = [
  { file: 'tiny-town-sample.png', label: 'Tiny Town 官方示例', note: '镇子 / 道路 / 屋顶 / 树' },
  { file: 'tiny-farm-sample.png', label: 'Tiny Farm 官方示例', note: '田垄 / 栅栏 / 农舍' },
  { file: 'tiny-dungeon-sample.png', label: 'Tiny Dungeon 官方示例', note: '室内 / 地砖' },
  { file: 'onebit-sample-urban-official.png', label: '1-Bit Pack 官方示例（街区）', note: '单色线稿风，另有彩色版' },
  { file: 'onebit-preview-official.png', label: '1-Bit Pack 官方总览', note: '1078 个瓦片的品类' },
]

const embedded = {
  sheets: sheets
    .map((s) => {
      const size = pngSize(s.pack)
      const uri = dataUri(s.pack)
      if (uri === null || size === null) return null
      return { ...s, uri, cols: Math.floor(size.w / s.tile), rows: Math.floor(size.h / s.tile), w: size.w, h: size.h }
    })
    .filter(Boolean),
  samples: samples
    .map((s) => {
      const uri = dataUri(s.file)
      return uri === null ? null : { ...s, uri }
    })
    .filter(Boolean),
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-paranim · 像素素材风格确认</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 28px 60px;
    background: #0d1117; color: #e6ecf5;
    font: 14px/1.65 system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  h1 { font-size: 20px; margin: 0 0 6px; letter-spacing: .3px; }
  h2 { font-size: 15px; margin: 30px 0 8px; padding-bottom: 6px; border-bottom: 1px solid #222b3a; color: #cdd7e6; }
  h3 { font-size: 13.5px; margin: 20px 0 6px; color: #aeb9cc; font-weight: 600; }
  p, li { color: #a7b2c6; margin: 6px 0; }
  code { background: #161c26; border: 1px solid #222b3a; border-radius: 4px; padding: 1px 5px; font-size: 12.5px; color: #ffc861; }
  .note { background: #141b26; border: 1px solid #24304a; border-left: 3px solid #ffc861; border-radius: 6px; padding: 10px 14px; margin: 14px 0; }
  .note b { color: #ffd98a; }
  .tilewrap { overflow: auto; border: 1px solid #222b3a; border-radius: 8px; background: #11161f; padding: 10px; }
  .samples { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px; }
  .sample { border: 1px solid #222b3a; border-radius: 8px; overflow: hidden; background: #11161f; }
  .sample img { display: block; width: 100%; image-rendering: pixelated; }
  .sample div { padding: 7px 10px; }
  .sample b { display: block; color: #dbe4f0; font-size: 13px; }
  .sample span { color: #7d8798; font-size: 12px; }
  table { border-collapse: collapse; margin: 8px 0; font-size: 13px; }
  td, th { border: 1px solid #222b3a; padding: 5px 10px; text-align: left; }
  th { background: #141b26; color: #aeb9cc; font-weight: 600; }
  .swatch { display: inline-block; width: 13px; height: 13px; border-radius: 3px; vertical-align: -2px; margin-right: 6px; border: 1px solid #0006; }
</style>
</head>
<body>
<h1>dsh-paranim · 像素素材风格确认</h1>
<p>下面全部是 <b>Kenney</b> 的官方图集，许可均为 <code>CC0 1.0</code>（可商用、无需署名、无传染性），瓦片尺寸 <code>16×16</code>，与本项目 <code>TILE_PX = 16</code> 直接对齐。</p>

<div class="note">
  <b>为什么给你看这些而不是直接套上：</b>我需要你在两件事上确认——
  ① <b>整体风格</b>（选哪一套／几套组合）；② <b>瓦片序号</b>（每个格子标了列:行，我按你认可的格子去写地图）。
  我此前那版是程序化画的，你说丑，我认；这次换成现成图集，但序号我不猜——猜错就是一整张地图画错。
</div>

<h2>一、官方示例（这套图集实际拼出来的样子）</h2>
<div class="samples" id="samples"></div>

<h2>二、两套候选风格的完整图集（放大 3 倍，带列:行索引）</h2>
<p>鼠标悬停在任意格子上会显示它的 <code>列:行</code>。请告诉我：<b>地面</b>用哪几个、<b>屋顶/墙体</b>用哪几个、<b>道路</b>用哪几个、<b>树/水/栅栏/物件</b>用哪几个。</p>
<div id="sheets"></div>

<h2>三、我需要你回答的两个问题</h2>
<table>
  <tr><th>问题</th><th>可选项</th><th>我的建议</th></tr>
  <tr>
    <td>整体风格选哪套？</td>
    <td>① Tiny Town 单用<br>② Tiny Town + Tiny Farm（镇 + 田）<br>③ 1-Bit Pack（单色线稿，最冷峻）<br>④ 1-Bit 彩色版</td>
    <td>② —— Tiny 系列同出一门、色板一致，镇里带田最像 Smallville；1-Bit 风格统一但偏"工整冷淡"，少了生活气。</td>
  </tr>
  <tr>
    <td>角色怎么办？</td>
    <td>① 我程序化画的小人（可与图集调色对齐）<br>② 找 CC0 角色图集再叠一层风格风险<br>③ 先不做行走图，用图集里的物件当占位</td>
    <td>① —— Tiny 系列不含角色；我的行走图可以与图集共用同一套色，风格能压住。</td>
  </tr>
</table>
<p>回复形式随意，例如：<code>选②，地面 0:0 / 0:1，屋顶 5:0…</code>，或者直接说"按你建议的先做一版我看看"也行。</p>

<script>
const SHEETS = ${JSON.stringify(embedded.sheets)};
const SAMPLES = ${JSON.stringify(embedded.samples)};

const samplesEl = document.getElementById('samples');
for (const s of SAMPLES) {
  const box = document.createElement('div');
  box.className = 'sample';
  const img = document.createElement('img');
  img.src = s.uri; img.alt = s.label;
  const cap = document.createElement('div');
  const b = document.createElement('b'); b.textContent = s.label;
  const sp = document.createElement('span'); sp.textContent = s.note;
  cap.append(b, sp);
  box.append(img, cap);
  samplesEl.append(box);
}

const SCALE = 3;
for (const sheet of SHEETS) {
  const h3 = document.createElement('h3');
  h3.textContent = sheet.label + ' — ' + sheet.cols + '×' + sheet.rows + ' 格 · ' + sheet.license;
  document.getElementById('sheets').append(h3);

  const wrap = document.createElement('div');
  wrap.className = 'tilewrap';
  const canvas = document.createElement('canvas');
  canvas.width = sheet.cols * sheet.tile * SCALE;
  canvas.height = sheet.rows * sheet.tile * SCALE;
  canvas.style.imageRendering = 'pixelated';
  wrap.append(canvas);

  const img = new Image();
  img.onload = () => {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    // 棋盘底：让透明瓦片看得见边界
    for (let y = 0; y < sheet.rows; y++) {
      for (let x = 0; x < sheet.cols; x++) {
        ctx.fillStyle = (x + y) % 2 ? '#1a212c' : '#151b25';
        ctx.fillRect(x * sheet.tile * SCALE, y * sheet.tile * SCALE, sheet.tile * SCALE, sheet.tile * SCALE);
      }
    }
    for (let y = 0; y < sheet.rows; y++) {
      for (let x = 0; x < sheet.cols; x++) {
        ctx.drawImage(img, x * sheet.tile, y * sheet.tile, sheet.tile, sheet.tile,
          x * sheet.tile * SCALE, y * sheet.tile * SCALE, sheet.tile * SCALE, sheet.tile * SCALE);
      }
    }
    // 网格与索引：每 16 格标一次列行号，避免字压满整屏
    ctx.strokeStyle = 'rgba(255,255,255,.08)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= sheet.cols; x++) {
      ctx.beginPath(); ctx.moveTo(x * sheet.tile * SCALE + .5, 0); ctx.lineTo(x * sheet.tile * SCALE + .5, canvas.height); ctx.stroke();
    }
    for (let y = 0; y <= sheet.rows; y++) {
      ctx.beginPath(); ctx.moveTo(0, y * sheet.tile * SCALE + .5); ctx.lineTo(canvas.width, y * sheet.tile * SCALE + .5); ctx.stroke();
    }
    ctx.font = '10px ui-monospace, monospace';
    ctx.fillStyle = 'rgba(255,200,97,.85)';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let x = 0; x < sheet.cols; x++) ctx.fillText(String(x), x * sheet.tile * SCALE + 2, 2);
    for (let y = 0; y < sheet.rows; y++) ctx.fillText(String(y), 2, y * sheet.tile * SCALE + 2);
  };
  img.src = sheet.uri;

  canvas.addEventListener('mousemove', (e) => {
    const r = canvas.getBoundingClientRect();
    const col = Math.floor((e.clientX - r.left) / (sheet.tile * SCALE));
    const row = Math.floor((e.clientY - r.top) / (sheet.tile * SCALE));
    canvas.title = col + ':' + row;
  });

  wrap.append(canvas);
  document.getElementById('sheets').append(wrap);
}
</script>
</body>
</html>
`

const out = join(root, 'assets', 'style-preview', 'index.html')
writeFileSync(out, html, 'utf8')
console.log(`生成 ${out}（内嵌 ${embedded.sheets.length} 张图集、${embedded.samples.length} 张示例）`)
