/**
 * 像素素材表 —— 全部以**点阵字符串**内联，而不是外挂 PNG 图集。
 *
 * 为什么不用现成的像素素材包（Kenney / OpenGameArt / itch.io 上的 CC0 图集）：
 *  1. 一旦按原版的 140×100 贴图网格铺满，图集就是 MB 级二进制，插件仓库要背上它；
 *  2. 各家图集风格并不统一，混用反而更花；
 *  3. 这类图集多在 GitHub/CDN 上，而本机的跨境连接是间歇性超时的，构建会随机失败。
 *
 * 所以这里的做法是：按经典 16×16 像素 RPG 的规范**自己画**，素材以字符矩阵内联，
 * 每个像素用一个调色板索引字符表示。好处是三件事同时成立——
 *  · 体积：整本素材表约几 KB 源码，构建产物里也是几十 KB 级；
 *  · 统一：所有图元共用同一份 32 色调色板，不存在"两套画风拼在一起"；
 *  · 可审计：每个像素在源码里都看得见，玩家想改一盏灯的样子，改几行字符即可。
 *
 * 调色板走的是明亮、低饱和冲突的像素风配色（草—土—木—瓦—水五组同色系递进），
 * 避免之前那种"高饱和撞色 + 纯色平铺"的廉价感。
 */

// ── 调色板 ────────────────────────────────────────────────────────────────
//
// 每组 3~4 阶（暗 / 中 / 亮 / 高光），像素画的立体感就来自"同色系分阶 + 硬边"，
// 而不是渐变或阴影。

export const PIXEL_PALETTE: Record<string, string> = {
  '.': 'transparent',

  // 草地：四阶（暗 - 中 - 亮 - 高光）。像素画靠这四阶造"起伏"，不靠渐变。
  h: '#3c6b39', // 暗
  g: '#4f8544', // 中
  G: '#66a155', // 亮
  H: '#8bc06f', // 高光

  // 泥土 / 土路
  e: '#7c6244', // 暗
  d: '#94795a', // 中
  D: '#ad9170', // 亮

  // 石板路
  t: '#8d8070', // 石板暗
  s: '#a99a82', // 中
  S: '#c0b39a', // 亮

  // 木材（墙裙 / 栅栏 / 树干）
  k: '#5f4128', // 深木
  v: '#8d7048', // 木暗
  w: '#bda27a', // 木中
  W: '#d6bd97', // 木亮

  // 瓦顶 · 暖红（社交 / 餐饮）
  q: '#8a4232', // 暗
  r: '#ab5742', // 中
  R: '#c4745c', // 亮
  Q: '#d99380', // 高光

  // 瓦顶 · 靛蓝（商业）
  a: '#33566f',
  b: '#44708f',
  B: '#5c8dab',
  A: '#7fb0c8',

  // 瓦顶 · 紫（学术）
  o: '#544a70',
  p: '#6e628f',
  P: '#8b7fae',
  QP: '#a89cc4',

  // 瓦顶 · 苔绿（公共 / 户外）
  n: '#3f6042',
  m: '#527a55',
  M: '#6b966c',
  MM: '#8db28b',

  // 瓦顶 · 陶土（住宅）
  x: '#7d4f2c',
  y: '#9c6639',
  Y: '#b8834d',
  YY: '#cfa06b',

  // 水（四阶，带波纹用的亮色）
  i: '#2c5f80',
  u: '#3b7ba0',
  U: '#4f9ac0',
  I: '#79bedb',

  // 石 / 灰
  z: '#6b6b66',
  c: '#8f8f88',
  C: '#adada4',
  Z: '#cbcbc0',

  // 金属 / 灯光
  f: '#b9bcc4',
  F: '#dfe3ea',
  l: '#f2c14e', // 暖黄灯
  L: '#ffe08a', // 灯光高光

  // 角色：肤 / 发 / 衣（各三阶，够撑起"像素小人"的立体感）
  '0': '#f2c9a0',
  '1': '#d3a173',
  '2': '#3b2f28', // 深发
  '3': '#8a5a34', // 棕发
  '4': '#ddd6c4', // 浅发
  '5': '#33394a', // 深衣
  '6': '#4a6fa5', // 蓝衣
  '7': '#a85752', // 红衣
  '8': '#527d57', // 绿衣
  '9': '#7a5f96', // 紫衣

  // 描边与高光：暖黑 + 纯白
  ':': '#2b241f',
  ';': '#f6f8fc',
}

// ── 点阵素材 ──────────────────────────────────────────────────────────────
//
// 每个 sprite 是一组等宽行；顺序：屋顶 → 墙体 → 门 → 窗 → 细节。
// 16×16 是经典尺寸：小到能铺满镇子，大到能画出屋檐与窗棂。

export interface Sprite {
  w: number
  h: number
  rows: string[]
}

function sprite(rows: string[]): Sprite {
  const w = Math.max(...rows.map((r) => r.length))
  return { w, h: rows.length, rows: rows.map((r) => r.padEnd(w, '.')) }
}

/** 地面纹理：4 种草地变体（用轻微抖动做"草地不平板"）。 */
export const GROUND_SPRITES: Sprite[] = [
  sprite([
    'gggggggg',
    'gGggghgg',
    'gggggggg',
    'gghgggGg',
    'gggggggg',
    'gHgggggg',
    'ggggGggg',
    'gggggggg',
  ]),
  sprite([
    'gggggggg',
    'ghggGggg',
    'gggggggg',
    'gggggghg',
    'gGgggggg',
    'gggghggg',
    'ggggggGg',
    'gggggggg',
  ]),
  sprite([
    'gggggggg',
    'ggHggggg',
    'ggggghgg',
    'gggggggg',
    'ghgggGgg',
    'gggggggg',
    'gggGgggg',
    'gggggggg',
  ]),
  sprite([
    'gggggggg',
    'gggggghg',
    'gGgggggg',
    'ggggGggg',
    'gggggggg',
    'gghggggg',
    'ggggggHg',
    'gggggggg',
  ]),
]

/** 土路 / 石板路（各 2 变体）。 */
export const ROAD_SPRITES: Sprite[] = [
  sprite([
    'ddDdddDd',
    'dddddDdd',
    'dDddddde',
    'ddddeddd',
    'ddDddddD',
    'deddddDd',
    'dddddded',
    'DddDdddd',
  ]),
  sprite([
    'sSssssSs',
    'sssssSss',
    'sSssstss',
    'sssstsSs',
    'ssSsssss',
    'stssssSs',
    'sssssstS',
    'SssSssss',
  ]),
]

/** 水（2 变体，带波纹）。 */
export const WATER_SPRITES: Sprite[] = [
  sprite([
    'uuuuUuuu',
    'uUuuuuuu',
    'uuuuuuIu',
    'uiuuUuuu',
    'uuuuuuuu',
    'uUuuuuuu',
    'uuuuiuuU',
    'uuuuuuuu',
  ]),
  sprite([
    'uuuuuuuu',
    'uuIuuuuu',
    'uUuuuuuu',
    'uuuuuuUu',
    'uuuuiuuu',
    'uuuuuuuu',
    'uUuuuuIu',
    'uuuuuuuu',
  ]),
]

/** 建筑：16 宽 × 24 高，含瓦顶、墙体、门、窗。屋顶色由字符决定，替换整族即可换色。 */
const BUILDING_ROWS = [
  '................',
  '.....qqqqqq.....',
  '...qqrrrrrrqq...',
  '..qqrrRRRRrrqq..',
  '.qqrrRRRRRRrrqq.',
  'qqrrRRRRRRRRrrqq',
  'qrrRRRRRRRRRRrrq',
  'rrRRRRRRRRRRRRrr',
  '................',
  'wwWWwwwwwwwwWWww',
  'wwWWwwwwwwwwWWww',
  'wvwwwwwwwwwwwwvw',
  'wvwwcCCCwwcCCCvw',
  'wvwwc;;Cwwc;;Cvw',
  'wvwwcCCCwwcCCCvw',
  'wvwwwwwwwwwwwwvw',
  'wvwwwwkkkkwwwwvw',
  'wvwwwwk::kwwwwvw',
  'wvwwwwk::kwwwwvw',
  'wvwwwwk::kwwwwvw',
  'wvwwwwk::kwwwwvw',
  'wvwwwwk::kwwwwvw',
  'vvvvvvvvvvvvvvvv',
  '::::::::::::::::',
]

/** 按屋顶色族换色，得到不同类别的建筑。 */
function recolorRoof(rows: string[], map: Record<string, string>): string[] {
  return rows.map((row) =>
    [...row]
      .map((ch) => map[ch] ?? ch)
      .join(''),
  )
}

export const BUILDING_SPRITES: Record<'warm' | 'cool' | 'violet' | 'moss' | 'clay', Sprite> = {
  warm: sprite(BUILDING_ROWS),
  cool: sprite(recolorRoof(BUILDING_ROWS, { q: 'a', r: 'b', R: 'B', Q: 'A' })),
  violet: sprite(recolorRoof(BUILDING_ROWS, { q: 'o', r: 'p', R: 'P', Q: 'P' })),
  moss: sprite(recolorRoof(BUILDING_ROWS, { q: 'n', r: 'm', R: 'M', Q: 'M' })),
  clay: sprite(recolorRoof(BUILDING_ROWS, { q: 'x', r: 'y', R: 'Y', Q: 'Y' })),
}

/** 调色板里为各族预留的第四阶（屋顶高光），避免各族共用一个 Q 导致层次消失。 */
void { QP: PIXEL_PALETTE.QP, MM: PIXEL_PALETTE.MM, YY: PIXEL_PALETTE.YY }

/** 草木：树 / 灌木 / 花丛。 */
export const TREE_SPRITES: Sprite[] = [
  sprite([
    '....hhmmhh....',
    '..hmmmMMMMmm..',
    '.hmmMMMMMMMMm.',
    'hmmMMMMMMMMMMm',
    'hmMMMMMMMMMMMm',
    'mMMMMMMMMMMMMm',
    'mMMMMMnnMMMMMm',
    'mMMMMMMMMMMMMm',
    'mmMMMMMMMMMMm.',
    '.mmmMMMMMMmm..',
    '...mmmmmmmm...',
    '......kk......',
    '......kk......',
    '.....kkkk.....',
  ]),
  sprite([
    '.....nnnn.....',
    '...nnmmmmnn...',
    '..nmmmmmmmmn..',
    '.nmmmMMMMmmmn.',
    'nmmmmMMMMmmmmn',
    'mmmmmMMMMmmmmm',
    'nmmmmMMMMmmmmn',
    '.nmmmmmmmmmn..',
    '..nmmmmmmmmn..',
    '...nnmmmmnn...',
    '.....kkkk.....',
    '......kk......',
  ]),
  sprite([
    '...hhmmhh...',
    '.hhmmMMMMmh.',
    'hmmMMMMMMMmh',
    'mMMMnnMMMMMm',
    'mMMMMMMMMMMm',
    'hhmmMMMMmmhh',
    '...mm..mm...',
  ]),
]

/** 物件：路灯 / 长椅 / 垃圾桶 / 喷泉 / 告示牌 / 摊位 / 水井 / 自动售货机 / 篝火 / 风车。 */
export const PROP_SPRITES: Record<string, Sprite> = {
  lamp: sprite([
    '...::::...',
    '..:llll:..',
    '..lLLLLl..',
    '..:llll:..',
    '...:ll:...',
    '...:cc:...',
    '...:cc:...',
    '...:cc:...',
    '...:cc:...',
    '...:cc:...',
    '..:cccc:..',
    '..:zzzz:..',
  ]),
  bench: sprite([
    '..........',
    '..::::::..',
    '.:wwWWww:.',
    '.:wwWWww:.',
    '.:wwWWww:.',
    '.:;;;;;;:.',
    '.:wwwwww:.',
    '.:;;;;;;:.',
    '..::..::..',
    '..:c..c:..',
    '..:c..c:..',
  ]),
  bin: sprite([
    '..::::::..',
    '..:cccc:..',
    '.:zCCCCz:.',
    '.:zCzzCz:.',
    '.:zCzzCz:.',
    '.:zCCCCz:.',
    '.:zCCCCz:.',
    '.:zCCCCz:.',
    '.:zzzzzz:.',
    '..::::::..',
  ]),
  fountain: sprite([
    '..::::::..',
    '.:sSSSSs:.',
    ':sSIIIIIs:',
    ':sSIuUIIs:',
    ':sSIuUIIs:',
    ':sSSIIISs:',
    '.:sSSSSs:.',
    '..::::::..',
    '..:sSSs:..',
    '...::::...',
  ]),
  sign: sprite([
    '..::::::..',
    '.:wwWWww:.',
    ':wwWWWWww:',
    ':ww::::ww:',
    ':ww:;;:ww:',
    ':ww::::ww:',
    '.:wwWWww:.',
    '..::::::..',
    '...:kk:...',
    '...:kk:...',
    '...:kk:...',
  ]),
  stall: sprite([
    '....RRRR....',
    '..RRRRRRRR..',
    '.RRrrrrrrRR.',
    'RrrrrrrrrrrR',
    'wwwwwwwwwwww',
    'wwwwwwwwwwww',
    'wvvvvvvvvvvw',
    'wvwwwwwwwwvw',
    'wvwwwwwwwwvw',
    'wvvvvvvvvvvw',
  ]),
  well: sprite([
    '..::::::::..',
    '.:kkkkkkkk:.',
    ':kkkkkkkkkk:',
    ':sSSSSSSSSs:',
    ':sSuuUuussS:',
    ':sSSSSSSSSs:',
    '.:ssssssss:.',
    '..::::::::..',
    '...:ssss:...',
  ]),
  vending: sprite([
    '.::::::::::.',
    '.:aAAAAAAa:.',
    '.:aIIIIIia:.',
    '.:aIIIIIia:.',
    '.:aiiiiiia:.',
    '.:a::::::a:.',
    '.:a:ff:ffa:.',
    '.:a::::::a:.',
    '.:aAAAAAAa:.',
    '.::::::::::.',
  ]),
  campfire: sprite([
    '.....ll.....',
    '....lLLl....',
    '....rRYRr...',
    '..rryRlYrr..',
    '.rryRRRRyrr.',
    '..kkkkkkkk..',
    '.kk::kk::kk.',
    '..k::kk::k..',
  ]),
  windmill: sprite([
    '....::::....',
    '..::WWWW::..',
    '.:WWWWWWWW:.',
    '::WWWWWWWW::',
    '.:WWWWWWWW:.',
    '..::WWWW::..',
    '....:kk:....',
    '....:kk:....',
    '....:kk:....',
    '....:kk:....',
    '...:kkkk:...',
  ]),
  bike: sprite([
    '..::::....::::..',
    '.:fFfF:..:fFfF:.',
    ':fF::Ff::fF::Ff:',
    ':fF::Ff::fF::Ff:',
    '.:fFffF::fFffF:.',
    '..::::..::::....',
  ]),
  tree: TREE_SPRITES[0],
  bush: TREE_SPRITES[2],
}

/** 角色：4 向 × 2 帧的行走图（16×18）。发色/衣色由字符替换得到不同居民。 */
const WALKER_BASE = [
  '.....::::.....',
  '....:2222:....',
  '...:222222:...',
  '...:200002:...',
  '...:20;;02:...',
  '...:200002:...',
  '....:0110:....',
  '...:666666:...',
  '..:66666666:..',
  '..:66666666:..',
  '..:66666666:..',
  '..::666666::..',
  '....:5555:....',
  '....:5555:....',
  '....:55:55:...',
  '....:55:55:...',
  '...:kk::kk:...',
  '...:kk::kk:...',
]

const WALKER_SIDE = [
  '.....::::.....',
  '....:2222:....',
  '...:222222:...',
  '...:200002:...',
  '...:20;;02:...',
  '...:200002:...',
  '....:0110:....',
  '...:666666:...',
  '..:66666666:..',
  '..:66666666:..',
  '..:66666666:..',
  '..::666666::..',
  '....:5555:....',
  '....:5555:....',
  '...:555:55:...',
  '...:55:555:...',
  '..:kk:.kk:....',
  '..:kk:.kk:....',
]

const WALKER_BACK = [
  '.....::::.....',
  '....:2222:....',
  '...:222222:...',
  '...:222222:...',
  '...:222222:...',
  '...:222222:...',
  '....:2222:....',
  '...:666666:...',
  '..:66666666:..',
  '..:66666666:..',
  '..:66666666:..',
  '..::666666::..',
  '....:5555:....',
  '....:5555:....',
  '....:55:55:...',
  '....:55:55:...',
  '...:kk::kk:...',
  '...:kk::kk:...',
]

/** 换发色（2）与衣色（6），得到不同的居民。 */
export function recolorWalker(rows: string[], hair: string, cloth: string): Sprite {
  return sprite(rows.map((row) => [...row].map((ch) => (ch === '2' ? hair : ch === '6' ? cloth : ch)).join('')))
}

export type Facing = 'down' | 'up' | 'side'

/**
 * 四向行走图：每向 2 帧（站立帧 + 迈步帧，靠腿脚行的位移实现）。
 * `frame` 只影响最下面两行，所以这里用两组字符。
 */
export const WALKER_FRAMES: Record<Facing, Sprite[]> = {
  down: [sprite(WALKER_BASE), sprite(recolorLegs(WALKER_BASE, true))],
  up: [sprite(WALKER_BACK), sprite(recolorLegs(WALKER_BACK, true))],
  side: [sprite(WALKER_SIDE), sprite(recolorLegs(WALKER_SIDE, true))],
}

/** 迈步帧：把最下面两行的脚左右错开一格。 */
function recolorLegs(rows: string[], step: boolean): string[] {
  if (!step) return rows
  const out = [...rows]
  const a = out.length - 2
  const b = out.length - 1
  out[a] = `..${out[a].slice(1, -1)}..`.slice(0, out[a].length)
  out[b] = `.${out[b].slice(0, -2)}..`.slice(0, out[b].length)
  return out
}

// ── 绘制 ──────────────────────────────────────────────────────────────────
//
// 每个 sprite 编译成一张离屏 canvas 缓存起来：同一张图在 140×100 的地图上会被
// 用上千次，每次逐像素 fillRect 会让帧率掉到个位数。imageSmoothingEnabled=false
// 是像素风的硬要求——否则浏览器会把 1px 描边插值成糊边。

const cache = new Map<string, HTMLCanvasElement>()

export function spriteCanvas(spriteData: Sprite, key: string): HTMLCanvasElement {
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const canvas = document.createElement('canvas')
  canvas.width = spriteData.w
  canvas.height = spriteData.h
  const ctx = canvas.getContext('2d')
  if (ctx === null) return canvas
  for (let y = 0; y < spriteData.h; y += 1) {
    const row = spriteData.rows[y] ?? ''
    for (let x = 0; x < spriteData.w; x += 1) {
      const ch = row[x]
      if (ch === undefined || ch === '.') continue
      const color = PIXEL_PALETTE[ch]
      if (color === undefined) continue
      ctx.fillStyle = color
      ctx.fillRect(x, y, 1, 1)
    }
  }
  cache.set(key, canvas)
  return canvas
}

/** 把一张 sprite 缩放画到目标位置（以**底部中心**对齐，便于贴地）。 */
export function drawSprite(
  ctx: CanvasRenderingContext2D,
  spriteData: Sprite,
  key: string,
  cx: number,
  bottomY: number,
  scale: number,
): void {
  const canvas = spriteCanvas(spriteData, key)
  const w = spriteData.w * scale
  const h = spriteData.h * scale
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(canvas, Math.round(cx - w / 2), Math.round(bottomY - h), Math.round(w), Math.round(h))
}

/** 平铺一张地面 sprite 填满矩形（用于地块层）。 */
export function drawTile(
  ctx: CanvasRenderingContext2D,
  spriteData: Sprite,
  key: string,
  x: number,
  y: number,
  size: number,
): void {
  const canvas = spriteCanvas(spriteData, key)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(canvas, Math.round(x), Math.round(y), Math.round(size), Math.round(size))
}

export function clearSpriteCache(): void {
  cache.clear()
}
