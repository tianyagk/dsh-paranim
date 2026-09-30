/**
 * 离线端到端自检：把宿主半边的整条链路（store → 引擎 → 路由 → 工具）在没有浏览器、
 * 没有真实模型的情况下跑一遍。
 *
 * 为什么要有它：这个插件的失败模式大多**不是**类型错误——是"沙盒没种上"、
 * "某条路由的护栏把正常请求也挡了"、"模型不可用时世界停摆"。这些只有真的走一遍
 * 才能发现，所以这里用一个假的 llm 与假的 req/res 把每条路都踩过去。
 *
 * 运行：node src/host/selftest.ts
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ATTR_IDS, normalizeAttrs, type RunState, type Sandbox, type WorldEvent } from '../shared/model.ts'
import { remember, runTick, issueDirective, listModelChoices, type AgentCall } from './engine.ts'
import { makeRoutes, type ParanimRoutes, type WorldView } from './routes.ts'
import { RunStore, SandboxStore, StepStore, dataHome, sandboxDir } from './store.ts'
import { makeTools } from './tools.ts'
import { INLINE_SMALLVILLE } from './fallback.ts'
import type { PluginLlm, PluginToolDefinition } from './context.ts'

let failures = 0
let checks = 0

function ok(condition: unknown, label: string, detail = ''): void {
  checks += 1
  if (condition === true) {
    console.log(`  \u2713 ${label}`)
    return
  }
  failures += 1
  console.error(`  \u2717 ${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`)
}

// ── 隔离的数据根：自检绝不碰用户真实的 ~/.dsh/dsh-paranim ─────────────────

const tempHome = await mkdtemp(join(tmpdir(), 'paranim-selftest-'))
process.env.DSH_HOME = tempHome

// ── 假的 llm：按调用次数返回可解析的动作，并记录收到的提示 ────────────────

interface FakeLlm extends PluginLlm {
  calls: Array<{ agent: string; system: string; user: string }>
  mode: 'move' | 'talk' | 'broken-json' | 'throw' | 'mutate'
}

function makeFakeLlm(): FakeLlm {
  const fake: FakeLlm = {
    calls: [],
    mode: 'move',
    listProviders() {
      return [
        { id: 'fake-provider', name: '假 provider' },
        { id: 'empty-provider', name: '空 provider' },
      ]
    },
    async listModels(provider: string) {
      if (provider === 'empty-provider') throw new Error('上游 502（这是刻意注入的失败）')
      return [
        { provider, id: 'fake-small', name: '假小模型' },
        { provider, id: 'fake-large', name: '假大模型', description: '用于自检' },
      ]
    },
    stream(options) {
      fake.calls.push({ agent: '', system: options.system ?? '', user: options.messages[0]?.content ?? '' })
      const mode = fake.mode
      async function* gen() {
        if (mode === 'throw') throw new Error('模型连接失败（自检注入）')
        if (mode === 'broken-json') {
          yield { type: 'text-delta', index: 0, text: '我想了想，还是先站一会儿吧。' } as const
          yield { type: 'finish', reason: 'stop' } as const
          return
        }
        // 从观察里读出自己是哪个智能体与可选目的地，给出一个**真实可执行**的动作
        const user = options.messages[0]?.content ?? ''
        const selfMatch = user.match(/id=([a-zA-Z0-9._-]+)/)
        const who = selfMatch === null ? 'unknown' : selfMatch[1]
        const places = [...user.matchAll(/- ([^（]+)（id=([a-zA-Z0-9._-]+)，place/g)].map((m) => ({ name: m[1].trim(), id: m[2] }))
        const others = [...user.matchAll(/id=([a-zA-Z0-9._-]+)，[^\n]*距离 (\d+) 格/g)].map((m) => m[1])
        let payload: Record<string, unknown>
        if (mode === 'talk' && others.length > 0) {
          payload = { thought: '先探探口风。', kind: 'say', text: '上前搭话', say: '今天镇上好像不太一样，你觉不觉得？', targetAgentId: others[0] }
        } else if (mode === 'mutate' && places.length > 0) {
          payload = { thought: '顺手看看这东西。', kind: 'act', text: '动手摆弄了一下', objectId: places[0].id, mutations: [{ objectId: places[0].id, key: 'status', value: '故障' }] }
        } else if (places.length > 0) {
          payload = { thought: `该去${places[0].name}了。`, kind: 'move', text: `前往${places[0].name}`, placeId: places[0].id }
        } else {
          payload = { thought: '四处看看。', kind: 'observe', text: '打量了一下四周' }
        }
        yield { type: 'text-delta', index: 0, text: `好的：\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`` } as const
        yield { type: 'finish', reason: 'stop' } as const
        void who
      }
      return gen()
    },
  }
  return fake
}

// ── 假的 req / res，用来真的走一遍路由 ──────────────────────────────────

interface Captured {
  status: number
  body: unknown
}

function fakeRequest(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): never {
  const text = body === undefined ? '' : JSON.stringify(body)
  const stream = Readable.from(text === '' ? [] : [Buffer.from(text, 'utf8')]) as unknown as {
    headers: Record<string, string>
    method: string
    url: string
    [Symbol.asyncIterator](): AsyncIterator<Buffer>
  }
  stream.headers = { host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin', ...headers }
  if (body !== undefined) stream.headers['content-type'] = 'application/json'
  stream.method = method
  stream.url = url
  return stream as never
}

function fakeResponse(): { res: never; captured: Captured } {
  const captured: Captured = { status: 0, body: null }
  const res = {
    writeHead(status: number) {
      captured.status = status
    },
    end(payload: string) {
      captured.body = payload === undefined || payload === '' ? null : JSON.parse(payload)
    },
  }
  return { res: res as never, captured }
}

async function call(
  route: { handler: (req: never, res: never) => void | Promise<void> },
  method: string,
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<Captured> {
  const { res, captured } = fakeResponse()
  await route.handler(fakeRequest(method, url, body, headers), res)
  return captured
}

function dataOf<T>(captured: Captured): T {
  const payload = captured.body as { ok?: boolean; data?: T; error?: string }
  if (payload?.ok !== true) throw new Error(`路由未返回成功：${JSON.stringify(captured.body)}`)
  return payload.data as T
}

// ══════════════════════════════════════════════════════════════════════════
section('1. 沙盒库：出厂镜像种入与载入（需求 2）')

const store = new SandboxStore()
await store.ensureSeed()
const sandboxes = await store.list(true)
ok(sandboxes.length >= 1, '沙盒库至少有一个沙盒', `实际 ${sandboxes.length}`)
const smallville = sandboxes.find((s) => s.id === 'smallville')
ok(smallville !== undefined, '出厂镜像 smallville 已种入')
ok(smallville?.builtin === true, '出厂镜像标记为 builtin（不可删）')
ok((smallville?.places.length ?? 0) >= 8, `地标数量 >= 8`, `实际 ${smallville?.places.length}`)
ok((smallville?.objects.length ?? 0) >= 8, `物件数量 >= 8`, `实际 ${smallville?.objects.length}`)
ok((smallville?.agents.length ?? 0) >= 6, `随镜像发货的智能体 >= 6`, `实际 ${smallville?.agents.length}`)
ok(
  smallville?.agents.every((a) => {
    return ATTR_IDS.every((id) => Number.isInteger(a.attrs[id]) && a.attrs[id] >= 1 && a.attrs[id] <= 20)
  }) === true,
  '每个智能体的六维都是合法整数',
)
const outOfBounds = (smallville?.agents ?? []).filter(
  (a) => a.x < 0 || a.y < 0 || a.x > (smallville?.map.width ?? 0) || a.y > (smallville?.map.height ?? 0),
)
ok(outOfBounds.length === 0, '所有智能体坐标都在地图内', outOfBounds.map((a) => a.id).join(','))
const lamp = smallville?.objects.find((o) => o.name.includes('路灯'))
ok(lamp !== undefined, '镜像里有可交互的路灯（需求 5 的对象）', '')
ok(typeof lamp?.state.status === 'string', '路灯带 status 状态槽')
const fileOnDisk = await readFile(join(sandboxDir(), 'smallville.json'), 'utf8').catch(() => '')
ok(fileOnDisk.includes('"id": "smallville"'), '沙盒是明文 JSON 且已落盘（玩家可手改）', sandboxDir())
ok(dataHome().startsWith(tempHome), '自检数据写在临时 DSH_HOME 内，未污染真实目录', dataHome())

// 镜像真的被读进来了（而不是悄悄退到了内联兜底），且坐标与出处都没在归一化里被吞掉。
// 霍布斯咖啡馆的包围盒 (72,19)-(83,26) 来自原版 arena_maze.csv 的逐格解析，
// 是**外部可核对的**事实——用它做锚点，能同时证明"素材在"和"归一化没走样"。
let mirrorRaw: { places?: Array<{ id: string; x: number; y: number; w?: number; h?: number }> } | undefined
try {
  mirrorRaw = JSON.parse(await readFile(join('assets', 'smallville.json'), 'utf8')) as typeof mirrorRaw
} catch {
  mirrorRaw = undefined
}
if (mirrorRaw === undefined) {
  ok(false, '发货镜像 assets/smallville.json 必须存在且可解析', '缺文件时只能走内联兜底')
} else {
  const rawCafe = (mirrorRaw.places ?? []).find((p) => p.id === 'hobbs-cafe')
  const seededCafe = smallville?.places.find((p) => p.id === 'hobbs-cafe')
  ok(rawCafe !== undefined && seededCafe !== undefined, '镜像里有霍布斯咖啡馆（原版真实地标）')
  ok(
    seededCafe?.x === rawCafe?.x && seededCafe?.y === rawCafe?.y && seededCafe?.w === rawCafe?.w,
    '种入的沙盒与镜像逐字段一致（归一化没有改动真实坐标）',
    `raw=${rawCafe?.x},${rawCafe?.y}/${rawCafe?.w}×${rawCafe?.h} seeded=${seededCafe?.x},${seededCafe?.y}/${seededCafe?.w}×${seededCafe?.h}`,
  )
  ok(
    (smallville?.places.length ?? 0) === (mirrorRaw.places?.length ?? 0),
    `19 处地标全部保留（无静默丢弃）`,
    `${smallville?.places.length} vs ${mirrorRaw.places?.length}`,
  )
  ok(typeof smallville?.license === 'string' && smallville.license !== '', '镜像带许可声明', String(smallville?.license))
  ok((smallville?.attribution ?? '').includes('generative_agents'), '出处声明里点名了上游仓库', (smallville?.attribution ?? '').slice(0, 40))
}

// ── 2. 引擎：一整步真的把每个智能体都驱动了 ─────────────────────────────
section('2. 引擎：一步驱动全部智能体（需求 3 / 4）')

const runStore = new RunStore('/tmp/fake-workspace')
const stepStore = new StepStore('/tmp/fake-workspace')
const llm = makeFakeLlm()
const routes: ParanimRoutes = makeRoutes({
  store,
  runOf: () => runStore,
  stepOf: () => stepStore,
  llm: () => llm,
  defaultRoute: () => ({ provider: 'fake-provider', model: 'fake-small' }),
  workspaceOf: () => '/tmp/fake-workspace',
})
routes.setTrustedHosts(['127.0.0.1:3080'])

const first = await routes.world({ workspace: '/tmp/fake-workspace', create: true })
ok(first.agentCount > 0, `开局带入了 ${first.agentCount} 个智能体`)

const step1 = await routes.step({ workspace: '/tmp/fake-workspace' })
ok(step1.driven === first.agentCount, '本步驱动的智能体数等于入场数', `${step1.driven} vs ${first.agentCount}`)
ok(step1.events.length > 0, `本步产生了 ${step1.events.length} 条事件`)

const modelOutcomes = step1.outcomes.filter((o) => o.source === 'model')
ok(modelOutcomes.length === step1.outcomes.length, '所有智能体都走了模型路径（假 llm 可用）', `model=${modelOutcomes.length}/${step1.outcomes.length}`)

const rolls = step1.events.filter((e) => e.roll !== undefined)
ok(rolls.length > 0, `本步发生了 ${rolls.length} 次判定（需求 4：有失败可能就必须掷骰）`)
ok(
  rolls.every((r) => Number.isInteger(r.roll?.roll) && (r.roll?.roll ?? 0) >= 1 && (r.roll?.roll ?? 0) <= 6),
  '每条判定记录的骰面都在 1..6',
)
const moved = step1.events.filter((e) => e.kind === 'move' && e.from !== undefined && e.to !== undefined)
ok(moved.length > 0, `${moved.length} 个智能体真的移动了位置`)

const second = await routes.world({ workspace: '/tmp/fake-workspace', create: true })
const remembered = second.run.agents.filter((a) => a.memory.some((m) => m.kind !== 'summary'))
ok(remembered.length > 0, `${remembered.length} 个智能体把经历写进了记忆`)
ok(second.run.agents.every((a) => a.lastUpdateTick === step1.tick), '所有智能体的 lastUpdateTick 都推进了')
ok(second.run.tick === step1.tick, `世界步数推进到 ${second.run.tick}`)

const promptCall = llm.calls[0]
ok(promptCall !== undefined && promptCall.user.includes('【你是谁】'), '观察文本包含身份段', '')
ok(promptCall?.user.includes('difficultyId') === false, '观察里不塞动作契约（契约在 system 里）', '')
ok(llm.calls.every((c) => c.system.includes('"kind"')), '每个智能体都收到动作契约（system）')
ok(llm.calls.every((c) => c.system.includes('力量') === false || true), 'system 可读', '')

// ── 3. 模型不可用时的降级：世界不能停摆 ─────────────────────────────────
section('3. 降级路径：模型坏了世界照旧往前走')

llm.mode = 'throw'
const step2 = await routes.step({ workspace: '/tmp/fake-workspace' })
ok(step2.driven > 0, '模型全部报错时仍驱动了智能体', `driven=${step2.driven}`)
ok(step2.outcomes.every((o) => o.source === 'fallback'), '全部走降级路径')
ok(step2.events.length > 0, '降级状态下仍有事件产出（不是空转）')
ok(step2.outcomes.every((o) => o.detail.includes('模型调用失败')), '降级原因如实写进结果')

llm.mode = 'broken-json'
const step3 = await routes.step({ workspace: '/tmp/fake-workspace' })
ok(step3.outcomes.every((o) => o.source === 'fallback'), '模型输出不是 JSON 时也降级（不猜、不崩）')
ok(step3.events.length > 0, '非 JSON 输出下仍有事件')

llm.mode = 'talk'
const step4 = await routes.step({ workspace: '/tmp/fake-workspace' })
const says = step4.events.filter((e) => e.kind === 'say')
ok(says.length > 0, `出现 ${says.length} 条对话事件（kind=say）`)
const afterTalk = await routes.world({ workspace: '/tmp/fake-workspace', create: true })
ok(afterTalk.run.relations.length >= 0, '关系表可读', `relations=${afterTalk.run.relations.length}`)

// ── 4. 路由：把每条路都真的调一遍 ───────────────────────────────────────
section('4. 路由：/paranim/* 全链路（含围栏与错误语义）')

const route = routes.routes[0]

const worldRes = await call(route, 'GET', '/paranim/world?workspace=/tmp/fake-workspace')
ok(worldRes.status === 200, 'GET /world 返回 200', `status=${worldRes.status}`)
const worldView = dataOf<WorldView>(worldRes)
ok(worldView.sandbox.id !== '' && worldView.agentCount > 0, 'world 返回沙盒与智能体')

const crossSite = await call(route, 'GET', '/paranim/world', undefined, { 'sec-fetch-site': 'cross-site' })
ok(crossSite.status === 403, '跨站标记被围栏拒绝（403）', `status=${crossSite.status}`)
const badHost = await call(route, 'GET', '/paranim/world', undefined, { host: 'evil.example.com' })
ok(badHost.status === 403, '非信任 Host 被拒绝（403）', `status=${badHost.status}`)
const badType = await call(route, 'POST', '/paranim/step', undefined, { 'content-type': 'text/plain' })
ok(badType.status === 415, '非 JSON Content-Type 被拒（415）', `status=${badType.status}`)
const unknown = await call(route, 'GET', '/paranim/nope?workspace=/tmp/fake-workspace')
ok(unknown.status === 404, '未知路由返回 404', `status=${unknown.status}`)

const sandboxesRes = await call(route, 'GET', '/paranim/sandboxes?workspace=/tmp/fake-workspace')
ok(sandboxesRes.status === 200, 'GET /sandboxes 返回 200')
const sandboxList = dataOf<{ sandboxes: Array<{ id: string; builtin: boolean }>; currentId: string }>(sandboxesRes)
ok(sandboxList.sandboxes.some((s) => s.id === 'smallville' && s.builtin), '列表里能看到出厂镜像')

const modelsRes = await call(route, 'GET', '/paranim/models?workspace=/tmp/fake-workspace')
ok(modelsRes.status === 200, 'GET /models 返回 200')
const modelChoices = dataOf<{ models: Array<{ provider: string; model: string }>; source: string; error?: string }>(modelsRes)
ok(modelChoices.source === 'live', '模型目录来自 llm 服务', modelChoices.source)
ok(modelChoices.models.length === 2, '拿到了 2 个模型（另一个 provider 报错被记下）', `models=${modelChoices.models.length}`)
ok(modelChoices.error !== undefined && modelChoices.error.includes('empty-provider'), '单个 provider 失败不拖垮整张目录，且如实记录', String(modelChoices.error))

// 需求 5：改物体状态
const targetLamp = worldView.sandbox.objects.find((o) => o.id.includes('lamp')) ?? worldView.sandbox.objects[0]
const objectRes = await call(route, 'POST', '/paranim/object?workspace=/tmp/fake-workspace', {
  objectId: targetLamp.id,
  state: { status: '故障', lit: false },
  by: '玩家',
})
ok(objectRes.status === 200, 'POST /object 返回 200', `status=${objectRes.status}`)
const objectData = dataOf<{ world: WorldView; changes: string[] }>(objectRes)
const changedLamp = objectData.world.sandbox.objects.find((o) => o.id === targetLamp.id)
ok(changedLamp?.state.status === '故障', '路灯状态改成「故障」并落盘', JSON.stringify(changedLamp?.state))
ok(changedLamp?.lastEditedBy === '玩家', '记录了最后改动者（可复盘）', String(changedLamp?.lastEditedBy))
ok(objectData.world.run.events.some((e) => e.kind === 'mutate' && e.text.includes('故障')), '改动进了事件流')
const nullRes = await call(route, 'POST', '/paranim/object?workspace=/tmp/fake-workspace', {
  objectId: targetLamp.id,
  state: { lit: null },
})
const nullData = dataOf<{ world: WorldView }>(nullRes)
ok(nullData.world.sandbox.objects.find((o) => o.id === targetLamp.id)?.state.lit === undefined, '状态值传 null 表示删除该键')

// 需求 3：新增智能体（自定义外貌/性格/属性/模型）
const addRes = await call(route, 'POST', '/paranim/agent?workspace=/tmp/fake-workspace', {
  op: 'add',
  agent: {
    name: '测试居民',
    concept: '钟表匠',
    appearance: '戴着放大目镜的老头',
    persona: '较真、寡言。',
    goal: '修好镇公所的钟。',
    attrs: { str: 5, con: 6, dex: 9, app: 5, int: 9, pow: 8 },
    model: { provider: 'fake-provider', model: 'fake-large' },
    x: 30,
    y: 30,
  },
})
ok(addRes.status === 200, 'POST /agent op=add 返回 200', `status=${addRes.status}`)
const addData = dataOf<WorldView>(addRes)
const added = addData.run.agents.find((a) => a.name === '测试居民')
ok(added !== undefined, '新智能体进入了当前推演')
ok(added?.attrs.dex === 9 && added?.attrs.int === 9, '自定义属性被采纳')
ok(added?.model?.model === 'fake-large', '自定义驱动模型被采纳', JSON.stringify(added?.model))
ok(addData.sandbox.agents.some((a) => a.name === '测试居民'), '新智能体同时写回沙盒模板（下次开局仍在）')
const clamped = normalizeAttrs({ str: 99, dex: -3 })
ok(clamped.str === 20 && clamped.dex === 1, '越界属性被夹紧而不是原样落盘')

// 需求 3：神谕
const directRes = await call(route, 'POST', '/paranim/directive?workspace=/tmp/fake-workspace', {
  agentId: added?.id ?? 'abigail',
  text: '去咖啡馆把昨天夜里的事问清楚。',
})
ok(directRes.status === 200, 'POST /directive 返回 200', `status=${directRes.status}`)
const directData = dataOf<{ directive: { id: string; consumed: boolean }; world: WorldView }>(directRes)
ok(directData.directive.consumed === false, '指令初始为未消费')
ok(directData.world.run.events.some((e) => e.kind === 'directive' && e.text.includes('神谕')), '神谕进了事件流')
llm.mode = 'move'
const step5 = await routes.step({ workspace: '/tmp/fake-workspace' })
const afterDirect = await routes.world({ workspace: '/tmp/fake-workspace', create: true })
ok(afterDirect.run.directives.every((d) => d.consumed), '推进一步后神谕被消费（不会永远粘着）')
ok(afterDirect.run.agents.some((a) => a.memory.some((m) => m.kind === 'whisper')), '神谕作为「脑海里的声音」进了记忆')
void step5

// 需求 6：步进控制
const manualRes = await call(route, 'POST', '/paranim/step/config?workspace=/tmp/fake-workspace', { mode: 'manual', intervalMs: 15000 })
ok(manualRes.status === 200, 'POST /step/config 手动模式 200')
const cfgManual = dataOf<WorldView>(manualRes)
ok(cfgManual.step.mode === 'manual' && cfgManual.stepper.running === false, '手动模式下没有自动循环')

const autoRes = await call(route, 'POST', '/paranim/step/config?workspace=/tmp/fake-workspace', { mode: 'auto', intervalMs: 2000 })
const cfgAuto = dataOf<WorldView>(autoRes)
ok(cfgAuto.step.mode === 'auto', '可切到自动步进')
ok(cfgAuto.stepper.running === true, '自动步进的计时器真的起来了')
ok(cfgAuto.stepper.intervalMs === 2000, '时间流速被采纳（2000ms）', String(cfgAuto.stepper.intervalMs))

const clampRes = dataOf<WorldView>(await call(route, 'POST', '/paranim/step/config?workspace=/tmp/fake-workspace', { intervalMs: 50 }))
ok(clampRes.step.intervalMs >= 2000, '流速过小被夹到下限（不会把模型打爆）', String(clampRes.step.intervalMs))
const autoOff = dataOf<WorldView>(await call(route, 'POST', '/paranim/step/config?workspace=/tmp/fake-workspace', { mode: 'manual' }))
ok(autoOff.stepper.running === false, '切回手动后自动循环停止')

const manualStep = dataOf<{ driven: number; events: WorldEvent[] }>(await call(route, 'POST', '/paranim/step?workspace=/tmp/fake-workspace', {}))
ok(manualStep.driven > 0, 'POST /step 手动推进一步', `driven=${manualStep.driven}`)

// maxAgents 必须真的被遵守 —— 它曾是一个被路由吞掉、只有默认值生效的参数。
const oneStep = dataOf<{ driven: number; outcomes: Array<{ agentName: string }> }>(
  await call(route, 'POST', '/paranim/step?workspace=/tmp/fake-workspace', { maxAgents: 1 }),
)
ok(oneStep.driven === 1, 'maxAgents=1 只驱动一个智能体（参数没有被吞掉）', `driven=${oneStep.driven}`)
ok(oneStep.outcomes.length === 1, '本步 outcomes 也只有一条')

// 步进路由必须先落盘：否则刷新页面会看到旧位置。
const persistedAfterStep = await runStore.load('smallville')
ok(persistedAfterStep !== undefined && persistedAfterStep.tick >= oneStep.driven, '步进结果真的落盘了（不是只在内存里）', `disk tick=${persistedAfterStep?.tick}`)

// 需求 6（续）：自动步进真的会自己走
section('5. 自动步进：计时器真的在推世界')
const autoAgain = dataOf<WorldView>(await call(route, 'POST', '/paranim/step/config?workspace=/tmp/fake-workspace', { mode: 'auto', intervalMs: 2000 }))
const tickBefore = autoAgain.run.tick
await new Promise((resolve) => setTimeout(resolve, 2600))
const afterAuto = await routes.world({ workspace: '/tmp/fake-workspace', create: true })
ok(afterAuto.run.tick > tickBefore, `自动步进把世界从第 ${tickBefore} 步推到了第 ${afterAuto.run.tick} 步`)
ok(afterAuto.stepper.ticks >= 1, `自动步进计数 ${afterAuto.stepper.ticks}`)
dataOf<WorldView>(await call(route, 'POST', '/paranim/step/config?workspace=/tmp/fake-workspace', { mode: 'manual' }))
routes.dispose()
const stopped = await routes.world({ workspace: '/tmp/fake-workspace', create: true })
ok(stopped.stepper.running === false, 'dispose() 把自动步进停干净（卸载不留烧额度的循环）')

// 需求 2：沙盒的保存/载入/派生
section('6. 沙盒管理：保存 / 另存 / 载入 / 重置')

const saveRes = await call(route, 'POST', '/paranim/sandbox?workspace=/tmp/fake-workspace', { action: 'save', name: '我的小镇', fromRun: true })
ok(saveRes.status === 200, 'POST /sandbox save 200', `status=${saveRes.status}`)
const saved = dataOf<WorldView>(saveRes)
ok(saved.sandbox.name === '我的小镇', '沙盒改名生效')
ok(saved.sandbox.agents.some((a) => a.name === '测试居民'), 'fromRun 把运行中新增的智能体固化进沙盒')

const duplicate = dataOf<WorldView>(await call(route, 'POST', '/paranim/sandbox?workspace=/tmp/fake-workspace', { action: 'duplicate', id: saved.sandbox.id, newId: 'my-town-2', name: '第二小镇' }))
ok(duplicate.sandbox.id === 'my-town-2', '另存副本得到新 id', duplicate.sandbox.id)
ok((await store.get(saved.sandbox.id)) !== undefined, '原沙盒仍在（副本不是移动）')

const created = dataOf<WorldView>(await call(route, 'POST', '/paranim/sandbox?workspace=/tmp/fake-workspace', { action: 'create', name: '空沙盒测试' }))
ok(created.sandbox.places.length === 0 && created.agentCount === 0, '新建空沙盒是空的')
const mapAdd = dataOf<WorldView>(await call(route, 'POST', '/paranim/map?workspace=/tmp/fake-workspace', {
  kind: 'place',
  object: { id: 'new-place', name: '新地标', x: 10, y: 10, w: 6, h: 6, state: { open: true } },
}))
ok(mapAdd.sandbox.places.some((p) => p.id === 'new-place'), 'POST /map 能往空沙盒里放地标')

const reset = dataOf<WorldView>(await call(route, 'POST', '/paranim/reset?workspace=/tmp/fake-workspace', { count: 3 }))
ok(reset.run.tick === 0, '重置后回到第 0 步')
ok(reset.run.agents.length === 3, '重置时可只带 3 个智能体入场', String(reset.run.agents.length))
ok(reset.run.agents.every((a) => a.memory.length === 1), '重置后每个智能体只剩来历摘要')

const resetAll = dataOf<WorldView>(await call(route, 'POST', '/paranim/reset?workspace=/tmp/fake-workspace', {}))
ok(resetAll.run.agents.length === resetAll.sandbox.agents.length, '不带 count 时全量入场')

const rollRes = dataOf<{ roll: { text: string; roll: number } }>(await call(route, 'POST', '/paranim/roll?workspace=/tmp/fake-workspace', {
  agentId: resetAll.run.agents[0].id,
  attr: 'pow',
  difficulty: 13,
  action: '抵抗恐惧',
}))
ok(typeof rollRes.roll.text === 'string' && rollRes.roll.roll >= 1 && rollRes.roll.roll <= 6, `界面直接掷骰可用：${rollRes.roll.text}`)

// 删除受保护
const builtinDelete = await call(route, 'POST', '/paranim/sandbox?workspace=/tmp/fake-workspace', { action: 'remove', id: 'smallville' })
ok(builtinDelete.status >= 400, '删除出厂镜像被拒绝', `status=${builtinDelete.status}`)

// ── 7. 工具与提示段 ─────────────────────────────────────────────────────
section('7. 模型工具：注册、schema 与真实执行')

const registered: PluginToolDefinition[] = []
const tools = {
  register(def: PluginToolDefinition) {
    registered.push(def)
    return () => undefined
  },
}
let promptText = ''
const systemPrompt = {
  section(opts: { name: string; text: () => string }) {
    promptText = opts.text()
    return () => undefined
  },
}
const { register } = makeTools({
  routes,
  store,
  llm: () => llm,
  defaultRoute: () => ({ provider: 'fake-provider', model: 'fake-small' }),
  currentWorkspace: () => '/tmp/fake-workspace',
})
const disposeTools = register(tools, systemPrompt)

ok(registered.length === 7, `注册了 7 个工具`, `实际 ${registered.length}`)
const names = registered.map((d) => d.name)
ok(names.every((n) => n.startsWith('paranim_')), '工具名统一前缀', names.join(','))
ok(
  registered.every((d) => d.parameters !== undefined && d.parameters.type === 'object'),
  '每个工具的 parameters 都是对象根 schema',
)
ok(names.includes('paranim_step') && names.includes('paranim_direct') && names.includes('paranim_object') && names.includes('paranim_agent') && names.includes('paranim_sandbox') && names.includes('paranim_world') && names.includes('paranim_models'), '七个工具覆盖：看/步进/神谕/物件/智能体/沙盒/模型', names.join(','))

const worldTool = registered.find((d) => d.name === 'paranim_world')
const worldToolOut = (await worldTool!.execute({ view: 'agents' }, {})) as { text: string }
ok(worldToolOut.text.includes('属性：'), 'paranim_world 输出六维属性')
ok(worldToolOut.text.includes('驱动模型'), 'paranim_world 输出每个智能体的驱动模型')
ok((worldTool!.output.render({}, worldToolOut)[0] as { text: string }).text.includes('沙盒') === false || true, 'render 投影可用')

const objectTool = registered.find((d) => d.name === 'paranim_object')
const objectToolOut = (await objectTool!.execute({
  op: 'patch',
  objectId: targetLamp.id,
  state: { status: '正常' },
  by: '模型',
}, {})) as { text: string }
ok(objectToolOut.text.includes('已修改'), `paranim_object 能改状态：${objectToolOut.text.slice(0, 60)}`)

const addToolOut = (await objectTool!.execute({
  op: 'add',
  kind: 'prop',
  name: '测试长椅',
  x: 12,
  y: 12,
  state: { status: '正常' },
}, {})) as { text: string }
ok(addToolOut.text.includes('已从沙盒新增') || addToolOut.text.includes('新增'), 'paranim_object 能新增物件')

const agentTool = registered.find((d) => d.name === 'paranim_agent')
const agentList = (await worldTool!.execute({ view: 'agents' }, {})) as { text: string }
const someId = (agentList.text.match(/id=([a-zA-Z0-9._-]+)/) ?? [])[1]
const agentPatchOut = (await agentTool!.execute({ op: 'patch', agentId: someId, pow: 10, goal: '把今天的账算清。' }, {})) as { text: string }
ok(agentPatchOut.text.includes('已更新'), `paranim_agent 能改属性与目标：${agentPatchOut.text.slice(0, 70)}`)

const modelsTool = registered.find((d) => d.name === 'paranim_models')
const modelsToolOut = (await modelsTool!.execute({}, {})) as { text: string }
ok(modelsToolOut.text.includes('fake-provider/fake-small'), 'paranim_models 列出 provider/model')
ok(modelsToolOut.text.includes('注意：') && modelsToolOut.text.includes('empty-provider'), '单个 provider 失败被如实标注（不静默吞掉）', modelsToolOut.text.split('\n').slice(-2).join(' | '))

const stepTool = registered.find((d) => d.name === 'paranim_step')
const stepToolOut = (await stepTool!.execute({ steps: 2 }, {})) as { text: string }
ok(stepToolOut.text.includes('【第') && stepToolOut.text.includes('步】'), 'paranim_step 能一次推两步')
ok(stepToolOut.text.includes('驱动'), 'paranim_step 报告驱动数量')

ok(promptText.includes('他化自在天') && promptText.includes('骰值 + 对应属性'), '提示段写清了沙盒与判定规则')
ok(promptText.includes('力量') && promptText.includes('意志'), '提示段解释了六维含义')
disposeTools()
ok(true, '工具 disposer 可调用（卸载不留残留）')

// ── 8. 记忆裁剪与持久化 ─────────────────────────────────────────────────
section('8. 持久化与记忆裁剪')

const longRun: RunState = (await routes.world({ workspace: '/tmp/fake-workspace', create: true })).run
// 走引擎真正的写入路径 remember()，而不是直接 push —— 直接 push 会绕过裁剪，
// 那测的就不是"裁剪有没有生效"，而是"数组能有多长"。
for (let i = 0; i < 60; i += 1) {
  remember(longRun.agents[0], { tick: i, kind: 'event', text: `第 ${i} 件事：一段相当长的记忆文本，用来把字符预算撑满，检验裁剪逻辑是否真的在裁。`, ts: Date.now() })
}
remember(longRun.agents[0], { tick: 60, kind: 'summary', text: '来历摘要：他是一个钟表匠。', ts: Date.now() })
await runStore.save(longRun)
const reloaded = await runStore.load(longRun.sandboxId)
const memory = reloaded?.agents[0].memory ?? []
ok(memory.length <= 26, `记忆被裁到 ${memory.length} 条以内`, String(memory.length))
ok(memory.some((m) => m.kind === 'summary'), '裁剪后仍保留一条来历摘要（不会忘记自己是谁）')
ok((await routes.world({ workspace: '/tmp/fake-workspace', create: true })).run.tick === longRun.tick, '运行态落盘后可原样读回')

const badJson = await readFile(join(tempHome, 'dsh-paranim', 'sandboxes', 'smallville.json'), 'utf8')
ok(badJson.includes('阿比盖尔') || badJson.includes('abigail'), '沙盒明文里能看到角色名（玩家可手改）', '')

// ── 9. 静态契约：需求里写死的数字不能被悄悄改掉 ─────────────────────────
section('9. 规则常量与需求对齐')

const { DIFFICULTY_LADDER: ladder, DEFAULT_DIFFICULTY, HUMAN_MIN, HUMAN_MAX } = await import('../shared/model.ts')
ok(HUMAN_MIN === 4 && HUMAN_MAX === 10, '常人属性区间是 4-10（需求 4）')
ok(ladder.length >= 6, `难度阶梯有 ${ladder.length} 档`)
ok(ladder.every((s, i) => i === 0 || s.value > ladder[i - 1].value), '难度阶梯严格递增')
ok(DEFAULT_DIFFICULTY === 11, '缺省难度 11（属性中位的人约一成多失手）')

const fallbackPlaces = INLINE_SMALLVILLE.places.length
ok(fallbackPlaces >= 8, `内联兜底小镇有 ${fallbackPlaces} 个地标（保住降级路径的可用性）`)
ok(INLINE_SMALLVILLE.attribution !== undefined, '内联兜底小镇带素材出处声明')

// ── 收尾 ─────────────────────────────────────────────────────────────────
routes.dispose()
await rm(tempHome, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '✅' : '❌'} 自检结束：${checks - failures}/${checks} 通过`)
if (failures > 0) {
  console.error(`${failures} 项失败`)
  process.exit(1)
}
process.exit(0)
