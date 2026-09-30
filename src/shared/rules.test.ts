/**
 * 判定引擎单测（node --test --experimental-strip-types）。
 *
 * 需求 4 的规则是可机检的，所以逐条钉死：1 必败 / 6 必胜 / 阈值比较 /
 * 对抗的有效值比较与平手判防守方 / 移动判定 / 状态改动的距离护栏 / 动作清洗。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adjudicate, resolveCheck, normalizeAttrs, clampAttr, HUMAN_MID } from './model.ts'
import { coerceAction, extractJson, resolveAction, placeAt, seqRng, moveDifficulty } from './rules.ts'
import type { RunAgent, RunState, Sandbox, WorldObject } from './model.ts'

function mkSandbox(): Sandbox {
  const place = (id: string, name: string, x: number, y: number, w: number, h: number): WorldObject => ({
    id,
    name,
    kind: 'place',
    x,
    y,
    w,
    h,
    interactive: true,
    state: {},
    color: '#888',
  })
  const lamp: WorldObject = {
    id: 'lamp-1',
    name: '路灯',
    kind: 'fixture',
    x: 20,
    y: 22,
    interactive: true,
    state: { status: '正常' },
    color: '#ccc',
  }
  return {
    v: 1,
    id: 'test',
    name: '测试镇',
    desc: '',
    createdAt: 0,
    updatedAt: 0,
    map: { width: 100, height: 100, ground: '#fff' },
    places: [place('cafe', '咖啡馆', 20, 20, 12, 10), place('park', '公园', 70, 70, 20, 20)],
    objects: [lamp],
    relations: [],
    agents: [],
  }
}

function mkAgent(id: string, x: number, y: number, over: Partial<RunAgent> = {}): RunAgent {
  return {
    id,
    name: id,
    concept: '测试',
    appearance: '',
    persona: '',
    backstory: '',
    goal: '',
    x,
    y,
    attrs: normalizeAttrs({}),
    model: null,
    plan: [],
    inventory: [],
    color: '#f00',
    portrait: '🙂',
    spawnTick: 0,
    origin: 'preset',
    memory: [],
    lastUpdateTick: 0,
    stepsTaken: 0,
    ...over,
  }
}

function mkRun(agents: RunAgent[]): RunState {
  return {
    sandboxId: 'test',
    tick: 1,
    agents,
    events: [],
    directives: [],
    relations: [],
    worldState: {},
    createdAt: 0,
    updatedAt: 0,
  }
}

// ── 需求 4：D6 + 属性 vs 难度 ──────────────────────────────────────────────

test('掷 6 恒成功，哪怕属性最低、难度最高', () => {
  const r = resolveCheck({ roll: 6, attr: 'str', attrValue: 1, difficulty: 19 })
  assert.equal(r.ok, true)
  assert.equal(r.outcome, 'critical')
  assert.equal(r.decisive, true)
})

test('掷 1 恒失败，哪怕属性满值、难度最低', () => {
  const r = resolveCheck({ roll: 1, attr: 'str', attrValue: 20, difficulty: 6 })
  assert.equal(r.ok, false)
  assert.equal(r.outcome, 'critical-failure')
  assert.equal(r.decisive, true)
})

test('骰值 + 属性 ≥ 难度 即成功（等号也算）', () => {
  const exact = resolveCheck({ roll: 4, attr: 'dex', attrValue: 7, difficulty: 11 })
  assert.equal(exact.total, 11)
  assert.equal(exact.ok, true)
  assert.equal(exact.outcome, 'success')

  const short = resolveCheck({ roll: 3, attr: 'dex', attrValue: 7, difficulty: 11 })
  assert.equal(short.total, 10)
  assert.equal(short.ok, false)
  assert.equal(short.outcome, 'failure')
})

test('修正计入总数并保留明细', () => {
  const r = resolveCheck({
    roll: 3,
    attr: 'int',
    attrValue: 7,
    difficulty: 11,
    mods: [
      { label: '手电 +1', value: 1 },
      { label: '受伤 -1', value: -1 },
    ],
  })
  assert.equal(r.modifier, 0)
  assert.equal(r.total, 10)
  assert.equal(r.mods.length, 2)
})

test('非法骰面直接报错，不静默取整', () => {
  assert.throws(() => resolveCheck({ roll: 0, attr: 'str', attrValue: 7, difficulty: 11 }))
  assert.throws(() => resolveCheck({ roll: 7, attr: 'str', attrValue: 7, difficulty: 11 }))
})

test('对抗：比较双方有效值，高者胜', () => {
  const r = adjudicate(
    { name: '甲', attr: 'str', attrValue: 8, roll: 5 },
    { name: '乙', attr: 'str', attrValue: 6, roll: 4 },
  )
  assert.equal(r.attackerTotal, 13)
  assert.equal(r.defenderTotal, 10)
  assert.equal(r.outcome, 'attacker')
  assert.equal(r.attackerWins, true)
})

test('对抗：平手判防守方收益（攻方未压过）', () => {
  const r = adjudicate(
    { name: '甲', attr: 'dex', attrValue: 7, roll: 4 },
    { name: '乙', attr: 'dex', attrValue: 6, roll: 5 },
  )
  assert.equal(r.attackerTotal, r.defenderTotal)
  assert.equal(r.outcome, 'tie')
  assert.equal(r.attackerWins, false)
})

test('对抗不吃 1/6 一票否决：6+低属性仍可能被压过', () => {
  const r = adjudicate(
    { name: '弱者', attr: 'str', attrValue: 4, roll: 6 },
    { name: '壮汉', attr: 'str', attrValue: 10, roll: 2 },
  )
  assert.equal(r.attackerTotal, 10)
  assert.equal(r.defenderTotal, 12)
  assert.equal(r.outcome, 'defender')
})

// ── 属性收口 ─────────────────────────────────────────────────────────────

test('属性被夹紧到 1..20，缺失项补中位数', () => {
  assert.equal(clampAttr(-5), 1)
  assert.equal(clampAttr(999), 20)
  assert.equal(clampAttr('x'), HUMAN_MID)
  const attrs = normalizeAttrs({ str: 99, dex: 3 })
  assert.equal(attrs.str, 20)
  assert.equal(attrs.dex, 3)
  assert.equal(attrs.pow, HUMAN_MID)
})

// ── 移动判定 ─────────────────────────────────────────────────────────────

test('距离越远难度越高', () => {
  assert.equal(moveDifficulty(3).step.label, '容易')
  assert.equal(moveDifficulty(20).step.label, '常规')
  assert.equal(moveDifficulty(40).step.label, '棘手')
  assert.equal(moveDifficulty(80).step.label, '艰难')
})

test('移动成功把坐标落到目标，失败原地留下代价', () => {
  const sandbox = mkSandbox()
  const agent = mkAgent('a', 20, 20, { attrs: normalizeAttrs({ dex: 7 }) })
  const run = mkRun([agent])

  const okOut = resolveAction(
    { thought: '去公园', kind: 'move', text: '去公园', placeId: 'park' },
    { sandbox, run, agent, rng: seqRng([6]), ts: 1 },
  )
  assert.equal(okOut.x, 70)
  assert.equal(okOut.y, 70)
  assert.ok(okOut.events.some((e) => e.kind === 'move'))

  const agent2 = mkAgent('b', 20, 20, { attrs: normalizeAttrs({ dex: 7 }) })
  const run2 = mkRun([agent2])
  const failOut = resolveAction(
    { thought: '去公园', kind: 'move', text: '去公园', placeId: 'park' },
    { sandbox: mkSandbox(), run: run2, agent: agent2, rng: seqRng([2]), ts: 1 },
  )
  assert.equal(failOut.x, 20)
  assert.equal(failOut.y, 20)
  // 失败必须留下一条有内容的叙事，不能是"什么都没发生"。
  const move = failOut.events.find((e) => e.kind === 'move')
  assert.ok(move !== undefined)
  assert.ok(move.text.includes('没能顺利前往'))
})

// ── 需求 5：物体状态改动 ─────────────────────────────────────────────────

test('玩家（gm）改状态直接生效并留下前后值', () => {
  const sandbox = mkSandbox()
  const agent = mkAgent('a', 20, 22)
  const run = mkRun([agent])
  const out = resolveAction(
    { thought: '', kind: 'act', text: '把路灯改成故障', mutations: [{ objectId: 'lamp-1', key: 'status', value: '故障' }] },
    { sandbox, run, agent, rng: seqRng([6]), ts: 5, operator: 'gm' },
  )
  assert.equal(sandbox.objects[0].state.status, '故障')
  assert.equal(out.mutations.length, 1)
  assert.equal(out.mutations[0].before, '正常')
  assert.equal(out.mutations[0].after, '故障')
  assert.equal(out.events[0].kind, 'mutate')
})

test('智能体够不着物体时改不动（距离护栏）', () => {
  const sandbox = mkSandbox()
  const agent = mkAgent('a', 90, 90) // 距离路灯 20,22 很远
  const run = mkRun([agent])
  const out = resolveAction(
    { thought: '', kind: 'act', text: '把路灯改成故障', mutations: [{ objectId: 'lamp-1', key: 'status', value: '故障' }] },
    { sandbox, run, agent, rng: seqRng([6]), ts: 5 },
  )
  assert.equal(sandbox.objects[0].state.status, '正常')
  assert.equal(out.mutations.length, 0)
  assert.ok(out.memory.some((m) => m.text.includes('够不着')))
})

test('智能体动手要先过 DEX 判定，失败则状态不变', () => {
  const sandbox = mkSandbox()
  // DEX 6 + 骰面 2 = 8 < 9（就地动手难度）→ 必失手；DEX 7 时同一骰面会成功，
  // 所以这里刻意用 6 —— 断言要钉的是"没过判定就不许改状态"。
  const agent = mkAgent('a', 20, 22, { attrs: normalizeAttrs({ dex: 6 }) })
  const run = mkRun([agent])
  const out = resolveAction(
    { thought: '', kind: 'act', text: '把路灯改成故障', mutations: [{ objectId: 'lamp-1', key: 'status', value: '故障' }] },
    { sandbox, run, agent, rng: seqRng([2]), ts: 5 },
  )
  assert.equal(sandbox.objects[0].state.status, '正常')
  assert.equal(out.rolls.length, 1)
  assert.equal(out.rolls[0].ok, false)
})

test('智能体动手且过了判定时状态才改', () => {
  const sandbox = mkSandbox()
  const agent = mkAgent('a', 20, 22, { attrs: normalizeAttrs({ dex: 7 }) })
  const run = mkRun([agent])
  const out = resolveAction(
    { thought: '', kind: 'act', text: '把路灯改成故障', mutations: [{ objectId: 'lamp-1', key: 'status', value: '故障' }] },
    { sandbox, run, agent, rng: seqRng([3]), ts: 5 },
  )
  assert.equal(sandbox.objects[0].state.status, '故障')
  assert.equal(out.mutations.length, 1)
})

test('状态值为 null 表示清除该键', () => {
  const sandbox = mkSandbox()
  const agent = mkAgent('a', 20, 22)
  const run = mkRun([agent])
  resolveAction(
    { thought: '', kind: 'act', text: '清掉状态', mutations: [{ objectId: 'lamp-1', key: 'status', value: null }] },
    { sandbox, run, agent, rng: seqRng([6]), ts: 5, operator: 'gm' },
  )
  assert.equal('status' in sandbox.objects[0].state, false)
})

// ── 动作清洗 ─────────────────────────────────────────────────────────────

test('extractJson 剥掉 markdown 代码块与前后解释', () => {
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 })
  assert.deepEqual(extractJson('好的，我的行动是 {"a":2} 就这些'), { a: 2 })
  assert.equal(extractJson('完全不是 JSON'), null)
  assert.equal(extractJson(''), null)
})

test('coerceAction 修正别名动词并按自然语言猜意图', () => {
  assert.equal(coerceAction({ kind: 'go', text: '去公园' }).kind, 'move')
  assert.equal(coerceAction({ kind: 'talk', text: '聊聊' }).kind, 'say')
  assert.equal(coerceAction({ text: '我要走过去看看那盏灯' }).kind, 'move')
  assert.equal(coerceAction({ text: '他大声喊了一句' }).kind, 'say')
  assert.equal(coerceAction({ text: '随便写点什么' }).kind, 'wait')
  // 非对象输入必须得到可执行动作，而不是抛错
  assert.equal(coerceAction(null).kind, 'wait')
  assert.equal(coerceAction('一段字符串').kind, 'wait')
})

test('coerceAction 收下 mutations 并丢掉脏条目', () => {
  const a = coerceAction({
    kind: 'act',
    text: 'x',
    mutations: [
      { objectId: 'lamp-1', key: 'status', value: '故障' },
      { id: 'lamp-1', state: 'lit', to: true },
      { objectId: '', key: 'k', value: 1 },
      { objectId: 'lamp-1', key: 'obj', value: { nested: 1 } },
    ],
  })
  assert.equal(a.mutations?.length, 2)
})

// ── 地标归属 ─────────────────────────────────────────────────────────────

test('placeAt 命中面积最小的地标（最具体的那一个）', () => {
  const sandbox = mkSandbox()
  sandbox.places.push({ id: 'cafe-inner', name: '咖啡馆里屋', kind: 'place', x: 20, y: 20, w: 4, h: 4, interactive: true, state: {}, color: '#999' })
  assert.equal(placeAt(sandbox, 20, 20)?.id, 'cafe-inner')
  assert.equal(placeAt(sandbox, 70, 70)?.id, 'park')
  assert.equal(placeAt(sandbox, 5, 5), undefined)
})
