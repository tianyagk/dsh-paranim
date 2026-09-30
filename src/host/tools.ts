/**
 * dsh-paranim — 模型可见的沙盒工具 + 提示段。
 *
 * 工具与侧边栏是**同一份数据的两条入口**：界面点一次和模型调一次落到同一个
 * 宿主 store 与引擎上，不存在第二套状态。所有写操作都注明"谁做的"（`by`），
 * 使事件流里能区分「玩家右键改的」和「模型改的」。
 *
 * 工具在 `tools` 服务缺席时整体不注册（不是抛错），界面路由照旧可用。
 */
import {
  ATTR_IDS,
  ATTR_LABEL,
  DIFFICULTY_LADDER,
  OBJECT_KIND_LABEL,
  MOOD_DEFAULT,
  MOOD_MAX,
  normalizeAttrs,
  normalizeMood,
  shortId,
  toStateValue,
  type Sandbox,
  type StateValue,
  type WorldObject,
} from '../shared/model.ts'
import { distance, findObject } from '../shared/rules.ts'
import { issueDirective, listModelChoices } from './engine.ts'
import { normalizeObject } from './store.ts'
import type { ParanimRoutes } from './routes.ts'
import type { PluginLlm, PluginSystemPrompt, PluginToolDefinition, PluginToolRuntime } from './context.ts'
import { log } from './context.ts'

const PREFIX = 'paranim_'

function text(value: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: value }]
}

function objectSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      kind: { type: 'string' },
      x: { type: 'number' },
      y: { type: 'number' },
      desc: { type: 'string' },
      state: {},
      interactive: { type: 'boolean' },
    },
  }
}

const optionalWorkspace = {
  workspace: { type: 'string', description: '工作区路径；缺省用当前会话的工作区（决定运行态分桶）' },
  sandboxId: { type: 'string', description: '沙盒 id；缺省用当前沙盒' },
}

export interface ToolDeps {
  routes: ParanimRoutes
  /** 当前会话的工作区（工具默认作用域）。 */
  currentWorkspace?: () => string | undefined
  /** 沙盒库（与界面共用同一个 store 实例）。 */
  store: {
    list: (force?: boolean) => Promise<Sandbox[]>
    get: (id: string) => Promise<Sandbox | undefined>
    save: (sandbox: Sandbox) => Promise<Sandbox>
    remove: (id: string) => Promise<void>
    duplicate: (id: string, newId: string, name?: string) => Promise<Sandbox>
  }
  /** 宿主 llm 服务（列可用模型用；缺席时降级为默认模型单条）。 */
  llm: () => PluginLlm | undefined
  /** 宿主默认模型路由。 */
  defaultRoute: () => { provider: string; model: string } | undefined
}

export function makeTools(deps: ToolDeps): {
  register: (tools: PluginToolRuntime, prompt: PluginSystemPrompt | undefined) => () => void
} {
  const defs: PluginToolDefinition[] = []

  const workspaceOf = (args: Record<string, unknown>): string | undefined =>
    typeof args.workspace === 'string' && args.workspace !== '' ? args.workspace : deps.currentWorkspace?.()

  const stateText = (state: Record<string, StateValue>): string =>
    Object.entries(state)
      .map(([k, v]) => `${k}=${v === null ? '—' : Array.isArray(v) ? v.join('/') : String(v)}`)
      .join(' ')

  const renderObject = (o: WorldObject): string =>
    `- ${o.name}（id=${o.id}｜${OBJECT_KIND_LABEL[o.kind] ?? o.kind}｜@${o.x},${o.y}）${o.desc === undefined ? '' : ` ${o.desc}`}${Object.keys(o.state).length === 0 ? '' : `\n    状态：${stateText(o.state)}`}${o.lastEditedBy === undefined ? '' : `（最后改动：${o.lastEditedBy}）`}`

  // ── 1) 查看沙盒与运行态 ────────────────────────────────────────────────
  defs.push({
    name: `${PREFIX}world`,
    description:
      '读取「他化自在天」多智能体沙盒的状态：地图尺寸、地标与物件（含各自的状态槽）、' +
      '当前在跑的智能体（六维属性 STR/CON/DEX/APP/INT/POW、坐标、所在位置、计划、最近经历）、' +
      '世界级状态与最近的事件流。只读。' +
      'Triggers: 看沙盒/小镇现状, 智能体在哪, 某盏灯的状态, 沙盒里有什么, 他化自在天状态.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...optionalWorkspace,
        /** 只看某类内容。 */
        view: { type: 'string', description: 'world 地图 | agents 智能体 | events 事件流 | all（默认 all）' },
        events: { type: 'number', description: '事件流返回条数（默认 20，上限 200）' },
        agentId: { type: 'string', description: '只看这一个智能体的详情' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
    },
    async execute(args) {
      const view = await deps.routes.world({
        workspace: workspaceOf(args),
        sandboxId: typeof args.sandboxId === 'string' ? args.sandboxId : undefined,
        create: true,
      })
      const which = typeof args.view === 'string' ? args.view : 'all'
      const lines: string[] = []
      if (which === 'world' || which === 'all') {
        lines.push(`【沙盒】${view.sandbox.name}（id=${view.sandbox.id}，${view.sandbox.map.width}×${view.sandbox.map.height}）第 ${view.run.tick} 步`)
        if (view.sandbox.attribution !== undefined) lines.push(`素材出处：${view.sandbox.attribution}${view.sandbox.license === undefined ? '' : `（${view.sandbox.license}）`}`)
        const worldState = stateText(view.run.worldState)
        lines.push(`世界状态：${worldState === '' ? '（无）' : worldState}`)
        lines.push(`步进：${view.step.mode === 'auto' ? `自动（每 ${Math.round(view.step.intervalMs / 1000)} 秒）` : '手动'}｜自动循环：${view.stepper.running ? '运转中' : '停'}${view.stepper.error === undefined ? '' : `（上次出错：${view.stepper.error}）`}`)
        lines.push('')
        lines.push(`【地标】${view.sandbox.places.length} 处`)
        lines.push(...view.sandbox.places.map(renderObject))
        lines.push('')
        lines.push(`【物件】${view.sandbox.objects.length} 件`)
        lines.push(...view.sandbox.objects.map(renderObject))
      }
      if (which === 'agents' || which === 'all' || typeof args.agentId === 'string') {
        const list = typeof args.agentId === 'string' ? view.run.agents.filter((a) => a.id === args.agentId) : view.run.agents
        lines.push('')
        lines.push(`【智能体】${view.run.agents.length} 个${typeof args.agentId === 'string' ? `（筛选中 ${list.length} 个）` : ''}`)
        for (const agent of list) {
          const attrs = ATTR_IDS.map((id) => `${ATTR_LABEL[id]}${agent.attrs[id]}`).join(' ')
          const at = [...view.sandbox.places, ...view.sandbox.objects]
            .map((o) => ({ o, d: distance(o.x, o.y, agent.x, agent.y) }))
            .filter((x) => x.d <= 6)
            .sort((a, b) => a.d - b.d)[0]
          lines.push(`- ${agent.name}（id=${agent.id}｜${agent.concept}｜@${agent.x},${agent.y}${at === undefined ? '' : `，在${at.o.name}旁`}）`)
          lines.push(`    属性：${attrs}`)
          lines.push(`    ${agent.model === null || agent.model === undefined ? '驱动模型：跟随宿主默认' : `驱动模型：${agent.model.provider}/${agent.model.model}`}｜已走 ${agent.stepsTaken} 步`)
          if (agent.appearance !== '') lines.push(`    外貌：${agent.appearance}`)
          if (agent.persona !== '') lines.push(`    性格：${agent.persona}`)
          if (agent.goal !== '') lines.push(`    想要的：${agent.goal}`)
          const mood = normalizeMood(agent.mood ?? MOOD_DEFAULT)
          lines.push(`    心情：${mood.label} ${mood.value}/${MOOD_MAX}`)
          const lastThought = [...agent.memory].reverse().find((m) => m.kind === 'thought')
          if (lastThought !== undefined) lines.push(`    此刻在想：${lastThought.text}`)
          if (agent.plan.length > 0) lines.push(`    计划：${agent.plan.join(' → ')}`)
          if (agent.inventory.length > 0) lines.push(`    随身：${agent.inventory.join('、')}`)
          const memory = agent.memory.filter((m) => m.kind !== 'summary').slice(-5)
          if (memory.length > 0) lines.push(`    最近：${memory.map((m) => m.text).join(' / ')}`)
        }
      }
      if (which === 'events' || which === 'all') {
        const limit = Math.min(200, Math.max(1, Number(args.events ?? 20)))
        const events = view.run.events.slice(-limit)
        lines.push('')
        lines.push(`【最近 ${events.length} 条事件】`)
        lines.push(...events.map((e) => `[${e.tick}] ${e.text}${e.roll === undefined ? '' : `（判定：D6=${e.roll.roll} + ${e.roll.attrValue ?? '?'} = ${e.roll.total} vs ${e.roll.difficulty} → ${e.roll.ok === true ? '成功' : '失败'}${e.roll.decisive === true ? '·恒定' : ''}）`}`))
      }
      return { text: lines.join('\n') }
    },
  })

  // ── 2) 步进 ────────────────────────────────────────────────────────────
  defs.push({
    name: `${PREFIX}step`,
    description:
      '推进「他化自在天」沙盒的世界：每个在跑的智能体各自走一步（自己决定去做什么，' +
      '有失败可能的行动先掷 1D6 + 属性 ≥ 难度再叙事）。可一次推进多步。' +
      '智能体没有指定模型时用宿主默认模型；模型不可用则按计划与眼前情形行动（不会停摆）。' +
      'Triggers: 推进世界/走一步/让小镇动起来/看智能体自己会做什么, 沙盒步进.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...optionalWorkspace,
        steps: { type: 'number', description: '推进多少步（默认 1，上限 10）' },
        maxAgents: { type: 'number', description: '本步最多驱动几个智能体（默认用步进设置）' },
        persist: { type: 'boolean', description: '是否落盘（默认 true）' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
      render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
    },
    async execute(args, exec) {
      const steps = Math.min(10, Math.max(1, Math.round(Number(args.steps ?? 1))))
      const lines: string[] = []
      for (let i = 0; i < steps; i += 1) {
        if (exec?.signal?.aborted === true) {
          lines.push('（已中止）')
          break
        }
        const result = await deps.routes.step({
          workspace: workspaceOf(args),
          sandboxId: typeof args.sandboxId === 'string' ? args.sandboxId : undefined,
          persist: args.persist !== false,
          maxAgents: args.maxAgents === undefined ? undefined : Number(args.maxAgents),
          // 工具层不复用 runTick：一步的解析（沙盒 + 运行态 + 默认路由 + 定时器）
          // 只该有一处，散成两份就会出现"界面走的路能用、工具走的路不能用"。
        })
        lines.push(`【第 ${result.tick} 步】驱动 ${result.driven} 个智能体`)
        for (const outcome of result.outcomes) {
          lines.push(`- ${outcome.agentName}：${outcome.source === 'model' ? '' : '（降级）'}${outcome.detail}`)
        }
        lines.push(...result.events.map((e) => `  · ${e.text}`))
        lines.push('')
      }
      lines.push('（界面：侧边栏「他化自在天」页签可看到地图、事件流与每个智能体的记忆）')
      return { text: lines.join('\n') }
    },
  })

  // ── 3) 指令：引导某个智能体去做什么 ─────────────────────────────────────
  defs.push({
    name: `${PREFIX}direct`,
    description:
      '给某个智能体下一条指令：它会在下一步把这条指令当成必须立刻执行的吩咐，' +
      '优先级高于自己的计划，并留下记忆。用于用户通过指令引导智能体在世界中行动。' +
      'Triggers: 让某人去做什么, 引导智能体, 命令 NPC, 给智能体下指令, 指使小镇里的角色.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...optionalWorkspace,
        agentId: { type: 'string', description: '目标智能体 id（用 paranim_world 查）' },
        text: { type: 'string', description: '指令内容，如"去咖啡馆找阿比盖尔打听昨天夜里的事"' },
      },
      required: ['agentId', 'text'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
      render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
    },
    async execute(args) {
      const workspace = workspaceOf(args)
      const view = await deps.routes.world({ workspace, sandboxId: typeof args.sandboxId === 'string' ? args.sandboxId : undefined, create: true })
      const directive = issueDirective(view.run, String(args.agentId ?? ''), String(args.text ?? ''))
      await deps.routes.persistRun({ workspace, sandboxId: view.sandbox.id })
      log('directive issued', directive.agentId, directive.text)
      return {
        text: `已把指令交给 ${view.run.agents.find((a) => a.id === args.agentId)?.name ?? args.agentId}：「${directive.text}」\n它会在下一次步进时执行。用 paranim_step 推进世界即可看到结果。`,
      }
    },
  })

  // ── 4) 改物体状态（需求 5 的工具面）─────────────────────────────────────
  defs.push({
    name: `${PREFIX}object`,
    description:
      '修改沙盒里某个地标/物件的状态或属性：状态槽（如把路灯的 status 改成"故障"、lit 改成 false）、' +
      '改名、改坐标、改描述、开关注交互。改动会写进事件流并保留最后改动者。' +
      'Triggers: 把路灯改成故障, 改物体状态, 锁上门, 移动座椅, 新增物件到沙盒.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...optionalWorkspace,
        op: { type: 'string', description: 'patch 改已有（默认）｜add 新增｜remove 删除' },
        objectId: { type: 'string', description: '目标物件的 id（add 时可省略，自动生成）' },
        kind: { type: 'string', description: 'add 时用：place 地标｜prop 物件｜fixture 设施｜vehicle 载具｜plant 草木｜sign 标识' },
        name: { type: 'string' },
        desc: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        color: { type: 'string', description: '#rrggbb' },
        interactive: { type: 'boolean' },
        state: { type: 'object', additionalProperties: true, description: '要覆盖的状态键值；值为 null 表示删除该键' },
        by: { type: 'string', description: '改动者署名（默认"模型"）' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
      render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
    },
    async execute(args) {
      const workspace = workspaceOf(args)
      const view = await deps.routes.world({ workspace, sandboxId: typeof args.sandboxId === 'string' ? args.sandboxId : undefined, create: true })
      const op = typeof args.op === 'string' ? args.op : 'patch'
      const sandbox = view.sandbox

      if (op === 'remove') {
        const id = String(args.objectId ?? '')
        const inPlaces = sandbox.places.findIndex((o) => o.id === id)
        const inObjects = sandbox.objects.findIndex((o) => o.id === id)
        if (inPlaces < 0 && inObjects < 0) throw new Error(`找不到物件 ${id}`)
        const target = inPlaces >= 0 ? sandbox.places.splice(inPlaces, 1)[0] : sandbox.objects.splice(inObjects, 1)[0]
        view.run.events.push({
          id: `ev-${Date.now().toString(36)}`,
          tick: view.run.tick,
          ts: Date.now(),
          kind: 'system',
          actor: 'gm',
          actorName: String(args.by ?? '模型'),
          text: `${String(args.by ?? '模型')}把「${target.name}」从沙盒里移除了。`,
          targetId: target.id,
        })
        await deps.store.save(sandbox)
        return { text: `已从沙盒移除「${target.name}」（id=${target.id}）。` }
      }

      if (op === 'add') {
        const kindRaw = String(args.kind ?? 'prop')
        const bucket = kindRaw === 'place' ? sandbox.places : sandbox.objects
        const parsed = normalizeObject(
          {
            id: typeof args.objectId === 'string' && args.objectId !== '' ? args.objectId : undefined,
            name: args.name ?? '未命名物件',
            kind: kindRaw,
            x: args.x ?? Math.round(sandbox.map.width / 2),
            y: args.y ?? Math.round(sandbox.map.height / 2),
            color: args.color,
            desc: args.desc,
            state: args.state ?? {},
            interactive: args.interactive !== false,
          },
          sandbox.map.width,
          sandbox.map.height,
          kindRaw === 'place' ? 'place' : 'prop',
          `${kindRaw === 'place' ? 'place' : 'obj'}-${shortId('x').split('-')[1]}`,
        )
        if (parsed === undefined) throw new Error('新增物件缺少合法 id')
        bucket.push(parsed)
        view.run.events.push({
          id: `ev-${Date.now().toString(36)}`,
          tick: view.run.tick,
          ts: Date.now(),
          kind: 'system',
          actor: 'gm',
          actorName: String(args.by ?? '模型'),
          text: `${String(args.by ?? '模型')}在 (${parsed.x},${parsed.y}) 放下了「${parsed.name}」。`,
          targetId: parsed.id,
        })
        await deps.store.save(sandbox)
        return { text: `已在沙盒新增「${parsed.name}」（id=${parsed.id}，${OBJECT_KIND_LABEL[parsed.kind] ?? parsed.kind}，@${parsed.x},${parsed.y}）。` }
      }

      const objectId = String(args.objectId ?? '')
      if (objectId === '') throw new Error('patch 需要 objectId（用 paranim_world 查 id）')
      const target = findObject(sandbox, objectId)
      if (target === undefined) throw new Error(`找不到物件 ${objectId}`)
      const before: string[] = []
      if (typeof args.name === 'string' && args.name !== '' && args.name !== target.name) {
        before.push(`名称「${target.name}」→「${args.name}」`)
        target.name = args.name
      }
      if (typeof args.desc === 'string') target.desc = args.desc
      if (typeof args.color === 'string') target.color = args.color
      if (typeof args.interactive === 'boolean') target.interactive = args.interactive
      if (typeof args.x === 'number' && Number.isFinite(args.x)) target.x = Math.round(args.x)
      if (typeof args.y === 'number' && Number.isFinite(args.y)) target.y = Math.round(args.y)
      if (args.state !== null && typeof args.state === 'object' && !Array.isArray(args.state)) {
        for (const [key, raw] of Object.entries(args.state as Record<string, unknown>)) {
          const value = raw === null ? null : toStateValue(raw)
          if (value === undefined) throw new Error(`状态「${key}」的值类型不支持`)
          const previous = target.state[key] ?? null
          if (previous === value) continue
          if (value === null) delete target.state[key]
          else target.state[key] = value
          before.push(`${key}「${previous === null ? '（无）' : String(previous)}」→「${value === null ? '（清除）' : String(value)}」`)
        }
      }
      if (before.length === 0) return { text: `「${target.name}」没有任何变化（传入的字段与现值相同）。` }
      const by = String(args.by ?? '模型')
      target.lastEditedBy = by
      target.lastEditedAt = Date.now()
      view.run.events.push({
        id: `ev-${Date.now().toString(36)}`,
        tick: view.run.tick,
        ts: Date.now(),
        kind: 'mutate',
        actor: 'gm',
        actorName: by,
        text: `${by}把「${target.name}」的 ${before.join('，')}。`,
        targetId: target.id,
      })
      await deps.store.save(sandbox)
      return { text: `已修改「${target.name}」（id=${target.id}）：${before.join('，')}` }
    },
  })

  // ── 5) 改智能体（需求 3 的工具面）──────────────────────────────────────
  defs.push({
    name: `${PREFIX}agent`,
    description:
      '在沙盒里新增/修改/移除智能体：外貌、性格、来历、想要什么、六维属性' +
      '（4-10 是常人区间）、驱动模型、计划、随身物品、坐标。新增的智能体会立刻加入当前推演，' +
      '并写回沙盒模板（下次开局仍在）。' +
      'Triggers: 加一个小镇居民, 改某个智能体的性格, 设置它的属性, 指定它的驱动模型, 让它离场.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...optionalWorkspace,
        op: { type: 'string', description: 'add 新增｜patch 修改（默认）｜remove 离场' },
        agentId: { type: 'string', description: 'patch/remove 时必填' },
        name: { type: 'string' },
        concept: { type: 'string', description: '身份/职业' },
        appearance: { type: 'string' },
        persona: { type: 'string' },
        backstory: { type: 'string' },
        goal: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        str: { type: 'number' },
        con: { type: 'number' },
        dex: { type: 'number' },
        app: { type: 'number' },
        int: { type: 'number' },
        pow: { type: 'number' },
        mood: { type: 'number', description: '心情指数 0–10（同时给出 moodLabel 更准）' },
        moodLabel: { type: 'string', description: '心情的词，如 开心 / 烦躁 / 疲惫' },
        model: { type: 'string', description: '驱动模型，格式 provider/model（用 paranim_models 查）；留空表示跟随宿主默认' },
        plan: { type: 'array', items: { type: 'string' } },
        inventory: { type: 'array', items: { type: 'string' } },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
      render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
    },
    async execute(args) {
      const workspace = workspaceOf(args)
      const view = await deps.routes.world({ workspace, sandboxId: typeof args.sandboxId === 'string' ? args.sandboxId : undefined, create: true })
      const op = typeof args.op === 'string' ? args.op : 'patch'
      const run = view.run

      const modelFromArg = (): { provider: string; model: string } | null | undefined => {
        if (typeof args.model !== 'string') return undefined
        const raw = args.model.trim()
        if (raw === '' || raw === 'default') return null
        const [provider, ...rest] = raw.split('/')
        if (provider === undefined || rest.length === 0) throw new Error('model 参数格式应为 provider/model')
        return { provider, model: rest.join('/') }
      }

      if (op === 'remove') {
        const agentId = String(args.agentId ?? '')
        const index = run.agents.findIndex((a) => a.id === agentId)
        if (index < 0) throw new Error(`找不到智能体 ${agentId}`)
        const [gone] = run.agents.splice(index, 1)
        run.events.push({
          id: `ev-${Date.now().toString(36)}`, tick: run.tick, ts: Date.now(), kind: 'despawn',
          actor: 'gm', actorName: '世界', text: `${gone.name}离开了这座小镇。`,
        })
        await deps.routes.persistRun({ workspace, sandboxId: view.sandbox.id })
        return { text: `${gone.name} 已离场（当前 ${run.agents.length} 个智能体）。` }
      }

      const attrs: Record<string, number> = {}
      for (const id of ATTR_IDS) {
        const value = args[id]
        if (typeof value === 'number' && Number.isFinite(value)) attrs[id] = value
      }

      if (op === 'add') {
        const name = String(args.name ?? '').trim()
        if (name === '') throw new Error('新增智能体需要 name')
        const id = `agent-${Date.now().toString(36).slice(-6)}`
        const route = modelFromArg()
        const agent = {
          id,
          name,
          concept: String(args.concept ?? '居民'),
          appearance: String(args.appearance ?? ''),
          persona: String(args.persona ?? ''),
          backstory: String(args.backstory ?? ''),
          goal: String(args.goal ?? ''),
          x: typeof args.x === 'number' ? Math.round(args.x) : Math.round(view.sandbox.map.width / 2),
          y: typeof args.y === 'number' ? Math.round(args.y) : Math.round(view.sandbox.map.height / 2),
          attrs: normalizeAttrs(attrs),
          model: route ?? null,
          plan: Array.isArray(args.plan) ? args.plan.filter((v): v is string => typeof v === 'string').slice(0, 24) : [],
          inventory: Array.isArray(args.inventory) ? args.inventory.filter((v): v is string => typeof v === 'string').slice(0, 24) : [],
          color: '#7aa2f7',
          portrait: '🙂',
          spawnTick: run.tick,
          origin: 'user' as const,
          memory: [{ tick: run.tick, kind: 'summary' as const, text: String(args.backstory ?? `${name}刚刚来到镇上。`), ts: Date.now() }],
          lastUpdateTick: run.tick,
          stepsTaken: 0,
        }
        run.agents.push(agent)
        run.events.push({
          id: `ev-${Date.now().toString(36)}`, tick: run.tick, ts: Date.now(), kind: 'spawn',
          actor: 'gm', actorName: '世界', text: `${name}（${agent.concept}）加入了小镇。`, targetAgentId: id,
        })
        const template = view.sandbox.agents.find((a) => a.id === id)
        const { spawnTick, origin, memory, lastUpdateTick, stepsTaken, ...pure } = agent
        void spawnTick; void origin; void memory; void lastUpdateTick; void stepsTaken
        if (template === undefined) view.sandbox.agents.push(pure)
        else Object.assign(template, pure)
        await deps.store.save(view.sandbox)
        await deps.routes.persistRun({ workspace, sandboxId: view.sandbox.id })
        const attrText = ATTR_IDS.map((k) => `${ATTR_LABEL[k]}${agent.attrs[k]}`).join(' ')
        return { text: `已加入「${name}」（id=${id}，${agent.concept}）@${agent.x},${agent.y}\n属性：${attrText}\n驱动模型：${route === null || route === undefined ? '跟随宿主默认' : `${route.provider}/${route.model}`}` }
      }

      const agentId = String(args.agentId ?? '')
      const agent = run.agents.find((a) => a.id === agentId)
      if (agent === undefined) throw new Error(`找不到智能体 ${agentId}（用 paranim_world view=agents 查 id）`)
      const changed: string[] = []
      for (const key of ['name', 'concept', 'appearance', 'persona', 'backstory', 'goal'] as const) {
        if (typeof args[key] === 'string' && args[key] !== '') {
          if ((agent as unknown as Record<string, string>)[key] !== args[key]) {
            changed.push(`${key}：「${String((agent as unknown as Record<string, string>)[key] ?? '')}」→「${String(args[key])}」`)
            ;(agent as unknown as Record<string, string>)[key] = String(args[key])
          }
        }
      }
      if (typeof args.x === 'number' && Number.isFinite(args.x)) { agent.x = Math.round(args.x); changed.push(`x=${agent.x}`) }
      if (typeof args.y === 'number' && Number.isFinite(args.y)) { agent.y = Math.round(args.y); changed.push(`y=${agent.y}`) }
      if (typeof args.mood === 'number' || typeof args.moodLabel === 'string') {
        const next = normalizeMood({
          value: typeof args.mood === 'number' ? args.mood : (agent.mood ?? MOOD_DEFAULT).value,
          label: typeof args.moodLabel === 'string' ? args.moodLabel : (agent.mood ?? MOOD_DEFAULT).label,
        })
        changed.push(`心情 ${next.label} ${next.value}/${MOOD_MAX}`)
        agent.mood = next
      }
      if (Object.keys(attrs).length > 0) {
        const next = normalizeAttrs({ ...agent.attrs, ...attrs })
        changed.push(ATTR_IDS.map((k) => `${ATTR_LABEL[k]}${agent.attrs[k]}→${next[k]}`).join(' '))
        agent.attrs = next
      }
      if (Array.isArray(args.plan)) { agent.plan = args.plan.filter((v): v is string => typeof v === 'string').slice(0, 24); changed.push(`计划 ${agent.plan.length} 条`) }
      if (Array.isArray(args.inventory)) { agent.inventory = args.inventory.filter((v): v is string => typeof v === 'string').slice(0, 24); changed.push(`随身 ${agent.inventory.length} 件`) }
      const route = modelFromArg()
      if (route !== undefined) {
        agent.model = route
        changed.push(`驱动模型 → ${route === null ? '跟随宿主默认' : `${route.provider}/${route.model}`}`)
      }
      if (changed.length === 0) return { text: `${agent.name} 没有任何变化。` }
      const template = view.sandbox.agents.find((a) => a.id === agent.id)
      const { spawnTick, origin, memory, lastUpdateTick, stepsTaken, ...pure } = agent
      void spawnTick; void origin; void memory; void lastUpdateTick; void stepsTaken
      if (template === undefined) view.sandbox.agents.push(pure)
      else Object.assign(template, pure)
      await deps.store.save(view.sandbox)
      await deps.routes.persistRun({ workspace, sandboxId: view.sandbox.id })
      return { text: `已更新「${agent.name}」：${changed.join('，')}` }
    },
  })

  // ── 6) 沙盒库管理 ──────────────────────────────────────────────────────
  defs.push({
    name: `${PREFIX}sandbox`,
    description:
      '管理「他化自在天」的世界沙盒：列出全部沙盒、载入某个、另存为副本、新建空沙盒、' +
      '把当前运行态导出回沙盒（把智能体此刻的位置/改动固化进设定）、重置运行态回开局。' +
      'Triggers: 换一个沙盒, 保存沙盒, 载入沙盒, 新建小镇, 有哪些世界沙盒, 重置小镇.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...optionalWorkspace,
        op: {
          type: 'string',
          description: 'list 列表（默认）｜select 载入｜duplicate 另存副本｜create 新建空沙盒｜fromRun 运行态导出回沙盒｜reset 重置运行态',
        },
        id: { type: 'string', description: '目标沙盒 id' },
        newId: { type: 'string', description: 'duplicate 时的副本 id' },
        name: { type: 'string', description: 'create/duplicate 时的名字' },
        desc: { type: 'string' },
        count: { type: 'number', description: 'reset 时带几个智能体开局（缺省全带）' },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
      render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
    },
    async execute(args) {
      const workspace = workspaceOf(args)
      const op = typeof args.op === 'string' ? args.op : 'list'
      if (op === 'list') {
        const list = await deps.store.list(true)
        const current = await deps.routes.world({ workspace, create: true })
        return {
          text: [
            `沙盒库（${list.length} 个，当前：${current.sandbox.id}）`,
            ...list.map((s) => `- ${s.name}（id=${s.id}${s.builtin === true ? '｜发货镜像' : ''}）：${s.places.length} 地标 / ${s.objects.length} 物件 / ${s.agents.length} 智能体\n    ${s.desc}${s.attribution === undefined ? '' : `\n    出处：${s.attribution}（${s.license ?? '许可见素材索引'}）`}`),
          ].join('\n'),
        }
      }
      if (op === 'select') {
        const id = String(args.id ?? '')
        const view = await deps.routes.world({ workspace, sandboxId: id, create: true })
        return { text: `已载入「${view.sandbox.name}」（${view.sandbox.map.width}×${view.sandbox.map.height}，${view.sandbox.places.length} 地标，${view.agentCount} 智能体在跑）。当前第 ${view.run.tick} 步。` }
      }
      if (op === 'duplicate') {
        const id = String(args.id ?? '')
        const copy = await deps.store.duplicate(id, String(args.newId ?? `${id}-copy`), typeof args.name === 'string' ? args.name : undefined)
        return { text: `已另存副本「${copy.name}」（id=${copy.id}）。要切过去就用 paranim_sandbox op=select id=${copy.id}。` }
      }
      if (op === 'create') {
        const name = String(args.name ?? '新沙盒')
        const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
        const id = String(args.id ?? '') !== '' ? String(args.id) : (slug === '' ? `sandbox-${Date.now().toString(36)}` : slug)
        const created = await deps.store.save({
          v: 1,
          id,
          name,
          desc: String(args.desc ?? '空沙盒：自己摆一座镇。'),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          map: { width: 120, height: 90, ground: '#1f2430' },
          places: [],
          objects: [],
          relations: [],
          agents: [],
        })
        return { text: `已新建空沙盒「${created.name}」（id=${created.id}）。用 paranim_object op=add 放地标与物件，用 paranim_agent op=add 放居民。` }
      }
      if (op === 'reset') {
        const view = await deps.routes.resetRun({
          workspace,
          sandboxId: typeof args.id === 'string' ? args.id : undefined,
          count: args.count === undefined ? undefined : Number(args.count),
        })
        return { text: `已重置「${view.sandbox.name}」的推演：回到第 ${view.run.tick} 步，沙盒设定未动，${view.agentCount} 个智能体重新入场。自动步进已停止。` }
      }
      // fromRun：把运行态折回沙盒设定
      const view = await deps.routes.world({ workspace, sandboxId: typeof args.id === 'string' ? args.id : undefined, create: true })
      const next: Sandbox = {
        ...view.sandbox,
        agents: view.run.agents.map((a) => {
          const { spawnTick, origin, memory, lastUpdateTick, stepsTaken, ...pure } = a
          void spawnTick; void origin; void memory; void lastUpdateTick; void stepsTaken
          return pure
        }),
      }
      const saved = await deps.store.save(next)
      return { text: `已把当前推演（第 ${view.run.tick} 步，${view.run.agents.length} 个智能体）导出回沙盒「${saved.name}」：位置、外貌、性格、属性、模型与物品都已固化。` }
    },
  })

  // ── 7) 查模型与角色名册 ────────────────────────────────────────────────
  defs.push({
    name: `${PREFIX}models`,
    description:
      '列出 DSH 当前可用的驱动模型（provider/model），以及沙盒里每个智能体正在用哪个。' +
      '改模型用 paranim_agent 的 model 参数（格式 provider/model）。' +
      'Triggers: 有哪些模型可用, 这个智能体用什么模型, 换模型驱动.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { ...optionalWorkspace },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { text: { type: 'string' } } },
      render: (_args, value) => text(String((value as { text?: string }).text ?? '')),
    },
    async execute() {
      const choices = await listModelChoices(deps.llm(), deps.defaultRoute())
      const lines = [
        `可用驱动模型（来源：${choices.source === 'live' ? '宿主 llm 服务' : '降级为默认模型'}）`,
        ...choices.models.map((m) => `- ${m.provider}/${m.model}（${m.providerName} · ${m.modelName}）${m.isDefault ? ' ← 宿主默认' : ''}${m.description === undefined ? '' : `\n    ${m.description}`}`),
      ]
      if (choices.error !== undefined) lines.push('', `注意：${choices.error}`)
      if (choices.models.length === 0) lines.push('（没有任何可用模型——请在设置里配置 provider，或让智能体跟随宿主默认）')
      return { text: lines.join('\n') }
    },
  })

  // 难度阶梯也附在提示段里，避免模型每次凭感觉编一个难度。
  const difficultyLine = DIFFICULTY_LADDER.map((d) => `${d.id}=${d.label}(${d.value})`).join(' / ')

  return {
    register(tools, prompt) {
      const disposers: Array<() => void> = []
      for (const def of defs) {
        try {
          disposers.push(tools.register(def))
        } catch (error) {
          log('tool register failed:', def.name, String(error))
        }
      }
      if (prompt !== undefined) {
        try {
          disposers.push(
            prompt.section({
              name: 'paranim',
              order: 120,
              text: () =>
                [
                  '## 他化自在天（dsh-paranim）：多智能体沙盒',
                  '',
                  '宿主里跑着一个可编辑的多智能体小镇沙盒（默认是复刻斯坦福 Smallville 的镜像）。',
                  '侧边栏「他化自在天」页签是它的界面：地图、事件流、每个智能体的记忆、右键改物体状态、手动/自动步进。',
                  '',
                  `- \`${PREFIX}world\` 看现状（地标/物件状态、智能体六维与记忆、事件流）`,
                  `- \`${PREFIX}step\` 推进世界（每个智能体自己决定行动，先掷骰再叙事）`,
                  `- \`${PREFIX}direct\` 下达指令：用一句话引导某个智能体去做什么`,
                  `- \`${PREFIX}object\` 改物体状态（如把路灯改成「故障」、新增/移除物件）`,
                  `- \`${PREFIX}agent\` 增改智能体（外貌/性格/来历/六维/驱动模型/计划），或让它离场`,
                  `- \`${PREFIX}sandbox\` 管理沙盒（列表/载入/另存/新建/把运行态导回设定）`,
                  `- \`${PREFIX}models\` 看可用驱动模型`,
                  '',
                  '判定规则（沙盒里的一切行动都走它）：掷 1 枚 D6，**骰值 + 对应属性 ≥ 难度** 即成功；',
                  '1 恒失败、6 恒成功；对抗时双方各掷一次比较「骰值 + 属性」，平手判防守方收益。',
                  `难度阶梯：${difficultyLine}。`,
                  '六维含义：力量 STR（体力对抗）· 体质 CON（耐受与持久）· 敏捷 DEX（手巧、闪避、赶路）·',
                  '外貌 APP（第一印象、社交）· 智力 INT（知识、推理、观察）· 意志 POW（精神对抗、抗压）。',
                  '',
                  '沙盒数据是明文 JSON（`~/.dsh/dsh-paranim/`：`sandboxes/` 是设定，`runs/<工作区>/` 是运行态），',
                  '玩家可以直接改文件；改了以后用 `paranim_world` 重新读一遍即可，不要凭记忆叙述旧状态。',
                ].join('\n'),
            }),
          )
        } catch (error) {
          log('prompt section failed:', String(error))
        }
      }
      return () => {
        for (const dispose of disposers) {
          try {
            dispose()
          } catch {
            /* 已经释放 */
          }
        }
      }
    },
  }
}
