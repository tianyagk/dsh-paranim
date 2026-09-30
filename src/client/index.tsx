/**
 * dsh-paranim（他化自在天）— 浏览器半边。
 *
 * 通过 `ctx.betterSidebar` 服务注册「他化自在天」页签（与 dsh-better-sidebar
 * 自带的 8 个 tab 走同一套 API）。页签里是：
 *   · 小镇地图（左键看智能体 / **右键改物体状态**）
 *   · 沙盒库（载入 / 另存 / 新建 / 重置回出厂镜像）
 *   · 智能体编排（数量、外貌、性格、六维、驱动模型、计划、神谕）
 *   · 事件流（每条判定带骰面与难度）
 *   · 步进控制（手动步进 / 自动步进 + 时间流速）
 *
 * 状态在**宿主**（沙盒库、运行态、计时器都在 node 半边），这里只持有视图缓存，
 * 所以关掉页面再打开，小镇还在原来的步数上。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ATTR_EN,
  ATTR_IDS,
  ATTR_LABEL,
  DEFAULT_STEP_CONFIG,
  DIFFICULTY_LADDER,
  HUMAN_MAX,
  HUMAN_MIN,
  OBJECT_KIND_LABEL,
  STEP_INTERVAL_MAX,
  STEP_INTERVAL_MIN,
  normalizeAttrs,
  type AttrId,
  type ModelChoice,
  type RunAgent,
  type SandboxAgent,
  type StateValue,
  type WorldEvent,
} from '../shared/model.ts'
import { createApi, type ParanimApi, type SandboxSummary, type WorldView } from './api.ts'
import { MapCanvas } from './MapCanvas.tsx'
import { ensureCss } from './styles.ts'

/** 注册进 betterSidebar 的描述符（结构面，见 dsh-better-sidebar 的 TabDescriptor）。 */
interface SidebarTabDescriptor {
  id: string
  title: string | (() => string)
  description?: string | (() => string)
  icon?: React.ReactNode | ((size: number) => React.ReactNode)
  order?: number
  single?: boolean
  component: (props: TabProps) => React.ReactNode
}

interface BetterSidebarService {
  registerTab(descriptor: SidebarTabDescriptor): () => void
}

interface TabProps {
  ctx?: unknown
  store?: unknown
  scope: { sessionId?: string; cwd?: string }
  tab: { id: string; type: string }
  /** 该页签是否可见且面板已展开（不可见时暂停轮询）。 */
  visible: boolean
}

export const name = 'dsh-paranim'

/** 硬依赖：没有 betterSidebar 就没地方画。 */
export const inject = ['betterSidebar']

export function apply(ctx: {
  betterSidebar: BetterSidebarService
  effect(fn: () => void | (() => void), label?: string): void
}): void {
  const disposeCss = ensureCss()
  try {
    console.log(`[dsh-paranim] client v${__PA_VERSION__} loaded`)
  } catch {
    /* console 不可用 */
  }
  ctx.effect(() => {
    const disposeTab = ctx.betterSidebar.registerTab({
      id: 'dsh-paranim',
      title: () => '他化自在天',
      description: () => '可编辑的多智能体小镇沙盒：地图、智能体编排、右键改物体状态、手动/自动步进',
      icon: (size: number): React.ReactNode =>
        React.createElement('span', { style: { fontSize: Math.round(size * 0.76), lineHeight: 1 } }, '🏙️'),
      order: 62,
      single: true,
      component: (props: TabProps): React.ReactNode => React.createElement(ParanimApp, props),
    })
    return () => {
      disposeTab()
      disposeCss()
    }
  }, 'dsh-paranim: 他化自在天 tab')
}

type PageKey = 'world' | 'agents' | 'sandbox' | 'events'

// ── 应用外壳 ──────────────────────────────────────────────────────────────

function ParanimApp(props: TabProps): React.ReactElement {
  const visible = props.visible !== false
  const scope = useMemo(
    () => ({ workspace: props.scope?.cwd, sessionId: props.scope?.sessionId }),
    [props.scope?.cwd, props.scope?.sessionId],
  )
  const scopeRef = useRef(scope)
  scopeRef.current = scope
  const api = useMemo<ParanimApi>(() => createApi(() => scopeRef.current), [])

  const [page, setPage] = useState<PageKey>('world')
  const [world, setWorld] = useState<WorldView | null>(null)
  const [sandboxes, setSandboxes] = useState<SandboxSummary[]>([])
  const [models, setModels] = useState<ModelChoice[]>([])
  const [modelsNote, setModelsNote] = useState<string>('')
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [notice, setNotice] = useState<string>('')
  const [directive, setDirective] = useState<string>('')

  const applyWorld = useCallback((next: WorldView) => {
    setWorld(next)
    setSelected((current) => {
      if (current !== undefined && next.run.agents.some((a) => a.id === current)) return current
      return next.run.agents[0]?.id
    })
  }, [])

  const refresh = useCallback(async () => {
    try {
      const next = await api.world()
      applyWorld(next)
      setError('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [api, applyWorld])

  // 首次加载：沙盒库 + 模型目录 + 世界
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [list, choices] = await Promise.all([api.sandboxes(), api.models()])
        if (!alive) return
        setSandboxes(list.sandboxes)
        setModels(choices.models)
        setModelsNote(choices.source === 'live' ? (choices.error === undefined ? '' : `部分 provider 取模型失败：${choices.error}`) : `模型目录降级：${choices.error ?? '无可用 provider'}`)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      }
      void refresh()
    })()
    return () => {
      alive = false
    }
  }, [api, refresh])

  // 轮询：页签不可见时停（省掉看不见的流量），可见时按流速自适应
  useEffect(() => {
    if (!visible) return
    const period = world?.stepper.running === true ? Math.max(1500, Math.min(4000, world.stepper.intervalMs)) : 4000
    const timer = setInterval(() => void refresh(), period)
    return () => clearInterval(timer)
  }, [visible, refresh, world?.stepper.running, world?.stepper.intervalMs])

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>): Promise<void> => {
      setBusy(label)
      setError('')
      try {
        await action()
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setBusy('')
      }
    },
    [],
  )

  const flash = (text: string): void => {
    setNotice(text)
    window.setTimeout(() => setNotice((current) => (current === text ? '' : current)), 3200)
  }

  if (world === null) {
    return React.createElement(
      'div',
      { className: 'pa-root', style: { padding: 12 } },
      React.createElement('div', null, '正在装载他化自在天…'),
      error === '' ? null : React.createElement('div', { className: 'pa-err', style: { marginTop: 6 } }, error),
    )
  }

  const sandbox = world.sandbox
  const agents = world.run.agents
  const agent = agents.find((a) => a.id === selected)
  const agentView = agents.map((a) => ({ id: a.id, name: a.name, x: a.x, y: a.y, color: a.color, portrait: a.portrait, concept: a.concept }))

  return React.createElement(
    'div',
    { className: 'pa-root' },
    // ── 顶栏 ────────────────────────────────────────────────────────────
    React.createElement(
      'div',
      { className: 'pa-head' },
      React.createElement(
        'div',
        { className: 'pa-tabs' },
        ...[
          { key: 'world' as PageKey, label: '世界', title: '地图与事件流' },
          { key: 'agents' as PageKey, label: '智能体', title: '编排智能体：外貌/性格/六维/驱动模型/神谕' },
          { key: 'sandbox' as PageKey, label: '世界沙盒', title: '载入 / 另存 / 新建 / 重置沙盒' },
          { key: 'events' as PageKey, label: '事件流', title: '每一件事与每一次判定' },
        ].map((tab) =>
          React.createElement('button', { key: tab.key, className: 'pa-tab', 'data-on': page === tab.key, title: tab.title, onClick: () => setPage(tab.key) }, tab.label),
        ),
      ),
      React.createElement('span', { className: 'pa-chip' }, `第 ${world.run.tick} 步`),
      React.createElement('span', { className: 'pa-chip' }, `${agents.length} 智能体`),
      React.createElement('span', { className: 'pa-chip' }, sandbox.name),
      React.createElement('span', { className: 'pa-spacer' }),
      React.createElement('button', { className: 'pa-btn', onClick: () => void refresh() }, '刷新'),
    ),
    // ── 主体 ────────────────────────────────────────────────────────────
    React.createElement(
      'div',
      { className: 'pa-body' },
      React.createElement(MapCanvas, {
        sandbox,
        agents: agentView,
        selectedId: selected,
        onSelectAgent: (id: string) => {
          setSelected(id)
          setPage('agents')
        },
        onPatchObject: (objectId: string, body: Record<string, unknown>) =>
          void run('改物体', async () => {
            const result = await api.object({ objectId, ...body })
            applyWorld(result.world)
            flash(`已修改：${result.changes.join('，')}`)
          }),
        onRemoveObject: (objectId: string) =>
          void run('删物体', async () => {
            applyWorld(await api.mapObject({ op: 'remove', id: objectId, kind: sandbox.objects.some((o) => o.id === objectId) ? 'prop' : 'place' }))
            flash('已从沙盒移除该物体')
          }),
      }),
      React.createElement(
        'div',
        { className: 'pa-side pa-col' },
        page === 'world'
          ? React.createElement(WorldPage, { world, onSelect: (id) => { setSelected(id); setPage('agents') } })
          : page === 'agents'
            ? React.createElement(AgentsPage, {
                world,
                models,
                modelsNote,
                selected,
                onSelect: setSelected,
                busy,
                api,
                run,
                applyWorld,
                flash,
              })
            : page === 'sandbox'
              ? React.createElement(SandboxPage, {
                  world,
                  sandboxes,
                  busy,
                  api,
                  run,
                  applyWorld,
                  setSandboxes,
                  flash,
                })
              : React.createElement(EventsPage, { world, selected }),
      ),
    ),
    // ── 底栏：步进控制 + 神谕 + 状态 ────────────────────────────────────
    React.createElement(
      'div',
      { className: 'pa-foot' },
      React.createElement(
        'div',
        { className: 'pa-line' },
        React.createElement(
          'button',
          {
            className: 'pa-btn',
            'data-primary': 'true',
            disabled: busy !== '',
            onClick: () =>
              void run('手动步进', async () => {
                const result = await api.step()
                applyWorld(result.world)
                flash(`第 ${result.tick} 步完成：驱动 ${result.driven} 个智能体，产生 ${result.events.length} 条事件`)
              }),
          },
          busy === '手动步进' ? '步进中…' : '手动步进',
        ),
        React.createElement(
          'button',
          {
            className: 'pa-btn',
            disabled: busy !== '',
            onClick: () =>
              void run('自动步进', async () => {
                const auto = !world.stepper.running
                applyWorld(await api.stepConfig({ mode: auto ? 'auto' : 'manual', intervalMs: world.stepper.intervalMs }))
                flash(auto ? `自动步进已开启（每 ${Math.round(world.stepper.intervalMs / 1000)} 秒一步）` : '自动步进已停止')
              }),
          },
          world.stepper.running ? '⏸ 停止自动步进' : '▶ 自动步进',
        ),
        React.createElement('span', { className: 'pa-dim' }, '时间流速'),
        React.createElement('input', {
          type: 'range',
          min: STEP_INTERVAL_MAX,
          max: STEP_INTERVAL_MIN,
          step: 1000,
          // 反向滑杆：往右 = 更快 = 间隔更小。写成 min=2000/max=600000 的直向滑杆，
          // "往右拖"会变成"变慢"，与直觉相反。
          value: STEP_INTERVAL_MAX + STEP_INTERVAL_MIN - world.stepper.intervalMs,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
            const intervalMs = STEP_INTERVAL_MAX + STEP_INTERVAL_MIN - Number(event.target.value)
            setWorld((current) => (current === null ? current : { ...current, stepper: { ...current.stepper, intervalMs } }))
            void run('流速', async () => {
              applyWorld(await api.stepConfig({ intervalMs }))
            })
          },
        }),
        React.createElement('span', { className: 'pa-mono' }, `${(world.stepper.intervalMs / 1000).toFixed(1)}s/步`),
        React.createElement('span', { className: 'pa-dim' }, world.stepper.running ? (world.stepper.inFlight ? '· 正在推进一步' : `· 自动运转中（已自动走 ${world.stepper.ticks} 步）`) : '· 手动模式'),
        world.stepper.error === undefined ? null : React.createElement('span', { className: 'pa-err' }, `· 上次自动步进出错：${world.stepper.error}`),
      ),
      React.createElement(
        'div',
        { className: 'pa-line' },
        React.createElement('span', { className: 'pa-dim' }, `神谕 → ${agent?.name ?? '（先选一个智能体）'}`),
        React.createElement('input', {
          type: 'text',
          placeholder: '用一句话指引它，例如：去咖啡馆找阿比盖尔打听昨天夜里的事',
          value: directive,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDirective(event.target.value),
          onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key !== 'Enter' || directive.trim() === '' || agent === undefined) return
            const text = directive.trim()
            void run('神谕', async () => {
              const result = await api.directive(agent.id, text)
              applyWorld(result.world)
              setDirective('')
              flash(`神谕已下达：${text}`)
            })
          },
        }),
        React.createElement(
          'button',
          {
            className: 'pa-btn',
            disabled: agent === undefined || directive.trim() === '',
            onClick: () => {
              if (agent === undefined) return
              const text = directive.trim()
              void run('神谕', async () => {
                const result = await api.directive(agent.id, text)
                applyWorld(result.world)
                setDirective('')
                flash(`神谕已下达：${text}`)
              })
            },
          },
          '下达神谕',
        ),
        React.createElement('span', { className: 'pa-spacer' }),
        busy === '' ? null : React.createElement('span', { className: 'pa-dim' }, `${busy}…`),
        notice === '' ? null : React.createElement('span', { className: 'pa-notice pa-ok' }, notice),
        error === '' ? null : React.createElement('span', { className: 'pa-err' }, error),
      ),
    ),
  )
}

// ── 页 1：世界（地图说明 + 近期事件 + 世界状态）────────────────────────────

function WorldPage(props: { world: WorldView; onSelect: (id: string) => void }): React.ReactElement {
  const { world, onSelect } = props
  const recent = world.run.events.slice(-40).reverse()
  return React.createElement(
    'div',
    { className: 'pa-col', style: { height: '100%' } },
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement('h4', null, `${world.sandbox.name}`, React.createElement('span', { className: 'pa-chip' }, `${world.sandbox.map.width}×${world.sandbox.map.height}`)),
      React.createElement('div', { className: 'pa-dim' }, world.sandbox.desc),
      world.sandbox.attribution === undefined
        ? null
        : React.createElement('div', { className: 'pa-dim', style: { marginTop: 3 } }, `素材出处：${world.sandbox.attribution}${world.sandbox.license === undefined ? '' : ` · ${world.sandbox.license}`}`),
      React.createElement(
        'div',
        { className: 'pa-kv', style: { marginTop: 5 } },
        React.createElement('span', null, '地标'),
        React.createElement('span', null, `${world.sandbox.places.length} 处`),
        React.createElement('span', null, '物件'),
        React.createElement('span', null, `${world.sandbox.objects.length} 件`),
        React.createElement('span', null, '世界状态'),
        React.createElement('span', null, Object.entries(world.run.worldState).map(([k, v]) => `${k}=${String(v)}`).join(' ') || '（无）'),
      ),
    ),
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement('h4', null, `在场智能体（${world.run.agents.length}）`),
      React.createElement(
        'ul',
        { className: 'pa-list pa-scroll', style: { maxHeight: 200 } },
        ...world.run.agents.map((a) =>
          React.createElement(
            'li',
            { key: a.id, className: 'pa-item', onClick: () => onSelect(a.id) },
            React.createElement('span', { className: 'pa-portrait' }, a.portrait),
            React.createElement(
              'span',
              { className: 'pa-main' },
              React.createElement('b', null, a.name),
              React.createElement('span', { className: 'pa-chip' }, a.concept),
              React.createElement('div', { className: 'pa-dim' }, `@${a.x},${a.y}｜${a.model === undefined || a.model === null ? '默认模型' : a.model.model}｜已走 ${a.stepsTaken} 步`),
            ),
          ),
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'pa-sec pa-col', style: { flex: 1, minHeight: 0 } },
      React.createElement('h4', null, '最近发生的事'),
      React.createElement('div', { className: 'pa-scroll', style: { flex: 1 } }, ...recent.map((event) => React.createElement(EventRow, { key: event.id, event }))),
    ),
  )
}

// ── 页 2：智能体编排（需求 3）─────────────────────────────────────────────

interface AgentsPageProps {
  world: WorldView
  models: ModelChoice[]
  modelsNote: string
  selected?: string
  onSelect: (id: string) => void
  busy: string
  api: ParanimApi
  run: (label: string, action: () => Promise<unknown>) => Promise<void>
  applyWorld: (world: WorldView) => void
  flash: (text: string) => void
}

function AgentsPage(props: AgentsPageProps): React.ReactElement {
  const { world, models, modelsNote, selected, onSelect, api, run, applyWorld, flash } = props
  const agent = world.run.agents.find((a) => a.id === selected)
  return React.createElement(
    'div',
    { className: 'pa-col', style: { height: '100%' } },
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement(
        'h4',
        null,
        `智能体（${world.run.agents.length}）`,
        React.createElement('span', { className: 'pa-spacer' }),
        React.createElement(
          'button',
          {
            className: 'pa-btn',
            'data-tiny': 'true',
            onClick: () =>
              void run('新增智能体', async () => {
                const used = new Set(world.run.agents.map((a) => a.id))
                const templates = world.sandbox.agents.filter((t) => !used.has(t.id))
                const template: Partial<SandboxAgent> = templates[0] ?? {}
                const next = await api.agent({
                  op: 'add',
                  agent: {
                    name: template.name ?? `新居民 ${world.run.agents.length + 1}`,
                    concept: template.concept ?? '居民',
                    appearance: template.appearance ?? '（未描述）',
                    persona: template.persona ?? '（未设定）',
                    backstory: template.backstory ?? '',
                    goal: template.goal ?? '',
                    attrs: template.attrs ?? normalizeAttrs(undefined),
                    x: template.x ?? Math.round(world.sandbox.map.width / 2),
                    y: template.y ?? Math.round(world.sandbox.map.height / 2),
                    model: template.model ?? null,
                    plan: template.plan ?? [],
                    portrait: template.portrait ?? '🙂',
                    color: template.color ?? '#7aa2f7',
                  },
                })
                applyWorld(next)
                flash(templates.length > 0 ? `已把沙盒里待入场的「${template.name}」放进小镇` : '已新增一个居民，请在右侧填写它的设定')
              }),
          },
          '＋ 新增智能体',
        ),
      ),
      React.createElement(
        'ul',
        { className: 'pa-list pa-scroll', style: { maxHeight: 190 } },
        ...world.run.agents.map((a) =>
          React.createElement(
            'li',
            { key: a.id, className: 'pa-item', 'data-on': a.id === selected, onClick: () => onSelect(a.id) },
            React.createElement('span', { className: 'pa-portrait' }, a.portrait),
            React.createElement(
              'span',
              { className: 'pa-main' },
              React.createElement('b', null, a.name),
              React.createElement('span', { className: 'pa-chip' }, a.concept),
              a.origin === 'user' ? React.createElement('span', { className: 'pa-chip', 'data-tone': 'ok' }, '你加的') : null,
              React.createElement('div', { className: 'pa-dim' }, `@${a.x},${a.y}｜${a.model?.model ?? '默认模型'}`),
            ),
          ),
        ),
      ),
    ),
    agent === undefined
      ? React.createElement('div', { className: 'pa-sec pa-dim' }, '先选一个智能体，或点「新增智能体」。')
      : React.createElement(AgentEditor, {
          key: agent.id,
          world,
          agent,
          models,
          modelsNote,
          api,
          run,
          applyWorld,
          flash,
        }),
  )
}

function AgentEditor(props: {
  world: WorldView
  agent: RunAgent
  models: ModelChoice[]
  modelsNote: string
  api: ParanimApi
  run: (label: string, action: () => Promise<unknown>) => Promise<void>
  applyWorld: (world: WorldView) => void
  flash: (text: string) => void
}): React.ReactElement {
  const { world, agent, models, modelsNote, api, run, applyWorld, flash } = props
  const [draft, setDraft] = useState(() => ({
    name: agent.name,
    concept: agent.concept,
    appearance: agent.appearance,
    persona: agent.persona,
    backstory: agent.backstory,
    goal: agent.goal,
    fear: agent.fear,
    secret: agent.secret,
    attrs: { ...agent.attrs },
    model: agent.model === undefined || agent.model === null ? '' : `${agent.model.provider}/${agent.model.model}`,
    plan: agent.plan.join('\n'),
    inventory: agent.inventory.join('、'),
  }))
  const dirty = JSON.stringify(draft) !== JSON.stringify({
    name: agent.name,
    concept: agent.concept,
    appearance: agent.appearance,
    persona: agent.persona,
    backstory: agent.backstory,
    goal: agent.goal,
    fear: agent.fear,
    secret: agent.secret,
    attrs: agent.attrs,
    model: agent.model === undefined || agent.model === null ? '' : `${agent.model.provider}/${agent.model.model}`,
    plan: agent.plan.join('\n'),
    inventory: agent.inventory.join('、'),
  })

  const save = (): void => {
    void run('保存智能体', async () => {
      const next = await api.agent({
        op: 'patch',
        agentId: agent.id,
        patch: {
          name: draft.name,
          concept: draft.concept,
          appearance: draft.appearance,
          persona: draft.persona,
          backstory: draft.backstory,
          goal: draft.goal,
          fear: draft.fear,
          secret: draft.secret,
          attrs: draft.attrs,
          plan: draft.plan.split('\n').map((s) => s.trim()).filter((s) => s !== ''),
          inventory: draft.inventory.split(/[、,]/).map((s) => s.trim()).filter((s) => s !== ''),
          model: draft.model === '' ? null : (() => {
            const [provider, ...rest] = draft.model.split('/')
            return { provider, model: rest.join('/') }
          })(),
        },
      })
      applyWorld(next)
      flash(`${draft.name} 的设定已保存`)
    })
  }

  const field = (label: string, value: string, onChange: (v: string) => void, textarea = false): React.ReactElement =>
    React.createElement(
      React.Fragment,
      { key: label },
      React.createElement('label', null, label),
      textarea
        ? React.createElement('textarea', { value, onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value) })
        : React.createElement('input', { type: 'text', value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value) }),
    )

  const at = world.sandbox.places.find((p) => Math.hypot(p.x - agent.x, p.y - agent.y) <= (p.w ?? 0) / 2 && Math.hypot(p.x - agent.x, p.y - agent.y) <= (p.h ?? 0) / 2)

  return React.createElement(
    'div',
    { className: 'pa-sec pa-scroll', style: { flex: 1, minHeight: 0 } },
    React.createElement('h4', null, `${agent.portrait} ${agent.name}`, React.createElement('span', { className: 'pa-chip' }, agent.concept), React.createElement('span', { className: 'pa-chip' }, agent.origin === 'user' ? '你加的' : '沙盒自带')),
    React.createElement('div', { className: 'pa-dim' }, `@${agent.x},${agent.y}${at === undefined ? '' : `（${at.name}附近）`}｜已走 ${agent.stepsTaken} 步｜入场于第 ${agent.spawnTick} 步`),

    // 六维（需求 4）
    React.createElement('h4', { style: { marginTop: 8 } }, '六维属性', React.createElement('span', { className: 'pa-dim' }, `（常人 ${HUMAN_MIN}-${HUMAN_MAX}）`)),
    React.createElement(
      'div',
      { className: 'pa-attrs' },
      ...ATTR_IDS.map((id: AttrId) =>
        React.createElement(
          'div',
          { className: 'pa-attr', key: id, title: `${ATTR_EN[id]} 掷 1D6 + ${ATTR_LABEL[id]} ≥ 难度 即成功` },
          React.createElement('span', { className: 'pa-dim' }, `${ATTR_LABEL[id]} ${ATTR_EN[id]}`),
          React.createElement('input', {
            type: 'number',
            min: 1,
            max: 20,
            value: draft.attrs[id],
            style: { width: 44, background: 'var(--pa-layer-3)', color: 'var(--pa-text)', border: '1px solid var(--pa-border)', borderRadius: 4 },
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              setDraft((prev) => ({ ...prev, attrs: { ...prev.attrs, [id]: Math.max(1, Math.min(20, Number(event.target.value) || prev.attrs[id])) } })),
          }),
        ),
      ),
    ),
    React.createElement('div', { className: 'pa-grid2', style: { marginTop: 5 } },
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => setDraft((p) => ({ ...p, attrs: normalizeAttrs({ str: 7, con: 7, dex: 7, app: 7, int: 7, pow: 7 }) })) }, '设为平均 7'),
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => setDraft((p) => ({ ...p, attrs: normalizeAttrs({ str: roll(), con: roll(), dex: roll(), app: roll(), int: roll(), pow: roll() }) })) }, '随机掷一版'),
    ),

    // 驱动模型（需求 3）
    React.createElement('h4', { style: { marginTop: 10 } }, '驱动模型'),
    React.createElement('select', {
      value: draft.model,
      style: { width: '100%', background: 'var(--pa-layer-3)', color: 'var(--pa-text)', border: '1px solid var(--pa-border)', borderRadius: 5, padding: '3px 6px' },
      onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setDraft((prev) => ({ ...prev, model: event.target.value })),
    },
      React.createElement('option', { value: '' }, '跟随宿主默认模型'),
      ...models.map((m) => React.createElement('option', { key: `${m.provider}/${m.model}`, value: `${m.provider}/${m.model}` }, `${m.providerName} · ${m.modelName}${m.isDefault ? '（默认）' : ''}`)),
      draft.model !== '' && !models.some((m) => `${m.provider}/${m.model}` === draft.model)
        ? React.createElement('option', { value: draft.model }, `${draft.model}（不在当前目录）`)
        : null,
    ),
    modelsNote === '' ? null : React.createElement('div', { className: 'pa-dim', style: { marginTop: 3 } }, modelsNote),
    React.createElement('div', { className: 'pa-dim', style: { marginTop: 3 } }, '可用模型来自 DSH 当前已注册的 provider（`paranim_models` 工具同样能查）。'),

    // 外观与性格（需求 3）
    React.createElement('h4', { style: { marginTop: 10 } }, '外貌与性格'),
    React.createElement(
      'div',
      { className: 'pa-form' },
      field('姓名', draft.name, (v) => setDraft((p) => ({ ...p, name: v }))),
      field('身份', draft.concept, (v) => setDraft((p) => ({ ...p, concept: v }))),
      field('外貌', draft.appearance, (v) => setDraft((p) => ({ ...p, appearance: v }))),
      field('性格', draft.persona, (v) => setDraft((p) => ({ ...p, persona: v })), true),
      field('来历', draft.backstory, (v) => setDraft((p) => ({ ...p, backstory: v })), true),
      field('想要', draft.goal, (v) => setDraft((p) => ({ ...p, goal: v }))),
      field('害怕', draft.fear, (v) => setDraft((p) => ({ ...p, fear: v }))),
      field('瞒着', draft.secret, (v) => setDraft((p) => ({ ...p, secret: v }))),
      field('计划', draft.plan, (v) => setDraft((p) => ({ ...p, plan: v })), true),
      field('随身', draft.inventory, (v) => setDraft((p) => ({ ...p, inventory: v }))),
    ),
    React.createElement('div', { className: 'pa-dim', style: { marginTop: 3 } }, '计划：每行一条，智能体每走一步消耗一条。'),
    React.createElement('div', { className: 'pa-dim' }, '「瞒着」只写进它的提示词，不会出现在事件流里——但会左右它的选择。'),

    React.createElement(
      'div',
      { className: 'pa-line', style: { marginTop: 8 } },
      React.createElement('button', { className: 'pa-btn', 'data-primary': 'true', disabled: !dirty, onClick: save }, dirty ? '保存设定' : '已保存'),
      React.createElement(
        'button',
        { className: 'pa-btn', onClick: () => setDraft({ name: agent.name, concept: agent.concept, appearance: agent.appearance, persona: agent.persona, backstory: agent.backstory, goal: agent.goal, fear: agent.fear, secret: agent.secret, attrs: { ...agent.attrs }, model: agent.model === null || agent.model === undefined ? '' : `${agent.model.provider}/${agent.model.model}`, plan: agent.plan.join('\n'), inventory: agent.inventory.join('、') }) },
        '撤销改动',
      ),
      React.createElement('span', { className: 'pa-spacer' }),
      React.createElement(
        'button',
        { className: 'pa-btn', 'data-danger': 'true', onClick: () => void run('离场', async () => { applyWorld(await api.agent({ op: 'remove', agentId: agent.id })); flash(`${agent.name} 已离场`) }) },
        '让它离场',
      ),
    ),

    // 记忆与关系
    React.createElement('h4', { style: { marginTop: 10 } }, '记忆（最多 24 条 + 来历摘要）'),
    React.createElement('div', { className: 'pa-scroll', style: { maxHeight: 150 } },
      ...agent.memory.slice(-24).map((entry, index) =>
        React.createElement('div', { className: 'pa-mem', key: `${entry.tick}-${index}` },
          `[第 ${entry.tick} 步]${entry.kind === 'thought' ? '（心里）' : entry.kind === 'whisper' ? '（神谕）' : entry.kind === 'summary' ? '（来历）' : ''} ${entry.text}`),
      ),
    ),
    React.createElement('div', { className: 'pa-dim', style: { marginTop: 6 } },
      `与在场者的关系：${world.run.relations.filter((r) => r.a === agent.id || r.b === agent.id).map((r) => {
        const otherId = r.a === agent.id ? r.b : r.a
        const other = world.run.agents.find((a) => a.id === otherId)
        return `${other?.name ?? otherId} ${r.affinity > 0 ? '+' : ''}${r.affinity}`
      }).join('　') || '（还没有关系记录）'}`,
    ),
  )
}

/** 掷一枚 D6（1..6）——供随机建卡使用。 */
function d6(): number {
  return 1 + Math.floor(Math.random() * 6)
}

/**
 * 随机一版属性：以常人中位 7 为基准，一枚 D6 决定这几项的强弱走向。
 * 刻意**不**独立掷六次（那会得到一堆互不相关的数字，角色没有侧写），
 * 而是先掷一个"天赋偏向"，再在它周围抖动：这样的角色立刻能读出性格。
 */
function roll(): number {
  return 7 + d6() - 3
}

// ── 页 3：世界沙盒（需求 2）─────────────────────────────────────────────

function SandboxPage(props: {
  world: WorldView
  sandboxes: SandboxSummary[]
  busy: string
  api: ParanimApi
  run: (label: string, action: () => Promise<unknown>) => Promise<void>
  applyWorld: (world: WorldView) => void
  setSandboxes: (list: SandboxSummary[]) => void
  flash: (text: string) => void
}): React.ReactElement {
  const { world, sandboxes, api, run, applyWorld, setSandboxes, flash } = props
  const refreshList = async (): Promise<void> => {
    const list = await api.sandboxes()
    setSandboxes(list.sandboxes)
  }
  return React.createElement(
    'div',
    { className: 'pa-col', style: { height: '100%' } },
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement('h4', null, '世界沙盒', React.createElement('span', { className: 'pa-chip' }, `当前：${world.sandbox.id}`)),
      React.createElement('div', { className: 'pa-dim' }, '沙盒是明文 JSON，存在 `~/.dsh/dsh-paranim/sandboxes/`；运行态按工作区分桶存在 `runs/` 下。'),
      React.createElement(
        'div',
        { className: 'pa-line', style: { marginTop: 6 } },
        React.createElement(
          'button',
          { className: 'pa-btn', onClick: () => void run('保存沙盒', async () => { const name = window.prompt('沙盒名', world.sandbox.name); if (name === null) return; applyWorld(await api.sandbox({ action: 'save', name, fromRun: true })); flash('已保存（含当前推演中的智能体位置与设定）') }) },
          '保存当前沙盒',
        ),
        React.createElement(
          'button',
          { className: 'pa-btn', onClick: () => void run('另存副本', async () => { const name = window.prompt('副本名', `${world.sandbox.name} 副本`); if (name === null) return; applyWorld(await api.sandbox({ action: 'duplicate', id: world.sandbox.id, newId: `${world.sandbox.id}-copy`, name })); await refreshList(); flash('已另存副本，可以放心改了') }) },
          '另存为副本',
        ),
        React.createElement(
          'button',
          { className: 'pa-btn', onClick: () => void run('新建沙盒', async () => { const name = window.prompt('新沙盒名', '我的小镇'); if (name === null) return; applyWorld(await api.sandbox({ action: 'create', name })); await refreshList(); flash('已新建空沙盒') }) },
          '新建空沙盒',
        ),
        React.createElement(
          'button',
          { className: 'pa-btn', 'data-danger': 'true', onClick: () => void run('重置推演', async () => { const count = window.prompt('带几个智能体重新开局？（留空 = 全带）', ''); if (count === null) return; applyWorld(await api.reset(count.trim() === '' ? undefined : Number(count))); flash('已回到开局那天') }) },
          '重置推演',
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'pa-sec pa-scroll', style: { flex: 1, minHeight: 0 } },
      React.createElement('h4', null, `沙盒库（${sandboxes.length}）`),
      ...sandboxes.map((item) =>
        React.createElement(
          'div',
          { key: item.id, className: 'pa-item', 'data-on': item.id === world.sandbox.id },
          React.createElement('span', { className: 'pa-portrait' }, item.builtin ? '🏛️' : '🗺️'),
          React.createElement(
            'span',
            { className: 'pa-main' },
            React.createElement('b', null, item.name),
            item.builtin ? React.createElement('span', { className: 'pa-chip', 'data-tone': 'warn' }, '发货镜像') : null,
            React.createElement('div', { className: 'pa-dim' }, `${item.places} 地标 / ${item.objects} 物件 / ${item.agents} 智能体`),
            React.createElement('div', { className: 'pa-dim' }, item.desc),
            item.attribution === undefined ? null : React.createElement('div', { className: 'pa-dim' }, `素材：${item.attribution}${item.license === undefined ? '' : ` · ${item.license}`}`),
            React.createElement(
              'div',
              { className: 'pa-line', style: { marginTop: 4 } },
              React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => void run('载入沙盒', async () => { applyWorld(await api.sandbox({ action: 'select', id: item.id })); flash(`已载入「${item.name}」`) }) }, '载入'),
              React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => void run('另存副本', async () => { applyWorld(await api.sandbox({ action: 'duplicate', id: item.id, newId: `${item.id}-copy`, name: `${item.name} 副本` })); await refreshList() }) }, '派生副本'),
              item.builtin
                ? React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => void run('重置镜像', async () => { applyWorld(await api.sandbox({ action: 'reset', id: item.id })); flash('已恢复出厂镜像') }) }, '恢复出厂')
                : React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', 'data-danger': 'true', onClick: () => void run('删除沙盒', async () => { if (!window.confirm(`删除沙盒「${item.name}」？`)) return; applyWorld(await api.sandbox({ action: 'remove', id: item.id })); await refreshList() }) }, '删除'),
            ),
          ),
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement('h4', null, '物件库（右键地图上的物件也能改）'),
      React.createElement(
        'div',
        { className: 'pa-scroll', style: { maxHeight: 180 } },
        ...world.sandbox.objects.map((object) =>
          React.createElement(
            'div',
            { key: object.id, className: 'pa-item' },
            React.createElement('span', { className: 'pa-portrait' }, statusIcon(object.state.status)),
            React.createElement(
              'span',
              { className: 'pa-main' },
              React.createElement('b', null, object.name),
              React.createElement('span', { className: 'pa-chip' }, OBJECT_KIND_LABEL[object.kind] ?? object.kind),
              React.createElement('div', { className: 'pa-dim' }, Object.entries(object.state).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : String(v)}`).join('　') || '（无状态槽）'),
              React.createElement(
                'div',
                { className: 'pa-line', style: { marginTop: 3 } },
                ...quickActions(object, (state) =>
                  void run('改状态', async () => {
                    const result = await api.object({ objectId: object.id, state, by: '玩家' })
                    applyWorld(result.world)
                    flash(`${object.name}：${result.changes.join('，')}`)
                  }),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  )
}

function statusIcon(status: StateValue | undefined): string {
  const text = String(status ?? '正常')
  return text === '正常' ? '🔹' : text.includes('故障') || text.includes('损坏') ? '🔴' : '🟡'
}

/** 状态常见取值的快捷按钮（右键菜单给得更全，这里是一键改）。 */
function quickActions(object: { state: Record<string, StateValue> }, apply: (state: Record<string, StateValue>) => void): React.ReactElement[] {
  const out: React.ReactElement[] = []
  if (typeof object.state.status === 'string') {
    out.push(
      React.createElement('button', { key: 'toggle-status', className: 'pa-btn', 'data-tiny': 'true', onClick: () => apply({ status: String(object.state.status) === '正常' ? '故障' : '正常' }) },
        String(object.state.status) === '正常' ? '→ 设为故障' : '→ 修好'),
    )
  }
  for (const [key, value] of Object.entries(object.state)) {
    if (typeof value === 'boolean' && key !== 'status') {
      out.push(
        React.createElement('button', { key, className: 'pa-btn', 'data-tiny': 'true', onClick: () => apply({ [key]: !value }) }, `${key}: ${value ? '开' : '关'} → ${value ? '关' : '开'}`),
      )
    }
  }
  return out
}

// ── 页 4：事件流 ─────────────────────────────────────────────────────────

function EventsPage(props: { world: WorldView; selected?: string }): React.ReactElement {
  const { world, selected } = props
  const [only, setOnly] = useState<string>(selected ?? '')
  const [onlyRolls, setOnlyRolls] = useState(false)
  const events = world.run.events
    .filter((e) => (only === '' ? true : e.actor === only || e.targetAgentId === only))
    .filter((e) => (onlyRolls ? e.roll !== undefined : true))
    .slice(-260)
    .reverse()
  return React.createElement(
    'div',
    { className: 'pa-col', style: { height: '100%' } },
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement('h4', null, `事件流（${world.run.events.length} 条，显示最近 ${events.length}）`),
      React.createElement(
        'div',
        { className: 'pa-line' },
        React.createElement('select', {
          value: only,
          style: { background: 'var(--pa-layer-3)', color: 'var(--pa-text)', border: '1px solid var(--pa-border)', borderRadius: 5, padding: '2px 5px' },
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setOnly(event.target.value),
        },
          React.createElement('option', { value: '' }, '全部在场者'),
          ...world.run.agents.map((a) => React.createElement('option', { key: a.id, value: a.id }, a.name)),
        ),
        React.createElement('label', { className: 'pa-dim', style: { display: 'flex', gap: 4, alignItems: 'center' } },
          React.createElement('input', { type: 'checkbox', checked: onlyRolls, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setOnlyRolls(e.target.checked) }),
          '只看判定',
        ),
      ),
    ),
    React.createElement('div', { className: 'pa-scroll', style: { flex: 1, padding: '4px 8px' } },
      ...events.map((event) => React.createElement(EventRow, { key: event.id, event })),
    ),
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement('h4', null, '难度阶梯（1D6 + 属性 ≥ 难度 即成功）'),
      React.createElement(
        'div',
        { className: 'pa-dim' },
        ...DIFFICULTY_LADDER.map((step) => React.createElement('div', { key: step.id }, `${step.label}（${step.value}）：${step.desc}`)),
      ),
    ),
  )
}

function EventRow(props: { event: WorldEvent }): React.ReactElement {
  const { event } = props
  return React.createElement(
    'div',
    { className: 'pa-ev' },
    React.createElement('span', { className: 'pa-tick pa-mono' }, `#${event.tick}`),
    React.createElement(
      'span',
      { style: { flex: 1 } },
      React.createElement('span', null, `${kindIcon(event.kind)} ${event.text}`),
      event.roll === undefined
        ? null
        : React.createElement('div', { className: 'pa-roll pa-mono', 'data-ok': event.roll.ok === true }, `${event.roll.text}${event.roll.decisive === true ? '［恒定成败］' : ''}${event.roll.opponent === undefined ? '' : `（对手 ${event.roll.opponent} 掷 ${event.roll.opponentRoll} → ${event.roll.opponentTotal}）`}`),
    ),
  )
}

function kindIcon(kind: WorldEvent['kind']): string {
  switch (kind) {
    case 'move': return '🚶'
    case 'say': return '💬'
    case 'act': return '🎯'
    case 'mutate': return '🔧'
    case 'roll': return '🎲'
    case 'spawn': return '🌟'
    case 'despawn': return '👋'
    case 'directive': return '📣'
    default: return '·'
  }
}
