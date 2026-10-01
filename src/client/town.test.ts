/**
 * 渲染层里可脱离浏览器验证的那部分（`npm test` 会跑）。
 *
 * 只测纯函数：画布本身测不了，但"该画哪些层、各多少透明度"这个决定
 * 是纯的，而它错了在画面上不一定看得出来（少画一层就是少一层，不报错）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellAtPoint, layerDrawPlan } from './town.ts'

test('运行时：三层都画，全不透明', () => {
  const plan = layerDrawPlan(undefined)
  assert.deepEqual(plan.map((p) => p.layer), ['background', 'structure', 'object'])
  assert.ok(plan.every((p) => p.alpha === 1))
})

test('编辑 background：只有它自己（底下没东西可参照）', () => {
  const plan = layerDrawPlan('background')
  assert.deepEqual(plan, [{ layer: 'background', alpha: 1 }])
})

test('编辑 structure：background 淡显当参照，structure 不透明', () => {
  const plan = layerDrawPlan('structure')
  assert.deepEqual(plan, [
    { layer: 'background', alpha: 0.3 },
    { layer: 'structure', alpha: 1 },
  ])
})

test('编辑 object：下面两层都淡显，object 不透明', () => {
  const plan = layerDrawPlan('object')
  assert.deepEqual(plan, [
    { layer: 'background', alpha: 0.3 },
    { layer: 'structure', alpha: 0.3 },
    { layer: 'object', alpha: 1 },
  ])
})

test('上层永不被画：它会盖住正在编辑的那一层', () => {
  for (const only of ['background', 'structure', 'object'] as const) {
    const layers = layerDrawPlan(only).map((p) => p.layer)
    const editing = layers.indexOf(only)
    assert.equal(editing, layers.length - 1, `${only} 必须是最后画的那一层`)
  }
})

// ── 落点吸附整格 ──────────────────────────────────────────────────────────
//
// 拖拽智能体时，落点就是"鼠标压在哪一格"。用 round 的话，点在格子偏左/偏上
// 的那半边会跳到相邻格——看上去就是"吸附不准"。

test('落点取鼠标真正压住的那一格（不是最近的中心）', () => {
  const view = { scale: 1, offsetX: 0, offsetY: 0 }
  const T = 16
  // 第 (3,2) 格覆盖像素 [48,64) × [32,48)
  assert.deepEqual(cellAtPoint(3 * T, 2 * T, view), { x: 3, y: 2 }, '左上角')
  assert.deepEqual(cellAtPoint(3 * T + 1, 2 * T + 1, view), { x: 3, y: 2 }, '刚进去一点也还是它')
  assert.deepEqual(cellAtPoint(4 * T - 1, 3 * T - 1, view), { x: 3, y: 2 }, '右下角（差 1px）')
  assert.deepEqual(cellAtPoint(4 * T, 3 * T, view), { x: 4, y: 3 }, '跨过边界才是下一格')
})

test('缩放与平移之后仍然吸得准', () => {
  const view = { scale: 2, offsetX: 100, offsetY: 50 }
  const T = 16 * 2
  assert.deepEqual(cellAtPoint(100 + 5 * T + 3, 50 + 1 * T + 3, view), { x: 5, y: 1 })
})
