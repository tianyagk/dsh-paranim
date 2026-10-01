/**
 * 渲染层里可脱离浏览器验证的那部分（`npm test` 会跑）。
 *
 * 只测纯函数：画布本身测不了，但"该画哪些层、各多少透明度"这个决定
 * 是纯的，而它错了在画面上不一定看得出来（少画一层就是少一层，不报错）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { layerDrawPlan } from './town.ts'

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
