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
