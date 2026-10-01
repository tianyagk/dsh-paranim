/**
 * 渲染层里可脱离浏览器验证的那部分（`npm test` 会跑）。
 *
 * 只测纯函数：画布本身测不了，但"该画哪些层、各多少透明度"这个决定
 * 是纯的，而它错了在画面上不一定看得出来（少画一层就是少一层，不报错）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cellAtPoint, fitView, layerDrawPlan, screenToWorld, worldToScreen, zoomAroundPoint } from './town.ts'

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

// ── 滚轮缩放的中心 ────────────────────────────────────────────────────────
//
// 不变式：**缩放前鼠标指着的世界坐标，缩放后必须仍在鼠标下**。
// 这条比"公式长什么样"重要——只改 scale 不动 pan 的话，缩放会围绕容器中心
// 发生（鼠标指的地方跑掉）；连 base 都不减的话，就变成围绕左上角缩放
// （用户反馈的现象）。

test('以鼠标为中心缩放：指着的那个点不会跑', () => {
  const mapPx = { w: 128, h: 96 }   // 8×6 格 × 16px
  const size = { w: 400, h: 300 }
  for (const [px, py] of [[137, 88], [10, 10], [399, 299], [200, 150]] as const) {
    for (const factor of [1.15, 1 / 1.15]) {
      const base0 = fitView(mapPx, size, 1)
      const view0 = { scale: base0.scale, offsetX: base0.offsetX, offsetY: base0.offsetY }
      const world = screenToWorld(px, py, view0)
      const next = zoomAroundPoint({ px, py, worldX: world.x, worldY: world.y, mapPx, size, zoom: 1, factor })
      const base1 = fitView(mapPx, size, next.zoom)
      const view1 = { scale: base1.scale, offsetX: base1.offsetX + next.pan.x, offsetY: base1.offsetY + next.pan.y }
      const after = worldToScreen(world.x, world.y, view1)
      assert.ok(Math.abs(after.px - px) < 1e-6, `(${px},${py}) factor=${factor}：x 漂了 ${after.px - px}`)
      assert.ok(Math.abs(after.py - py) < 1e-6, `(${px},${py}) factor=${factor}：y 漂了 ${after.py - py}`)
    }
  }
})

test('连续缩放多次也不会累积漂移', () => {
  const mapPx = { w: 2048, h: 1536 }   // 128×96 格的大地图
  const size = { w: 600, h: 400 }
  const px = 421, py = 233
  let zoom = 1
  let pan = { x: 0, y: 0 }
  const base0 = fitView(mapPx, size, zoom)
  const world = screenToWorld(px, py, { scale: base0.scale, offsetX: base0.offsetX + pan.x, offsetY: base0.offsetY + pan.y })
  for (let i = 0; i < 12; i += 1) {
    const next = zoomAroundPoint({ px, py, worldX: world.x, worldY: world.y, mapPx, size, zoom, factor: 1.15 })
    zoom = next.zoom
    pan = next.pan
  }
  const baseN = fitView(mapPx, size, zoom)
  const after = worldToScreen(world.x, world.y, { scale: baseN.scale, offsetX: baseN.offsetX + pan.x, offsetY: baseN.offsetY + pan.y })
  assert.ok(Math.abs(after.px - px) < 1e-6, `放大 12 次之后 x 漂了 ${after.px - px}`)
  assert.ok(Math.abs(after.py - py) < 1e-6, `放大 12 次之后 y 漂了 ${after.py - py}`)
})

test('缩放有上下限，不会缩到看不见或无限放大', () => {
  const mapPx = { w: 128, h: 96 }
  const size = { w: 400, h: 300 }
  const atom = { px: 100, py: 100, worldX: 0, worldY: 0, mapPx, size }
  // 上限：继续放大也停在 6
  assert.equal(zoomAroundPoint({ ...atom, zoom: 6, factor: 1.15 }).zoom, 6, '上限 6')
  // 下限：继续缩小也停在 0.4（0.4×1.15=0.46 并没到界，要真往小里缩）
  assert.equal(zoomAroundPoint({ ...atom, zoom: 0.4, factor: 0.5 }).zoom, 0.4, '下限 0.4')
})
