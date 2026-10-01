/**
 * 布局层单测（`npm test` 会跑，不需要浏览器）。
 *
 * 这里钉死的是「涂抹笔刷改了地图，画面上却什么都没变」这一类 bug。
 * 它的成因不在笔刷本身，而在**布局缓存没有失效**：指纹里只放了
 * `tiles.length`，而涂抹一行里的格子并不改变行数——于是同一份缓存被反复命中。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLayout, layoutKey } from './layout.ts'
import type { Sandbox } from '../shared/model.ts'

function mkSandbox(tiles: string[], width = 6, height = 4): Sandbox {
  return {
    v: 1,
    id: 'probe',
    name: '探针',
    desc: '',
    createdAt: 0,
    updatedAt: 0,
    map: { width, height, ground: '#000', tiles },
    places: [],
    objects: [],
    relations: [],
    agents: [],
  }
}

test('涂抹同一行不改变行数，但指纹必须变（否则缓存不失效、画面不动）', () => {
  const rows = ['gggggg', 'gggggg', 'gggggg', 'gggggg']
  const before = layoutKey(mkSandbox(rows))
  // 只改第一行里的一个格子：行数与每行长度都不变
  const after = layoutKey(mkSandbox(['gogggg', 'gggggg', 'gggggg', 'gggggg']))
  assert.notEqual(after, before, '同一行内改一格也必须让指纹变化')
})

test('指纹对"只换行内位置"敏感（长度相同、内容不同）', () => {
  const a = layoutKey(mkSandbox(['gooooo', 'gggggg', 'gggggg', 'gggggg']))
  const b = layoutKey(mkSandbox(['ooooog', 'gggggg', 'gggggg', 'gggggg']))
  assert.notEqual(a, b, '同样的字符、不同的位置也必须区分开')
})

test('相同内容得到相同指纹（缓存该命中时仍然命中）', () => {
  const rows = ['ggrggg', 'pppppp', 'gggggg', 'gggggg']
  assert.equal(layoutKey(mkSandbox(rows)), layoutKey(mkSandbox(rows)))
})

test('八种笔刷字符都能落到对应的材质（涂下去必须有东西出现）', () => {
  const cases: Array<[string, string]> = [
    ['g', 'grass'],
    ['r', 'dirt'],
    ['p', 'stone'],
    ['z', 'concrete'],
    ['s', 'sand'],
    ['w', 'water'],
    ['f', 'field'],
    ['o', 'wood'],
  ]
  for (const [ch, expected] of cases) {
    const layout = buildLayout(mkSandbox([ch.repeat(6), 'gggggg', 'gggggg', 'gggggg']))
    assert.equal(layout.terrain[0][0], expected, `字符 '${ch}' 应渲染为 ${expected}`)
  }
})

test('grass 有变体，但两种都属于草地（不会画成别的材质）', () => {
  const layout = buildLayout(mkSandbox(['gggggg', 'gggggg', 'gggggg', 'gggggg']))
  const kinds = new Set(layout.terrain.flat())
  for (const k of kinds) assert.ok(k === 'grass' || k === 'grassAlt', `草地上出现了 ${k}`)
})

// ── 推导层不许盖掉玩家显式写下的东西 ──────────────────────────────────────
//
// 这一条对应的真实故障：house 沙盒有 20×17 的室内区域，室内地板与房间之间的
// 走廊都是**推导**出来的，而它们原来会无条件覆盖字符画。于是玩家在室内刷任何
// 材质都会被铺回石地板，屏幕上毫无反应——看上去就是"笔刷坏了"。

function mkIndoor(): Sandbox {
  const sb = mkSandbox(['g'.repeat(20), 'g'.repeat(20), 'g'.repeat(20), 'g'.repeat(20)], 20, 4)
  sb.map.interior = { x: 2, y: 1, w: 14, h: 3 }
  return sb
}

test('室内地板：没涂过的格子自动铺石地板（保持原有外观）', () => {
  const layout = buildLayout(mkIndoor())
  assert.equal(layout.terrain[2][5], 'stone', '室内默认应是石地板')
})

test('室内地板：玩家涂过的格子必须保留（不能被推导覆盖）', () => {
  const sb = mkIndoor()
  const row = sb.map.layers?.background?.[2] ?? sb.map.tiles![2]
  const painted = row.slice(0, 5) + 'o' + row.slice(6)
  sb.map.tiles![2] = painted
  if (sb.map.layers) sb.map.layers.background[2] = painted
  const layout = buildLayout(sb)
  assert.equal(layout.terrain[2][5], 'wood', '涂了木地板就该是木地板，哪怕它在室内区域里')
  assert.equal(layout.terrain[2][6], 'stone', '同一行没涂的格子仍铺石地板')
})

test('路网：不会盖掉玩家涂过的格子', () => {
  const sb = mkSandbox(['g'.repeat(24), 'g'.repeat(24), 'g'.repeat(24)], 24, 3)
  // 放两处地标让它们之间生成一条路
  sb.places = [
    { id: 'a', name: '甲', kind: 'place', x: 3, y: 1, w: 4, h: 2, interactive: true, state: {} },
    { id: 'b', name: '乙', kind: 'place', x: 19, y: 1, w: 4, h: 2, interactive: true, state: {} },
  ]
  // 把中间一整行涂成水泥，路本会从这里穿过
  const painted = 'z'.repeat(24)
  sb.map.tiles![1] = painted
  if (sb.map.layers) sb.map.layers.background[1] = painted
  const layout = buildLayout(sb)
  const kept = layout.terrain[1].filter((t) => t === 'concrete').length
  assert.ok(kept >= 8, `玩家涂的水泥应大范围保留，实际只剩 ${kept} 格`)
})
