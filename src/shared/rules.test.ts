/**
 * 判定引擎单测（node --test --experimental-strip-types）。
 *
 * 需求 4 的规则是可机检的，所以逐条钉死：1 必败 / 6 必胜 / 阈值比较 /
 * 对抗的有效值比较与平手判防守方 / 移动判定 / 状态改动的距离护栏 / 动作清洗。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { adjudicate, resolveCheck, normalizeAttrs, clampAttr, HUMAN_MID } from './model.ts'
import { coerceAction, extractJson, resolveAction, placeAt, seqRng, moveDifficulty, canEnter, nearestOpen } from './rules.ts'
import { makeTileRef, emptyLayers, stateAt } from './tilemap.ts'
import type { Tileset } from './model.ts'
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
    map: { width: 100, height: 100, tilesets: [TILESET], layers: emptyLayers(100, 100) },
    places: [place('cafe', '咖啡馆', 20, 20, 12, 10), place('park', '公园', 70, 70, 20, 20)],
    relations: [],
    agents: [],
  }
}

/**
 * 摆一个"路灯"在 object 层 (20,22)，带初始状态——状态护栏那组测试全靠它。
 * 新模型下物件就是格子上的一张瓦片：名字与可动性来自图集注释，
 * 状态挂在格子上。id 由格坐标推出（obj:20,22），与状态永远指向同一格。
 */
const LAMP = makeTileRef('test-set', 2, 0)
function putLamp(sb: Sandbox): void {
  sb.map.layers.object.cells[22 * 100 + 20] = LAMP
  sb.map.layers.object.states = { [String(22 * 100 + 20)]: { status: '正常' } }
}
const LAMP_ID = 'obj:20,22'
const lampState = (sb: Sandbox): Record<string, unknown> => stateAt(sb.map, 20, 22) ?? {}

/**
 * 测试用图集：四格分别代表草地、墙、门、水。
 *
 * 用真图集不合适——单测只该关心"注释怎么影响判定"，不该依赖某张 PNG 的像素。
 */
const TILESET: Tileset = {
  id: 'test-set',
  name: '测试图集',
  image: '',
  imageW: 64,
  imageH: 16,
  tileW: 16,
  tileH: 16,
  margin: 0,
  spacing: 1,
  notes: {
    '0,0': { name: '草地', pass: 'walk' },
    '1,0': { name: '墙', pass: 'block' },
    '2,0': { name: '木门', use: 'door' },
    '3,0': { name: '水面', pass: 'water' },
  },
}

/** 在沙盒里摆一格瓦片。 */
function putTile(sb: Sandbox, layer: 'background' | 'structure' | 'object', x: number, y: number, col: number): void {
  sb.map.layers[layer].cells[y * sb.map.width + x] = makeTileRef('test-set', col, 0)
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
  putLamp(sandbox)
  const agent = mkAgent('a', 20, 22)
  const run = mkRun([agent])
  const out = resolveAction(
    { thought: '', kind: 'act', text: '把路灯改成故障', mutations: [{ objectId: LAMP_ID, key: 'status', value: '故障' }] },
    { sandbox, run, agent, rng: seqRng([6]), ts: 5, operator: 'gm' },
  )
  assert.equal(lampState(sandbox).status as string, '故障')
  assert.equal(out.mutations.length, 1)
  assert.equal(out.mutations[0].before, '正常')
  assert.equal(out.mutations[0].after, '故障')
  assert.equal(out.events[0].kind, 'mutate')
})

test('智能体够不着物体时改不动（距离护栏）', () => {
  const sandbox = mkSandbox()
  putLamp(sandbox)
  const agent = mkAgent('a', 90, 90) // 距离路灯 20,22 很远
  const run = mkRun([agent])
  const out = resolveAction(
    { thought: '', kind: 'act', text: '把路灯改成故障', mutations: [{ objectId: LAMP_ID, key: 'status', value: '故障' }] },
    { sandbox, run, agent, rng: seqRng([6]), ts: 5 },
  )
  assert.equal(lampState(sandbox).status as string, '正常')
  assert.equal(out.mutations.length, 0)
  assert.ok(out.memory.some((m) => m.text.includes('够不着')))
})

test('智能体动手要先过 DEX 判定，失败则状态不变', () => {
  const sandbox = mkSandbox()
  putLamp(sandbox)
  // DEX 6 + 骰面 2 = 8 < 9（就地动手难度）→ 必失手；DEX 7 时同一骰面会成功，
  // 所以这里刻意用 6 —— 断言要钉的是"没过判定就不许改状态"。
  const agent = mkAgent('a', 20, 22, { attrs: normalizeAttrs({ dex: 6 }) })
  const run = mkRun([agent])
  const out = resolveAction(
    { thought: '', kind: 'act', text: '把路灯改成故障', mutations: [{ objectId: LAMP_ID, key: 'status', value: '故障' }] },
    { sandbox, run, agent, rng: seqRng([2]), ts: 5 },
  )
  assert.equal(lampState(sandbox).status as string, '正常')
  assert.equal(out.rolls.length, 1)
  assert.equal(out.rolls[0].ok, false)
})

test('智能体动手且过了判定时状态才改', () => {
  const sandbox = mkSandbox()
  putLamp(sandbox)
  const agent = mkAgent('a', 20, 22, { attrs: normalizeAttrs({ dex: 7 }) })
  const run = mkRun([agent])
  const out = resolveAction(
    { thought: '', kind: 'act', text: '把路灯改成故障', mutations: [{ objectId: LAMP_ID, key: 'status', value: '故障' }] },
    { sandbox, run, agent, rng: seqRng([3]), ts: 5 },
  )
  assert.equal(lampState(sandbox).status as string, '故障')
  assert.equal(out.mutations.length, 1)
})

test('状态值为 null 表示清除该键', () => {
  const sandbox = mkSandbox()
  putLamp(sandbox)
  const agent = mkAgent('a', 20, 22)
  const run = mkRun([agent])
  resolveAction(
    { thought: '', kind: 'act', text: '清掉状态', mutations: [{ objectId: LAMP_ID, key: 'status', value: null }] },
    { sandbox, run, agent, rng: seqRng([6]), ts: 5, operator: 'gm' },
  )
  assert.equal('status' in lampState(sandbox), false)
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
      { objectId: LAMP_ID, key: 'status', value: '故障' },
      { id: 'lamp-1', state: 'lit', to: true },
      { objectId: '', key: 'k', value: 1 },
      { objectId: LAMP_ID, key: 'obj', value: { nested: 1 } },
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

// ── 移动边界（三个图层一起决定）──────────────────────────────────────────
//
// 旧版这里测的是"矩形建筑的内外与墙圈"，要特判重叠、嵌套、门压邻居墙。
// 换成瓦片之后每格只有一个答案，测试也跟着变直白：摆一格什么，就断言能不能走。

test('草地可以走', () => {
  const sb = mkSandbox()
  putTile(sb, 'background', 5, 5, 0)
  assert.equal(canEnter(sb, 5, 5).ok, true)
})

test('墙挡住去路', () => {
  const sb = mkSandbox()
  putTile(sb, 'structure', 5, 5, 1)
  const r = canEnter(sb, 5, 5)
  assert.equal(r.ok, false)
  assert.match(String(r.reason), /墙/)
})

test('墙优先于地面：草地上的墙照样挡人', () => {
  const sb = mkSandbox()
  putTile(sb, 'background', 5, 5, 0)
  putTile(sb, 'structure', 5, 5, 1)
  assert.equal(canEnter(sb, 5, 5).ok, false)
})

test('水面不能走（地形影响移动）', () => {
  const sb = mkSandbox()
  putTile(sb, 'background', 5, 5, 3)
  assert.equal(canEnter(sb, 5, 5).ok, false)
})

test('门默认能过（镜像刚摆好，不该自封门户）', () => {
  const sb = mkSandbox()
  putTile(sb, 'object', 5, 5, 2)
  assert.equal(canEnter(sb, 5, 5).ok, true)
})

test('门关上就过不去——这是"与门互动后开门进出"的落点', () => {
  const sb = mkSandbox()
  putTile(sb, 'object', 5, 5, 2)
  sb.map.layers.object.states = { [String(5 * 100 + 5)]: { open: false } }
  assert.equal(canEnter(sb, 5, 5).ok, false)
  sb.map.layers.object.states[String(5 * 100 + 5)] = { open: true }
  assert.equal(canEnter(sb, 5, 5).ok, true)
})

test('图外不能走', () => {
  const sb = mkSandbox()
  assert.equal(canEnter(sb, -1, 5).ok, false)
  assert.equal(canEnter(sb, 5, 999).ok, false)
})

test('没摆任何瓦片的格子默认可走（不至于把地图变成一堵实心墙）', () => {
  const sb = mkSandbox()
  assert.equal(canEnter(sb, 12, 34).ok, true)
})

test('nearestOpen：目标格被挡时退到最近能站的一格', () => {
  const sb = mkSandbox()
  putTile(sb, 'structure', 50, 50, 1)
  const near = nearestOpen(sb, 50, 50)
  assert.ok(near !== undefined, '应该能找到附近可站的格子')
  assert.equal(canEnter(sb, near!.x, near!.y).ok, true)
  // 斜向 1 格（切比雪夫距离）是最近的候选之一
  assert.ok(Math.max(Math.abs(near!.x - 50), Math.abs(near!.y - 50)) <= 1)
})

// ── 地标归属 ─────────────────────────────────────────────────────────────

test('placeAt 命中面积最小的地标（最具体的那一个）', () => {
  const sandbox = mkSandbox()
  sandbox.places.push({ id: 'cafe-inner', name: '咖啡馆里屋', kind: 'place', x: 20, y: 20, w: 4, h: 4, interactive: true, state: {}, color: '#999' })
  assert.equal(placeAt(sandbox, 20, 20)?.id, 'cafe-inner')
  assert.equal(placeAt(sandbox, 70, 70)?.id, 'park')
  assert.equal(placeAt(sandbox, 5, 5), undefined)
})
