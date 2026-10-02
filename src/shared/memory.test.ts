/**
 * 记忆检索（P0）的测试。
 *
 * 这三条正是"固定取最近 N 条"做不到的事，也是加这个模块的全部理由：
 *   · 相关的那条能浮出来（哪怕它很久以前）
 *   · 很重要的事不会被一堆日常动作淹没
 *   · 刚刚发生的事仍然占优（不能为了相关性把当下挤掉）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REFLECT_EVERY, formatRetrieved, importanceOf, reflectionPrompt, retrieveMemories, shouldReflect, tokensOf } from './memory.ts'
import type { MemoryEntry } from './model.ts'

const mem = (tick: number, kind: MemoryEntry['kind'], text: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  tick, kind, text, ts: tick, ...extra,
})

test('分词：中文用 2-gram，能互相命中', () => {
  const t = tokensOf('林清在厨房做饭')
  assert.ok(t.includes('厨房'), '「厨房」应被切出来')
  assert.ok(t.includes('林清'), '人名应被切出来')
  assert.equal(tokensOf('').length, 0)
  assert.deepEqual(tokensOf('盐'), ['盐'], '单字也能成词')
})

test('要紧程度：指令 > 对话 > 自己随手做的事', () => {
  assert.ok(importanceOf({ kind: 'whisper', text: '去厨房' }) > importanceOf({ kind: 'speech', text: '去厨房' }))
  assert.ok(importanceOf({ kind: 'speech', text: '去厨房' }) > importanceOf({ kind: 'action', text: '去厨房' }))
  // 显式给过分就以它为准（将来接上模型打分的接口）
  assert.equal(importanceOf({ kind: 'action', text: '随便', importance: 10 }), 10)
})

test('相关性：问厨房，想起的是厨房那件事——哪怕它在很久以前', () => {
  const memories = [
    mem(1, 'event', '林清在厨房里打翻了一罐盐'),
    mem(8, 'action', '林清在院子里散步'),
    mem(9, 'action', '林清在门口站了一会儿'),
    mem(10, 'event', '林清抬头看了看天'),
  ]
  // 真实观察里会写"你在哪：厨房"，query 用的就是这些实词
  const got = retrieveMemories(memories, '厨房 做饭', 11, 1)
  assert.equal(got.length, 1)
  assert.match(got[0].entry.text, /厨房/, `应想起厨房那条，实际：${got[0].entry.text}`)
})

test('时效性：都一样相关时，最近发生的优先', () => {
  const memories = [mem(0, 'event', '有人在院子里说话'), mem(20, 'event', '有人在院子里说话')]
  const got = retrieveMemories(memories, '院子', 21, 1)
  assert.equal(got[0].entry.tick, 20, '近的那条该排前')
})

test('重要性：一句专门对我说的话，胜过一屏日常动作', () => {
  const memories = [
    ...Array.from({ length: 5 }, (_, i) => mem(10 + i, 'action', `林清在走走看看 ${i}`)),
    mem(9, 'whisper', '有人叮嘱林清：把炉子看着点'),
  ]
  // query 故意与所有记忆都**无关**：这样 relevance 全为 0，比的才是重要性。
  // 否则"看看"会命中那几句日常动作，测的就成了相关性。
  const got = retrieveMemories(memories, '天气', 20, 2)
  assert.ok(
    got.some((r) => r.entry.kind === 'whisper'),
    `叮嘱应被想起来，实际取到：${got.map((r) => r.entry.text).join(' / ')}`,
  )
})

test('取用会刷新 lastAccessTick（recency 下次从这里算）', () => {
  const memories = [mem(1, 'event', '厨房的炉子没关')]
  const got = retrieveMemories(memories, '厨房', 30, 1)
  assert.equal(got[0].entry.lastAccessTick, undefined, '取之前没有记录')
  formatRetrieved(got, 30)
  assert.equal(got[0].entry.lastAccessTick, 30, '取之后应记下当下的步数')
})

test('边界：空记忆、k<=0 都不炸', () => {
  assert.deepEqual(retrieveMemories([], '厨房', 5, 3), [])
  assert.deepEqual(retrieveMemories([mem(1, 'event', 'x')], '厨房', 5, 0), [])
})

// ── 反思的触发条件（P1）────────────────────────────────────────────────────
//
// 真反思要调模型，但"什么时候该反思"是纯判断——把这条测准，才不会出现
// "每步都在反思"（烧钱）或者"攒了一百条也不反思"（智能体永远不长记性）。

test('新记忆不够多时不反思', () => {
  const few = Array.from({ length: 5 }, (_, i) => mem(i, 'event', `发生了点事 ${i}`))
  assert.equal(shouldReflect(few, undefined), false, '五条不够')
})

test('攒够了、且其中有事来自外界 → 该反思', () => {
  const many = [
    ...Array.from({ length: REFLECT_EVERY }, (_, i) => mem(i, 'action', `随手做了点什么 ${i}`)),
    mem(99, 'speech', '有人对我说了一句话'),
  ]
  assert.equal(shouldReflect(many, undefined), true)
})

test('攒够了但全是自己的日常动作 → 不反思（那种反思只会产出废话）', () => {
  const onlyMine = Array.from({ length: REFLECT_EVERY + 4 }, (_, i) => mem(i, 'action', `在原地转了转 ${i}`))
  assert.equal(shouldReflect(onlyMine, undefined), false)
})

test('已经反思过的那一段不再重复触发', () => {
  const many = [
    ...Array.from({ length: REFLECT_EVERY }, (_, i) => mem(i, 'speech', `有人说话 ${i}`)),
  ]
  assert.equal(shouldReflect(many, undefined), true)
  assert.equal(shouldReflect(many, many.length), false, '游标推到最后就不该再触发')
})

test('反思提示词带上经历本身，并要求写判断而不是复述', () => {
  const p = reflectionPrompt('林清', [mem(1, 'speech', '有人说炉子该看着点')])
  assert.match(p, /林清/)
  assert.match(p, /炉子该看着点/, '要把经历原文带进去')
  assert.match(p, /第一人称/, '要明确要求视角，否则模型容易写成旁白')
})
