/**
 * dsh-paranim（他化自在天）— 浏览器半边。
 *
 * 通过 `ctx.betterSidebar` 服务注册「他化自在天」页签（与 dsh-better-sidebar
 * 自带的 8 个 tab 走同一套 API）。页签里是：
 *   · 小镇地图（左键看智能体 / **右键改物体状态**）
 *   · 沙盒库（载入 / 另存 / 新建 / 重置回出厂镜像）
 *   · 智能体编排（数量、外貌、性格、六维、驱动模型、计划、指令）
 *   · 事件流（每条判定带骰面与难度）
 *   · 步进控制（手动步进 / 自动步进 + 时间流速）
 *
 * 状态在**宿主**（沙盒库、运行态、计时器都在 node 半边），这里只持有视图缓存，
 * 所以关掉页面再打开，小镇还在原来的步数上。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  MOOD_DEFAULT,
  ATTR_EN,
  ATTR_IDS,
  ATTR_LABEL,
  DEFAULT_STEP_CONFIG,
  DIFFICULTY_LADDER,
  HUMAN_MAX,
  HUMAN_MIN,
  OBJECT_KIND_LABEL,
  STEP_INTERVAL_MAX,
  MOOD_MAX,
  STEP_INTERVAL_MIN,
  normalizeAttrs,
  type AttrId,
  type ModelChoice,
  type RunAgent,
  type SandboxAgent,
  type StateValue,
  type Tileset,
  type WorldEvent,
} from '../shared/model.ts'
import { createApi, type ParanimApi, type SandboxSummary, type WorldView } from './api.ts'
import { MapCanvas } from './MapCanvas.tsx'
import { tilesetImage } from './town.ts'
import { gridOf, LAYER_LABEL, makeTileRef, noteKey, objectsOf, positionOfObjectId, tileOrigin } from '../shared/tilemap.ts'
import {
  DEFAULT_FEED_MODE,
  DEFAULT_THEME,
  FEED_MODE_LABEL,
  THEMES,
  TONE_ICON,
  TONE_LABEL,
  segmentsOf,
  themeById,
  themeCss,
  toneOf,
  type FeedMode,
  type ThemeId,
} from './theme.ts'
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

/**
 * 当前想法：取最近一条"心里想的"记忆。
 * 与引擎同口径，且**派生而不新增字段**——thought 每步都写进 memory，再存一份
 * 就等于同一件事有两个真相来源，迟早对不上。
 */
function currentThought(agent: RunAgent): string | undefined {
  for (let i = agent.memory.length - 1; i >= 0; i -= 1) {
    const entry = agent.memory[i]
    if (entry.kind === 'thought' && entry.text.trim() !== '') return entry.text
  }
  return undefined
}

/**
 * 心情徽标，形式是「生气 4/10」：词给色彩、指数给高低。
 * 低于 4 偏红、7 以上偏绿——颜色比形容词更快看出状态。
 */
function MoodChip(props: { mood?: { value: number; label: string } }): React.ReactElement | null {
  if (props.mood === undefined) return null
  const { value, label } = props.mood
  const tone = value >= 7 ? 'ok' : value < 4 ? 'danger' : undefined
  return React.createElement('span', { className: 'pa-chip', 'data-tone': tone, title: `心情 ${value}/10` }, `${label} ${value}/10`)
}



// ── 应用外壳 ──────────────────────────────────────────────────────────────

function ParanimApp(props: TabProps): React.ReactElement {
  const visible = props.visible !== false
  /**
   * 「当前是哪个沙盒」必须进 scope。
   *
   * 曾经漏了这一项：载入沙盒只是把返回值放进本地 world，而 4 秒一次的轮询用
   * 不带 sandboxId 的请求去 /paranim/world，服务端按 `sandboxes[0]` 兜底——
   * 那是**按名字排序的第一个**（house），于是"载入别的镜像后过一会儿自动跳回 house"。
   * 这类"过一会儿自己变回去"的 bug，根源永远是某个后台刷新用了不完整的上下文。
   */
  const [sandboxId, setSandboxId] = useState<string | undefined>(undefined)
  const scope = useMemo(
    () => ({ workspace: props.scope?.cwd, sessionId: props.scope?.sessionId, sandboxId }),
    [props.scope?.cwd, props.scope?.sessionId, sandboxId],
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
  /**
   * 镜像编辑态：哪一层 + 笔刷材质 + 待放的物件贴图。
   *
   * 放在顶层而不是 SandboxPage 里，因为**地图**也要读——地图是 SandboxPage
   * 的兄弟节点，而不同层的落笔行为不同（background 涂抹 / object 放置）。
   */
  const [editLayer, setEditLayer] = useState<'background' | 'structure' | 'object'>('background')
  /**
   * 当前笔刷：一个瓦片引用（"图集:列,行"）。null = 橡皮；undefined = 未选。
   *
   * 三个图层共用同一种笔——选中的瓦片落在哪个图层，由 editLayer 决定。
   * 这与 Godot/Unity 的 tilemap 编辑一致：先选层，再选瓦片，然后画。
   */
  const [brushRef, setBrushRef] = useState<string | null | undefined>(undefined)
  const [busy, setBusy] = useState<string>('')
  const [error, setError] = useState<string>('')
  const [notice, setNotice] = useState<string>('')
  const [directive, setDirective] = useState<string>('')

  // 主题与消息模式：本地偏好，存 localStorage。
  // 为什么不做成宿主设置：这是**纯外观**选择，与沙盒/运行态无关，写进服务端
  // 会让它在换工作区时跟着"漂"；而且外观选项需要在切主题的瞬间就生效。
  const [themeId, setThemeId] = useState<ThemeId>(() => {
    try {
      const saved = window.localStorage.getItem('dsh-paranim.theme')
      return (THEMES.some((t) => t.id === saved) ? saved : DEFAULT_THEME) as ThemeId
    } catch {
      return DEFAULT_THEME
    }
  })
  const [feedMode, setFeedMode] = useState<FeedMode>(() => {
    try {
      const saved = window.localStorage.getItem('dsh-paranim.feedMode')
      return (saved === 'card' || saved === 'line' || saved === 'chat' ? saved : DEFAULT_FEED_MODE) as FeedMode
    } catch {
      return DEFAULT_FEED_MODE
    }
  })

  // 主题注入：把变量表写进 <style>，切主题只是换一份变量表，组件不动。
  useEffect(() => {
    const theme = themeById(themeId)
    const el = document.createElement('style')
    el.setAttribute('data-paranim', 'theme')
    el.textContent = themeCss(theme)
    document.head.append(el)
    try {
      window.localStorage.setItem('dsh-paranim.theme', themeId)
    } catch {
      /* 隐私模式下写不了，忽略 */
    }
    return () => el.remove()
  }, [themeId])

  useEffect(() => {
    try {
      window.localStorage.setItem('dsh-paranim.feedMode', feedMode)
    } catch {
      /* 同上 */
    }
  }, [feedMode])

  const applyWorld = useCallback((next: WorldView) => {
    // 后端返回什么就是什么：scope 里的 sandboxId 跟着它走，轮询才不会漂回默认沙盒。
    setSandboxId(next.sandbox.id)
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
          { key: 'agents' as PageKey, label: '智能体', title: '编排智能体：外貌/性格/六维/驱动模型/指令' },
          { key: 'sandbox' as PageKey, label: '世界沙盒', title: '载入 / 另存 / 新建 / 重置沙盒' },
          { key: 'events' as PageKey, label: '事件流', title: '每一件事与每一次判定' },
        ].map((tab) =>
          React.createElement('button', { key: tab.key, className: 'pa-tab', 'data-on': page === tab.key, title: tab.title, onClick: () => setPage(tab.key) }, tab.label),
        ),
      ),
      // 顶栏只留"随时想知道的那一个数"。沙盒名/地图尺寸/地标物件数都在「世界」页，
      // 顶栏再放一遍是把同一件事说两次，还挤掉了标签本身的空间。
      React.createElement('span', { className: 'pa-chip' }, `第 ${world.run.tick} 步 · ${agents.length} 人`),
      React.createElement('span', { className: 'pa-spacer' }),
      React.createElement('button', { className: 'pa-btn', onClick: () => void refresh() }, '刷新'),
    ),
    // ── 主体 ────────────────────────────────────────────────────────────
    React.createElement(
      'div',
      { className: 'pa-body' },
      React.createElement(MapCanvas, {
        sandbox,
        agents,
        events: world.run.events,
        tick: world.run.tick,
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
        /**
         * 只有【世界沙盒】页才给地图挂编辑能力。
         *
         * 【世界】页看的是正在跑的那个世界——在那里点地图是为了查看与改状态；
         * 而"把这一格刷成水泥"是对**镜像**的编辑，两者混在一起会让人误以为
         * 自己的一笔已经改变了正在推演的世界。
         *
         * 三个图层共用同一种落笔：**往格上放一个瓦片引用**（dropRef 为 null
         * 时是橡皮）。层与层的差别只在数据放哪一层，不在交互——这正是
         * Godot/Unity 的 tilemap 编辑逻辑。
         */
        onRemoveObject: (objectId: string) =>
          void run('移走', async () => {
            // 物件 id 就是格坐标（obj:x,y）——paint 一格 null 即清空那格
            const pos = positionOfObjectId(objectId)
            if (pos === undefined) {
              applyWorld(await api.place({ op: 'remove', id: objectId }))
            } else {
              applyWorld(await api.paint('object', null, [pos]))
            }
            flash(objectId.startsWith('obj:') ? '已把那一格清空' : '已移走')
          }),
        edit: page === 'sandbox' ? { layer: editLayer } : undefined,
        dropRef: page === 'sandbox' ? brushRef : undefined,
        /**
         * 拖动智能体：只在【智能体】页、且**已经选中了某一位**时生效。
         *
         * 不设这个前提的话，地图上点谁都开始拖，就没法点选别人了。
         * 落点由地图算成整格坐标（吸附网格），服务端还会再校验一次
         * 通行性与"那格有没有人"。
         */
        draggableAgentId: page === 'agents' ? selected : undefined,
        onMoveAgent: (id: string, x: number, y: number) =>
          void run('移动智能体', async () => {
            applyWorld(await api.agent({ op: 'patch', agentId: id, patch: { x, y } }))
            flash(`已把它挪到 (${x},${y})`)
          }),
        onPaint: (cells) => {
          if (cells.length === 0 || page !== 'sandbox') return
          // 还没选笔刷就涂 = 什么都画不上，只会让人以为编辑器坏了。
          // 宁可明确提示"先选一个瓦片"，也不静默无事发生。
          if (brushRef === undefined) {
            flash('还没选笔刷——先在「图集与瓦片注释」里点一个瓦片（或选橡皮）')
            return
          }
          void run(editLayer === 'object' ? '摆物件' : editLayer === 'structure' ? '砌墙' : '铺地面', async () => {
            applyWorld(await api.paint(editLayer, brushRef, cells))
          })
        },
      }),
      React.createElement(
        'div',
        { className: 'pa-side pa-col' },
        page === 'world'
          ? React.createElement(WorldPage, {
              world,
              feedMode,
              onSelect: (id) => { setSelected(id); setPage('agents') },
              busy,
              api,
              run,
              applyWorld,
              flash,
            })
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
                  editLayer,
                  setEditLayer,
                  brushRef,
                  setBrushRef,
                })
              : React.createElement(EventsPage, { world, selected, feedMode }),
      ),
    ),
    // ── 底栏：步进控制 + 指令 + 状态 ────────────────────────────────────
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
                /**
                 * 步进失败的细节必须看得见。
                 *
                 * 每个智能体的 outcome 里带着 source（'model' 还是降级）与
                 * detail（为什么），但此前界面只用它们数了个数——模型挂了、
                 * 输出不是合法 JSON 时，用户看到的仍是"第 N 步完成"，完全
                 * 不知道刚才那步其实没按预期走。
                 *
                 * 抛在 applyWorld 之后：世界照常更新，错误走 run() 的红色提示。
                 */
                const fell = result.outcomes.filter((o) => o.source !== 'model')
                if (fell.length > 0) {
                  throw new Error(
                    `第 ${result.tick} 步：${fell.length}/${result.outcomes.length} 位智能体没走成模型 —— `
                    + fell.map((o) => `${o.agentName}（${o.detail}）`).join('；'),
                  )
                }
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
        React.createElement('span', { className: 'pa-dim' }, `指令 → ${agent?.name ?? '（先选一个智能体）'}`),
        React.createElement('input', {
          type: 'text',
          placeholder: '用一句话指引它，例如：去咖啡馆找阿比盖尔打听昨天夜里的事',
          value: directive,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDirective(event.target.value),
          onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key !== 'Enter' || directive.trim() === '' || agent === undefined) return
            const text = directive.trim()
            void run('指令', async () => {
              const result = await api.directive(agent.id, text)
              applyWorld(result.world)
              setDirective('')
              flash(`指令已下达：${text}`)
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
              void run('指令', async () => {
                const result = await api.directive(agent.id, text)
                applyWorld(result.world)
                setDirective('')
                flash(`指令已下达：${text}`)
              })
            },
          },
          '下达指令',
        ),
        React.createElement('span', { className: 'pa-spacer' }),
        // 主题与消息模式放在底栏而不是设置页：调外观时要立刻看到结果。
        React.createElement(
          'div',
          { className: 'pa-picker', title: '主题风格：只换配色，不动布局' },
          React.createElement('span', { className: 'pa-dim' }, '主题'),
          React.createElement(
            'div',
            { className: 'pa-swatches' },
            ...THEMES.map((t) =>
              React.createElement(
                'button',
                {
                  key: t.id,
                  className: 'pa-swatch',
                  'data-on': t.id === themeId,
                  title: `${t.name} — ${t.hint}`,
                  onClick: () => setThemeId(t.id),
                  style: { background: t.vars.bg },
                },
                // 色点 + 短名：只给一个色块看不出哪套是哪套，"点一下试试"不是可发现性。
                React.createElement('i', { style: { background: t.vars.gold } }),
                React.createElement('b', { style: { color: t.vars.text } }, t.name.slice(0, 2)),
              ),
            ),
          ),
        ),
        React.createElement(
          'div',
          { className: 'pa-picker', title: '消息栏渲染方式：卡片 / 日志 / 对白' },
          React.createElement('span', { className: 'pa-dim' }, '消息'),
          React.createElement(
            'div',
            { className: 'pa-seg' },
            ...(['card', 'line', 'chat'] as FeedMode[]).map((m) =>
              React.createElement(
                'button',
                { key: m, 'data-on': m === feedMode, onClick: () => setFeedMode(m) },
                FEED_MODE_LABEL[m],
              ),
            ),
          ),
        ),
        // 版本标记：客户端包在插件装载时就读进内存，改了源码要重启 dsh 才换新版。
        // 没有它，"重启了但他看的是旧包"只能靠猜。
        React.createElement('span', {
          className: 'pa-dim pa-mono',
          title: '客户端包版本（改了源码需重启 dsh 才会换新版）',
        }, `v${__PA_VERSION__}`),
        busy === '' ? null : React.createElement('span', { className: 'pa-dim' }, `${busy}…`),
        notice === '' ? null : React.createElement('span', { className: 'pa-notice pa-ok' }, notice),
        error === '' ? null : React.createElement('span', { className: 'pa-err' }, error),
      ),
    ),
  )
}

// ── 页 1：世界（地图说明 + 近期事件 + 世界状态）────────────────────────────

function WorldPage(props: {
  world: WorldView
  feedMode: FeedMode
  onSelect: (id: string) => void
  busy: string
  api: ParanimApi
  run: (label: string, action: () => Promise<unknown>) => Promise<void>
  applyWorld: (world: WorldView) => void
  flash: (text: string) => void
}): React.ReactElement {
  const { world, feedMode, onSelect, busy, api, run, applyWorld, flash } = props
  /** 正在给谁写指令：临时输入框，发出去即清。 */
  const [sayTo, setSayTo] = React.useState<string | undefined>(undefined)
  const [sayText, setSayText] = React.useState('')
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
        React.createElement('span', null, `${objectsOf(world.sandbox.map).length} 件`),
        React.createElement('span', null, '世界状态'),
        React.createElement('span', null, Object.entries(world.run.worldState).map(([k, v]) => `${k}=${String(v)}`).join(' ') || '（无）'),
      ),
    ),
    React.createElement(
      'div',
      { className: 'pa-sec' },
    // ── 物件：这个世界的物件**此刻**是什么状态 ────────────────────────────
    //
    // 与沙盒页的"物件资源池"分工：那一页决定世界上**有哪些**物件，
    // 这一页改它们**当前怎么样**（亮着/坏了/锁着）——后者属于推演，不属于编辑。
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement(
        'h4',
        null,
        '物件状态',
        React.createElement('span', { className: 'pa-chip' }, `${objectsOf(world.sandbox.map).length} 件`),
      ),
      React.createElement('div', { className: 'pa-dim', style: { marginBottom: 5 } },
        '改的是这个世界的当前状态，会立刻写进事件流。'),
      React.createElement(
        'div',
        { className: 'pa-scroll', style: { maxHeight: 200 } },
        ...objectsOf(world.sandbox.map).slice(0, 40).map((object) =>
          React.createElement(
            'div',
            { key: object.id, className: 'pa-item' },
            React.createElement(
              'span',
              { className: 'pa-main' },
              React.createElement('b', null, object.name),
              React.createElement('span', { className: 'pa-dim pa-mono' }, `@${object.x},${object.y}`),
              React.createElement(
                'div',
                { className: 'pa-line', style: { marginTop: 3 } },
                ...Object.entries(object.state).map(([key, value]) =>
                  React.createElement('span', { key, className: 'pa-chip' }, `${key}=${String(value)}`),
                ),
                Object.keys(object.state).length === 0
                  ? React.createElement('span', { className: 'pa-dim' }, '（无状态槽）')
                  : null,
                React.createElement('span', { className: 'pa-spacer' }),
                React.createElement('button', {
                  className: 'pa-btn', 'data-tiny': 'true',
                  disabled: busy !== '',
                  onClick: () => void run('改状态', async () => {
                    const result = await api.object({ objectId: object.id, state: { status: (object.state.status === '故障' ? '正常' : '故障') } })
                    applyWorld(result.world)
                    flash(`${object.name}：${result.changes.join('，') || '状态已切换'}`)
                  }),
                }, '切换完好/故障'),
              ),
            ),
          ),
        ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement(
        'h4',
        null,
        '在场智能体',
        React.createElement('span', { className: 'pa-chip' }, `${world.run.agents.length} 位`),
      ),
      React.createElement('div', { className: 'pa-dim', style: { marginBottom: 5 } },
        '「指令」会插进它下一步的观察里，优先级高于它自己的计划。'),
      React.createElement(
        'ul',
        { className: 'pa-list pa-scroll', style: { maxHeight: 240 } },
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
              sayTo === a.id
                ? React.createElement(
                    'div',
                    { className: 'pa-line', style: { marginTop: 4 } },
                    React.createElement('input', {
                      autoFocus: true,
                      value: sayText,
                      placeholder: '要它去做什么？例：去咖啡馆打听昨晚的事',
                      style: { flex: 1, minWidth: 0 },
                      onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSayText(event.target.value),
                      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
                        if (event.key !== 'Enter' || sayText.trim() === '') return
                        const text = sayText.trim()
                        setSayText('')
                        setSayTo(undefined)
                        void run('下指令', async () => {
                          const result = await api.directive(a.id, text)
                          applyWorld(result.world)
                          flash(`已告诉${a.name}：${text}`)
                        })
                      },
                    }),
                    React.createElement('button', {
                      className: 'pa-btn', 'data-tiny': 'true',
                      disabled: busy !== '' || sayText.trim() === '',
                      onClick: () => {
                        const text = sayText.trim()
                        if (text === '') return
                        setSayText('')
                        setSayTo(undefined)
                        void run('下指令', async () => {
                          const result = await api.directive(a.id, text)
                          applyWorld(result.world)
                          flash(`已告诉${a.name}：${text}`)
                        })
                      },
                    }, '发出'),
                    React.createElement('button', {
                      className: 'pa-btn', 'data-tiny': 'true',
                      onClick: () => { setSayTo(undefined); setSayText('') },
                    }, '取消'),
                  )
                : null,
            ),
            sayTo === a.id
              ? null
              : React.createElement(
                  'span',
                  { className: 'pa-line' },
                  React.createElement('button', {
                    className: 'pa-btn', 'data-tiny': 'true',
                    title: '下一条指令：它下一步会把它当成脑子里必须立刻执行的声音',
                    onClick: () => { setSayTo(a.id); setSayText('') },
                  }, '指令'),
                ),
          ),
        ),
      ),
      ),
    ),
    React.createElement(
      'div',
      { className: 'pa-sec pa-col', style: { flex: 1, minHeight: 0 } },
      React.createElement('h4', null, '最近发生的事'),
      React.createElement(
        'div',
        { className: 'pa-scroll pa-feed', 'data-mode': feedMode, style: { flex: 1 } },
        ...recent.map((event) => React.createElement(EventRow, { key: event.id, event, mode: feedMode })),
      ),
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
              React.createElement(MoodChip, { mood: a.mood }),
              a.origin === 'user' ? React.createElement('span', { className: 'pa-chip', 'data-tone': 'ok' }, '你加的') : null,
              React.createElement('div', { className: 'pa-dim' }, `@${a.x},${a.y}｜${a.model?.model ?? '默认模型'}`),
              currentThought(a) === undefined
                ? null
                : React.createElement('div', { className: 'pa-thought', title: currentThought(a) }, `💭 ${currentThought(a)}`),
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

interface AgentDraft {
  name: string
  concept: string
  appearance: string
  persona: string
  backstory: string
  attrs: { str: number; con: number; dex: number; app: number; int: number; pow: number }
  model: string
  plan: string
  inventory: string
  /** 心情：词 + 指数。 */
  mood: { value: number; label: string }
  /** 当前想法——编辑它会往记忆里追一条 thought（见 currentThought 的取法）。 */
  thought: string
  /** 自定义外观（瓦片引用）；空串 = 用内置角色表。 */
  sprite: string
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
  // 草稿的重置逻辑只写一处：useState 初值与"撤销改动"按钮共用它。
  // 此前是两份内联对象字面量，加一个字段就得记得改两处（本次加 mood 时就漏了一处）。
  const draftReset = (): AgentDraft => ({
    name: agent.name,
    concept: agent.concept,
    appearance: agent.appearance,
    persona: agent.persona,
    backstory: agent.backstory,
      attrs: { ...agent.attrs },
    model: agent.model === undefined || agent.model === null ? '' : `${agent.model.provider}/${agent.model.model}`,
    plan: agent.plan.join('\n'),
    inventory: agent.inventory.join('、'),
    mood: { ...(agent.mood ?? MOOD_DEFAULT) },
    thought: currentThought(agent) ?? '',
    sprite: agent.sprite ?? '',
  })
  const [draft, setDraft] = useState<AgentDraft>(draftReset)
  /** 瓦片选择器是否展开。 */
  const [pickerOpen, setPickerOpen] = useState(false)
  const spriteImportRef = React.useRef<HTMLInputElement | null>(null)
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftReset())

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
          attrs: draft.attrs,
          mood: draft.mood,
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
    React.createElement(
      'div',
      { className: 'pa-line', style: { marginTop: 4 } },
      React.createElement(MoodChip, { mood: agent.mood }),
      React.createElement('span', { className: 'pa-dim' }, `@${agent.x},${agent.y}${at === undefined ? '' : `（${at.name}附近）`}｜已走 ${agent.stepsTaken} 步｜入场于第 ${agent.spawnTick} 步`),
    ),
    React.createElement(
      'div',
      { className: 'pa-thoughtblock' },
      React.createElement('span', { className: 'pa-dim' }, '当前想法'),
      // 可编辑：写进去会被当作"它此刻在想什么"，立刻显示（见 /agent 的 thought 处理）。
      React.createElement('input', {
        value: draft.thought,
        placeholder: '它此刻在想什么？留空则不写',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setDraft((prev) => ({ ...prev, thought: event.target.value })),
      }),
    ),

    // ── 外观：从图集挑一格，或上传一张图 ──────────────────────────────────
    //
    // 不给就用内置角色表（那 6 帧）。给了就按瓦片画——"每个角色长得不一样"
    // 这件事不必改代码。
    React.createElement('h4', { style: { marginTop: 8 } }, '外观', React.createElement('span', { className: 'pa-dim' }, draft.sprite === '' ? '（默认角色）' : draft.sprite)),
    React.createElement(
      'div',
      { className: 'pa-line' },
      React.createElement('input', {
        type: 'file', accept: 'image/*', ref: spriteImportRef, style: { display: 'none' },
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file === undefined) return
          const reader = new FileReader()
          reader.onload = () => {
            const dataUri = String(reader.result ?? '')
            const probe = new Image()
            probe.onload = () => {
              // 单格图集：整张图就是那一格，切格尺寸 = 图片尺寸
              void run('换外观', async () => {
                const setId = `skin-${Date.now().toString(36)}`
                applyWorld(await api.tileset({
                  op: 'add',
                  tileset: {
                    id: setId, name: file.name.replace(/\.[^.]+$/, '').slice(0, 30) || '外观',
                    image: dataUri, imageW: probe.naturalWidth, imageH: probe.naturalHeight,
                    tileW: probe.naturalWidth, tileH: probe.naturalHeight, margin: 0, spacing: 0, notes: {},
                  },
                }))
                applyWorld(await api.agent({ op: 'patch', agentId: agent.id, patch: { sprite: `${setId}:0,0` } }))
                setDraft((prev) => ({ ...prev, sprite: `${setId}:0,0` }))
                flash('已换上这张图作为它的外观')
              })
            }
            probe.src = dataUri
          }
          reader.readAsDataURL(file)
        },
      }),
      React.createElement('button', {
        className: 'pa-btn', 'data-tiny': 'true',
        onClick: () => spriteImportRef.current?.click(),
      }, '上传图片'),
      React.createElement('button', {
        className: 'pa-btn', 'data-tiny': 'true', 'data-on': pickerOpen,
        onClick: () => setPickerOpen((v) => !v),
      }, pickerOpen ? '收起瓦片' : '从瓦片库选'),
      draft.sprite === ''
        ? null
        : React.createElement('button', {
            className: 'pa-btn', 'data-tiny': 'true',
            onClick: () => {
              setDraft((prev) => ({ ...prev, sprite: '' }))
              void run('恢复默认外观', async () => {
                applyWorld(await api.agent({ op: 'patch', agentId: agent.id, patch: { sprite: '' } }))
                flash('已恢复内置角色外观')
              })
            },
          }, '用默认'),
    ),
    pickerOpen
      ? React.createElement(
          'div',
          { style: { maxHeight: 210, overflowY: 'auto', display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 } },
          ...world.sandbox.map.tilesets.flatMap((tileset) => {
            const g = gridOf(tileset)
            return Array.from({ length: Math.min(g.cols * g.rows, 400) }, (_, i) => {
              const col = i % g.cols
              const row = Math.floor(i / g.cols)
              const ref = makeTileRef(tileset.id, col, row)
              return React.createElement(TileThumb, {
                key: ref, tileset, col, row,
                active: draft.sprite === ref,
                hasNote: tileset.notes[noteKey(col, row)] !== undefined,
                onPick: () => {
                  setDraft((prev) => ({ ...prev, sprite: ref }))
                  void run('换外观', async () => {
                    applyWorld(await api.agent({ op: 'patch', agentId: agent.id, patch: { sprite: ref } }))
                    flash(`外观换成 ${tileset.name} ${col},${row}`)
                  })
                  setPickerOpen(false)
                },
                onNote: () => {},
              })
            })
          }),
        )
      : null,

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
    React.createElement(
      'div',
      { className: 'pa-dim', style: { marginTop: 3 }, title: '模型清单来自 DSH 当前已注册的 provider；paranim_models 工具同样能查。' },
      modelsNote === '' ? '留空＝跟随宿主默认模型' : modelsNote,
    ),

    // 身份 / 外貌 / 性格（需求 3）
    React.createElement('h4', { style: { marginTop: 10 } }, '身份与外貌'),
    React.createElement(
      'div',
      { className: 'pa-form' },
      field('姓名', draft.name, (v) => setDraft((p) => ({ ...p, name: v }))),
      field('身份', draft.concept, (v) => setDraft((p) => ({ ...p, concept: v }))),
      field('外貌', draft.appearance, (v) => setDraft((p) => ({ ...p, appearance: v }))),
      field('性格', draft.persona, (v) => setDraft((p) => ({ ...p, persona: v })), true),
      field('来历', draft.backstory, (v) => setDraft((p) => ({ ...p, backstory: v })), true),
    ),

    // 目标（需求 3）：一个角色只需要"它想要什么"。恐惧 / 隐瞒这类内在属性不做字段
    // ——它们是小说家写人物时才需要的东西，放在这里只会让每张卡都背上两个填空，
    // 且和"计划 / 性格"的语义互相覆盖。想让某个角色有所忌惮或有所隐瞒，
    // 写进「性格」或「来历」即可，模型照样读得到。
    // 心情：指数可手改，词可留空按指数自动取
    React.createElement('h4', { style: { marginTop: 10 } }, '心情'),
    React.createElement(
      'div',
      { className: 'pa-form' },
      React.createElement('label', null, '指数'),
      // 心情 = 词 + 指数，显示成「生气 4/10」：滑条调指数，输入框改词。
      React.createElement(
        'div',
        { className: 'pa-line' },
        React.createElement('input', {
          type: 'range', min: 0, max: 10, step: 1,
          value: draft.mood.value,
          style: { flex: 1, accentColor: 'var(--pa-gold)' },
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            setDraft((prev) => ({ ...prev, mood: { value: Number(event.target.value), label: prev.mood.label } })),
        }),
        React.createElement('span', { className: 'pa-mono' }, `${draft.mood.label} ${draft.mood.value}/10`),
      ),
      // 词可以自己写；留空则按指数自动取一个
      field('这个词', draft.mood.label, (v) => setDraft((p) => ({ ...p, mood: { ...p.mood, label: v } }))),
    ),

    // 日程与随身
    React.createElement('h4', { style: { marginTop: 10 } }, '日程与随身'),
    React.createElement(
      'div',
      { className: 'pa-form' },
      field('计划', draft.plan, (v) => setDraft((p) => ({ ...p, plan: v })), true),
      field('随身', draft.inventory, (v) => setDraft((p) => ({ ...p, inventory: v }))),
    ),
    React.createElement('div', { className: 'pa-dim', style: { marginTop: 3 } }, '每行一条，每走一步消耗一条。'),

    React.createElement(
      'div',
      { className: 'pa-line', style: { marginTop: 8 } },
      React.createElement('button', { className: 'pa-btn', 'data-primary': 'true', disabled: !dirty, onClick: save }, dirty ? '保存设定' : '已保存'),
      React.createElement('button', { className: 'pa-btn', onClick: () => setDraft(draftReset()) }, '撤销改动'),
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
        React.createElement('div', { className: 'pa-mem', key: `${entry.tick}-${index}`, 'data-kind': entry.kind },
          React.createElement('span', { className: 'pa-dim pa-mono' }, `第 ${entry.tick} 步`),
          ' ',
          entry.kind === 'thought' ? '（心里）' : entry.kind === 'whisper' ? '（收到的指令）' : entry.kind === 'summary' ? '（来历）' : '',
          ' ',
          entry.text),
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


/** 笔刷引用的显示名（"图集名 · 名字或坐标"）。 */
function refLabel(sandbox: { map: { tilesets: Array<{ id: string; name: string; notes: Record<string, { name?: string }> }> } }, ref: string): string {
  const colon = ref.indexOf(':')
  if (colon < 0) return ref
  const ts = sandbox.map.tilesets.find((t) => t.id === ref.slice(0, colon))
  const key = ref.slice(colon + 1)
  const noteName = ts?.notes[key]?.name
  return `${ts?.name ?? ref.slice(0, colon)} · ${noteName ?? key}`
}

/**
 * 图集面板：把一张图集按网格铺开，点格子选笔刷，点「注」标语义。
 *
 * 这是"由人告诉程序每个瓦片是什么"的落点。此前用平均色反查来猜格子，
 * 对纯色地面有效，对有形状的物件完全无效——一棵树和一片灌木的平均色
 * 可以一模一样。注释是人给的，代码只读结果。
 */
function TilesetPanel(props: {
  tileset: Tileset
  brushRef: string | null | undefined
  noteTarget: string | undefined
  onPick: (ref: string) => void
  onNote: (key: string) => void
  onSaveNote: (key: string, note: { name?: string; pass?: string; use?: string; desc?: string; states?: string }) => void
  onSlice: (slice: { w: number; h: number; spacing: number }) => void
}): React.ReactElement {
  const { tileset, brushRef, noteTarget, onPick, onNote, onSaveNote, onSlice } = props
  const grid = gridOf(tileset)
  /** 这一张图集自己的编辑目标；别的图集的面板拿到的不等于它，就不会显示卡片。 */
  const myTarget = `${tileset.id}#${noteTarget ?? ''}`
  const editing = noteTarget !== undefined && noteTarget.startsWith(`${tileset.id}#`) ? noteTarget.slice(tileset.id.length + 1) : undefined
  const [draft, setDraft] = React.useState<{ name: string; pass: string; use: string; desc: string; states: string }>({ name: '', pass: '', use: '', desc: '', states: '' })
  /** 切片草稿（导入的图集才能改）。 */
  const [draftSlice, setDraftSlice] = React.useState({ w: tileset.tileW, h: tileset.tileH, spacing: tileset.spacing })
  const note = editing === undefined ? undefined : tileset.notes[editing]
  void myTarget

  React.useEffect(() => {
    setDraft({
      name: note?.name ?? '',
      pass: note?.pass ?? '',
      use: note?.use ?? '',
      desc: note?.desc ?? '',
      states: (note?.states ?? []).join(', '),
    })
  }, [editing, note?.name, note?.pass, note?.use, note?.desc, note?.states])

  /**
   * 编辑卡片默认在网格**下方**——一张 12×11 的图集有 132 格，右键之后卡片
   * 落在屏幕外，看起来就是"右键没反应"。这里让它在出现时滚进视野。
   */
  const cardRef = React.useRef<HTMLDivElement | null>(null)
  React.useEffect(() => {
    if (editing !== undefined) cardRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [editing])

  const cellRef = (col: number, row: number): string => makeTileRef(tileset.id, col, row)

  return React.createElement(
    'div',
    { style: { marginTop: 6 } },
    React.createElement('div', { className: 'pa-dim' },
      `${tileset.name}（${grid.cols}×${grid.rows} 格${tileset.image === '' ? '，内置' : ''}）`),
    React.createElement(
      'div',
      {
        /**
         * 网格自己滚，不指望外层。
         *
         * 一张 12×11 的内置图集有 132 格，用户在窄侧栏里看到的是"最后一行被
         * 裁掉"。给它一个明确的高度上限 + 内部滚动，无论外层布局怎么变，
         * 每一格都够得着。
         */
        style: { display: 'flex', flexWrap: 'wrap', gap: 3, margin: '4px 0', maxHeight: 264, overflowY: 'auto' },
      },
      ...Array.from({ length: Math.min(grid.cols * grid.rows, 400) }, (_, i) => {
        const col = i % grid.cols
        const row = Math.floor(i / grid.cols)
        const ref = cellRef(col, row)
        const key = noteKey(col, row)
        const hasNote = tileset.notes[key] !== undefined
        return React.createElement(TileThumb, {
          key: i,
          tileset, col, row,
          active: brushRef === ref,
          hasNote,
          onPick: () => onPick(ref),
          onNote: () => onNote(key),
        })
      }),
    ),
    // 切片参数：只对导入的图集显示——内置图集的网格是固定的（归一化过的）
    tileset.image === ''
      ? null
      : React.createElement(
          'div',
          { className: 'pa-line', style: { marginTop: 4 } },
          React.createElement('span', { className: 'pa-dim' }, '切片'),
          React.createElement('input', {
            type: 'number', value: draftSlice.w, min: 2, max: 256, style: { width: 52 },
            title: '每格宽（像素）',
            onChange: (e) => setDraftSlice((d) => ({ ...d, w: Number(e.target.value) })),
          }),
          React.createElement('span', { className: 'pa-dim' }, '×'),
          React.createElement('input', {
            type: 'number', value: draftSlice.h, min: 2, max: 256, style: { width: 52 },
            title: '每格高（像素）',
            onChange: (e) => setDraftSlice((d) => ({ ...d, h: Number(e.target.value) })),
          }),
          React.createElement('span', { className: 'pa-dim' }, '间隙'),
          React.createElement('input', {
            type: 'number', value: draftSlice.spacing, min: 0, max: 64, style: { width: 44 },
            onChange: (e) => setDraftSlice((d) => ({ ...d, spacing: Number(e.target.value) })),
          }),
          React.createElement('button', {
            className: 'pa-btn', 'data-tiny': 'true',
            onClick: () => onSlice(draftSlice),
          }, '应用切片'),
        ),
    editing !== undefined
      ? React.createElement(
          'div',
          {
            ref: cardRef,
            style: { border: '1px solid var(--pa-gold)', borderRadius: 6, padding: 8, marginTop: 4, background: 'var(--pa-layer3)' },
          },
          React.createElement('div', { className: 'pa-line', style: { marginBottom: 4 } },
            React.createElement('b', null, `编辑瓦片 ${tileset.name} ${editing}`),
            React.createElement('span', { className: 'pa-spacer' }),
            React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => onNote(editing) }, '关闭'),
          ),
          React.createElement('div', { className: 'pa-place-grid' },
            React.createElement('label', { className: 'pa-place-cell' },
              React.createElement('span', { className: 'pa-dim' }, '名字（如：木门）'),
              React.createElement('input', { value: draft.name, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, name: e.target.value })) }),
            ),
            React.createElement('label', { className: 'pa-place-cell' },
              React.createElement('span', { className: 'pa-dim' }, '是否可通过'),
              React.createElement('select', {
                value: draft.pass,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setDraft((d) => ({ ...d, pass: e.target.value })),
              },
                ...[
                  ['', 'True（可通过）'],
                  ['block', 'False（不可通过）'],
                  ['water', '不可通过 · 水面'],
                  ['lava', '不可通过 · 岩浆'],
                ].map(([v, l]) => React.createElement('option', { key: v, value: v }, l)),
              ),
            ),
            React.createElement('label', { className: 'pa-place-cell' },
              React.createElement('span', { className: 'pa-dim' }, '互动'),
              React.createElement('select', {
                value: draft.use,
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setDraft((d) => ({ ...d, use: e.target.value })),
              },
                ...[['', '（无）'], ['door', '门（可开关）'], ['window', '窗（隔窗相望）'], ['switch', '开关']].map(([v, l]) =>
                  React.createElement('option', { key: v, value: v }, l)),
              ),
            ),
          ),
          React.createElement('div', { className: 'pa-place-grid' },
            React.createElement('label', { className: 'pa-place-cell' },
              React.createElement('span', { className: 'pa-dim' }, '备注'),
              React.createElement('input', {
                value: draft.desc, placeholder: '给玩家看的说明，不参与判定',
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, desc: e.target.value })),
              }),
            ),
            React.createElement('label', { className: 'pa-place-cell' },
              React.createElement('span', { className: 'pa-dim' }, '可选状态（逗号分隔）'),
              React.createElement('input', {
                value: draft.states, placeholder: '正常, 故障, 维修中',
                onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft((d) => ({ ...d, states: e.target.value })),
              }),
            ),
          ),
          React.createElement('div', { className: 'pa-line', style: { marginTop: 4 } },
            React.createElement('button', {
              className: 'pa-btn', 'data-tiny': 'true',
              onClick: () => onSaveNote(editing, draft),
            }, '保存注释'),
            React.createElement('button', {
              className: 'pa-btn', 'data-tiny': 'true', 'data-danger': 'true',
              onClick: () => onSaveNote(editing, {}),
            }, '清除'),
            React.createElement('span', { className: 'pa-dim' },
              note === undefined ? '未标注（按可走处理）' : `已标注：${note.name ?? '（无名）'}`),
          ),
        )
      : null,
  )
}

/**
 * 一格瓦片的缩略图。内置图集直接从客户端包里的像素取；用户图集
 * 从 data URI 解码（可能还没就绪，画个占位框）。
 */
function TileThumb(props: {
  tileset: Tileset
  col: number
  row: number
  active: boolean
  hasNote: boolean
  onPick: () => void
  onNote: () => void
}): React.ReactElement {
  const { tileset, col, row, active, hasNote, onPick, onNote } = props
  const ref = React.useRef<HTMLCanvasElement | null>(null)
  React.useEffect(() => {
    const cv = ref.current
    if (cv === null) return
    const ctx = cv.getContext('2d')
    if (ctx === null) return
    ctx.clearRect(0, 0, 26, 26)
    const img = tilesetImage(tileset)
    if (img === undefined) return
    const o = tileOrigin(tileset, col, row)
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, o.x, o.y, tileset.tileW, tileset.tileH, 1, 1, 24, 24)
  }, [tileset, col, row])
  return React.createElement('canvas', {
      ref,
      width: 26, height: 26,
      style: {
        /**
         * **透明通道必须看得见**：底色用棋盘格而不是实心深色。
         *
         * 挡板、门窗、树这些东西本来就是透明底的一小块像素；铺一个实心
         * 深色底的话，它和"整格不透明的地面瓦片"在缩略图上长得一模一样，
         * 挑不出哪张能叠在别的东西上面（用户看到的就是"tile 不是透明底"）。
         */
        border: `1px solid ${active ? '#ffc861' : hasNote ? '#7fc98b' : 'var(--pa-border)'}`,
        borderRadius: 3, cursor: 'pointer', display: 'block',
        backgroundColor: '#151a22',
        backgroundImage:
          'linear-gradient(45deg, #2b3240 25%, transparent 25%),'
          + 'linear-gradient(-45deg, #2b3240 25%, transparent 25%),'
          + 'linear-gradient(45deg, transparent 75%, #2b3240 75%),'
          + 'linear-gradient(-45deg, transparent 75%, #2b3240 75%)',
        backgroundSize: '8px 8px',
        backgroundPosition: '0 0, 0 4px, 4px -4px, -4px 0',
      },
      title: `${tileset.name} ${col},${row}${hasNote ? `（${tileset.notes[`${col},${row}`]?.name ?? '已标注'}）` : ''}\n左键：选它当笔刷　右键：编辑注释`,
      // 左键选中、右键注释——与 Godot/Unity 的 tileset 面板一致。
      // 原来把注释塞在一个 8px 的「注」小按钮里，既难点中又看不出是干什么的。
      onClick: onPick,
      onContextMenu: (e: React.MouseEvent) => {
        // 两道都要：preventDefault 挡浏览器菜单，stopPropagation 挡宿主页面
        // 在更外层对右键的监听——只做前者的话，事件继续冒泡、宿主先处理了它，
        // 表现就是"右键点了没反应"。
        e.preventDefault()
        e.stopPropagation()
        onNote()
      },
    })
}

function SandboxPage(props: {
  world: WorldView
  sandboxes: SandboxSummary[]
  busy: string
  api: ParanimApi
  run: (label: string, action: () => Promise<unknown>) => Promise<void>
  applyWorld: (world: WorldView) => void
  setSandboxes: (list: SandboxSummary[]) => void
  flash: (text: string) => void
  /** 以下由顶层持有：地图（MapCanvas）与本页面是兄弟节点，要共用同一份编辑态。 */
  editLayer: 'background' | 'structure' | 'object'
  setEditLayer: (layer: 'background' | 'structure' | 'object') => void
  brushRef: string | null | undefined
  setBrushRef: (ref: string | null | undefined) => void
}): React.ReactElement {
  const { world, sandboxes, api, run, applyWorld, setSandboxes, flash, editLayer, setEditLayer, brushRef, setBrushRef } = props
  /** 资源池要知道"现在是新建还是换贴图"，所以记一个选中态。 */
  /**
   * 正在编辑哪一格，写成 `"图集id#列,行"`。
   *
   * **必须带图集 id**：只存 "列,行" 的话，页面上每个图集面板都会认为自己
   * 被选中，右键一次会同时弹出好几张编辑卡片（用户遇到的"右键异常"就是
   * 这个——截图上 Tiny Town 和 user-xxx 的卡片一起开着）。
   */
  const [noteTarget, setNoteTarget] = React.useState<string | undefined>(undefined)
  /** 正在等待二次确认的镜像 id（不用 window.confirm，见删除按钮处的说明）。 */
  const [confirming, setConfirming] = React.useState<string | undefined>(undefined)
  /** 隐藏的文件选择框——由「导入素材图」按钮代点。 */
  const importRef = React.useRef<HTMLInputElement | null>(null)

  /**
   * 导入一张素材图并切成瓦片。
   *
   * 尺寸从图片本身读（naturalWidth/Height），切片参数用默认值 16×16 / 间隙 1
   * ——这是 Kenney 系素材的常见规格，也是用户定的默认。导进去之后可以在这张
   * 图集下面改。
   */
  const onImportFile = (file: File | undefined): void => {
    if (file === undefined) return
    const reader = new FileReader()
    reader.onload = () => {
      const dataUri = String(reader.result ?? '')
      if (dataUri === '') return
      const probe = new Image()
      probe.onload = () => {
        const name = file.name.replace(/\.[^.]+$/, '').slice(0, 40) || '素材图'
        void run('导入图集', async () => {
          applyWorld(await api.tileset({
            op: 'add',
            tileset: {
              id: `user-${Date.now().toString(36)}`,
              name,
              image: dataUri,
              imageW: probe.naturalWidth,
              imageH: probe.naturalHeight,
              tileW: 16, tileH: 16, margin: 0, spacing: 1,
              notes: {},
            },
          }))
          flash(`已导入「${name}」（${probe.naturalWidth}×${probe.naturalHeight}），可在下面切格并注释`)
        })
      }
      probe.onerror = () => flash('这张图读不出来（不是有效的图片文件？）')
      probe.src = dataUri
    }
    reader.readAsDataURL(file)
  }
  /**
   * 正在编辑哪一层。
   *
   * 提升到顶层而不是放在 SandboxPage 里：地图（MapCanvas）也要知道当前层——
   * 不同层的落笔行为完全不同（background 涂抹、object 放置），而这个组件
   * 是 SandboxPage 的兄弟节点，不共享 state 就得靠 props 层层传。
   */
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
      // ── 镜像元信息：名字、尺寸 ───────────────────────────────────────────
      //
      // 拿这里当"改名/改尺寸"的入口。尺寸改动会把三个图层一起重排
      // （cells 是行优先一维数组，长度必须等于 宽×高），所以服务端做，
      // 客户端只负责收输入。
      React.createElement(
        'div',
        { className: 'pa-place-grid', style: { marginTop: 6 } },
        React.createElement('label', { className: 'pa-place-cell' },
          React.createElement('span', { className: 'pa-dim' }, '名称'),
          React.createElement('input', {
            defaultValue: world.sandbox.name,
            onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
              const name = e.target.value.trim()
              if (name === '' || name === world.sandbox.name) return
              void run('改名称', async () => {
                applyWorld(await api.sandbox({ action: 'meta', name }))
                flash(`已改名为「${name}」`)
              })
            },
          }),
        ),
        React.createElement('label', { className: 'pa-place-cell' },
          React.createElement('span', { className: 'pa-dim' }, '宽（格）'),
          React.createElement('input', {
            type: 'number', defaultValue: world.sandbox.map.width, min: 8, max: 400,
            onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
              const width = Math.round(Number(e.target.value))
              if (!Number.isFinite(width) || width === world.sandbox.map.width) return
              void run('改尺寸', async () => {
                applyWorld(await api.sandbox({ action: 'meta', width }))
                flash(`宽度改为 ${width} 格（三个图层已一起重排）`)
              })
            },
          }),
        ),
        React.createElement('label', { className: 'pa-place-cell' },
          React.createElement('span', { className: 'pa-dim' }, '高（格）'),
          React.createElement('input', {
            type: 'number', defaultValue: world.sandbox.map.height, min: 8, max: 400,
            onBlur: (e: React.FocusEvent<HTMLInputElement>) => {
              const height = Math.round(Number(e.target.value))
              if (!Number.isFinite(height) || height === world.sandbox.map.height) return
              void run('改尺寸', async () => {
                applyWorld(await api.sandbox({ action: 'meta', height }))
                flash(`高度改为 ${height} 格（三个图层已一起重排）`)
              })
            },
          }),
        ),
      ),
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
      // 这一节**不能**再要 flex:1：整栏已经是 pa-scroll 了，这里再抢剩余高度
      // 就会把自己压成一条缝隙，卡片内容被裁掉（截图里的"显示不全"）。
      // 按内容高度排，条目真的多起来时用 maxHeight 兜住。
      { className: 'pa-sec pa-scroll', style: { maxHeight: 280 } },
      React.createElement('h4', null, `沙盒镜像（${sandboxes.length}）`),
      ...sandboxes.map((item) =>
        React.createElement(
          'div',
          {
            key: item.id,
            className: 'pa-item',
            'data-on': item.id === world.sandbox.id,
            /**
             * 点一下**直接切换**，不必先按「载入」。
             *
             * 选中一个镜像却还看着另一个的编辑内容，是很容易搞混的状态——
             * 尤其两座镇子的图画在同一块画布上（用户要求"选中即切换"）。
             */
            onClick: () => {
              if (item.id === world.sandbox.id) return
              void run('切换镜像', async () => {
                applyWorld(await api.sandbox({ action: 'select', id: item.id }))
                flash(`已切到「${item.name}」`)
              })
            },
          },
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
              React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => void run('派生副本', async () => { applyWorld(await api.sandbox({ action: 'duplicate', id: item.id, newId: `${item.id}-copy`, name: `${item.name} 副本` })); await refreshList() }) }, '派生副本'),
              // builtin 的"恢复出厂"只在它跟着插件发货时才有意义；删掉之后
              // 靠 ensureSeed 的删除标记不再种回来（见 store 的 seed 逻辑）
              item.builtin
                ? React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => void run('重置镜像', async () => { applyWorld(await api.sandbox({ action: 'reset', id: item.id })); flash('已恢复出厂镜像') }) }, '恢复出厂')
                : null,
              /**
               * **所有镜像都能删**（内置的也能）。
               *
               * 原先对 builtin 直接不给按钮——想清掉一座用不上的发货镜像
               * 就只能忍着（用户反馈"部分镜像无法删除"）。删了之后不再自动
               * 种回来：种子的版本戳会记住"这一份被删过"。
               */
              /**
               * 删除用**行内二次确认**，不用 window.confirm。
               *
               * 宿主页面里 confirm 可能被禁用或直接返回 false——那样点"删除"
               * 会**静默什么也不发生**：不报错、也不刷新列表，看起来就是
               * "删不掉"（用户反馈的"删除后没有立刻刷新镜像列表"很可能是这个）。
               * 自己画一个"确认"按钮，不依赖宿主的对话框。
               */
              confirming === item.id
                ? React.createElement('button', {
                    className: 'pa-btn', 'data-tiny': 'true', 'data-danger': 'true',
                    onClick: (event: React.MouseEvent) => {
                      event.stopPropagation()
                      void run('删除镜像', async () => {
                        setConfirming(undefined)
                        applyWorld(await api.sandbox({ action: 'remove', id: item.id }))
                        await refreshList()
                        flash(`已删除「${item.name}」`)
                      })
                    },
                  }, '确认删除')
                : React.createElement('button', {
                    className: 'pa-btn', 'data-tiny': 'true', 'data-danger': 'true',
                    onClick: (event: React.MouseEvent) => {
                      event.stopPropagation()   // 别把"删除"顺手当成"选中"
                      setConfirming(item.id)
                    },
                  }, '删除'),
            ),
          ),
        ),
      ),
    ),
    // ── 图层与笔刷（编辑镜像；三图层共用一种落笔）──────────────────────────
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement(
        'h4',
        null,
        '图层与笔刷',
        React.createElement('span', { className: 'pa-chip' }, LAYER_LABEL[editLayer]),
      ),
      React.createElement(
        'div',
        { className: 'pa-line', style: { marginBottom: 6 } },
        ...(['background', 'structure', 'object'] as const).map((layer) =>
          React.createElement('button', {
            key: layer,
            className: 'pa-btn', 'data-tiny': 'true',
            'data-on': editLayer === layer,
            title: layer === 'background' ? '地面：水面/岩浆等地形会影响移动' : layer === 'structure' ? '墙体与障碍：限制移动，画四面墙即可，不画屋顶' : '门窗/家具/可互动的东西',
            onClick: () => setEditLayer(layer),
          }, LAYER_LABEL[layer]),
        ),
        React.createElement('span', { className: 'pa-spacer' }),
        React.createElement('button', {
          className: 'pa-btn', 'data-tiny': 'true',
          'data-on': brushRef === null,
          title: '把画到的格子清空',
          onClick: () => setBrushRef(null),
        }, '🧽 橡皮'),
      ),
      React.createElement('div', { className: 'pa-dim' },
        brushRef === undefined
          ? '还没选笔刷——下面点一个瓦片。'
          : brushRef === null
            ? '橡皮：涂到的格子会被清空。'
            : `笔刷：${refLabel(world.sandbox, brushRef)}`),
    ),
    // ── 图集与瓦片注释 ─────────────────────────────────────────────────────
    //
    // 瓦片的语义（叫什么、能不能走、是不是门）**由人在这里标**，不是代码按
    // 颜色猜的。没标过的瓦片照样能画，只是引擎不知道它是什么——移动判定
    // 把未标注一律当"可走"处理。
    React.createElement(
      'div',
      { className: 'pa-sec' },
      React.createElement(
        'h4',
        null,
        '图集与瓦片注释',
        React.createElement('span', { className: 'pa-chip' }, `${world.sandbox.map.tilesets.length} 张`),
      ),
      React.createElement(
        'div',
        { className: 'pa-line', style: { marginBottom: 5 } },
        // 导入素材图：默认按 16×16、1px 间隙切（Kenney 系素材的常见规格），
        // 导进去之后可以在这张图集下面改切片参数
        React.createElement('input', {
          type: 'file', accept: 'image/*', ref: importRef, style: { display: 'none' },
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0]
            e.target.value = ''   // 同一个文件连选两次也要能触发
            onImportFile(file)
          },
        }),
        React.createElement('button', {
          className: 'pa-btn', 'data-tiny': 'true',
          onClick: () => importRef.current?.click(),
        }, '＋ 导入素材图 (PNG)'),
        React.createElement('span', { className: 'pa-dim' }, '导入后按 16×16、间隙 1 切格，可在下面调整'),
      ),
      ...world.sandbox.map.tilesets.map((tileset) =>
        React.createElement(TilesetPanel, {
          key: tileset.id,
          tileset,
          brushRef,
          noteTarget,
          onPick: (ref: string) => { setBrushRef(ref); setNoteTarget(undefined) },
          onNote: (key: string) => setNoteTarget(noteTarget === `${tileset.id}#${key}` ? undefined : `${tileset.id}#${key}`),
          onSaveNote: (key: string, note: { name?: string; pass?: string; use?: string; desc?: string; states?: string }) => {
            void run('存注释', async () => {
              // 走 /tileset 写服务端——原先改客户端对象再调 /sandbox save，
              // 而那条路读的是服务端自己那份沙盒，等于什么都没提交（标注完就丢）。
              const states = (note.states ?? '').split(/[,,、\s]+/).map((v) => v.trim()).filter((v) => v !== '')
              applyWorld(await api.tileset({ op: 'note', tilesetId: tileset.id, key, note: { ...note, states } }))
              flash(note.name === undefined ? `已清除「${tileset.name} ${key}」的注释` : `已标注「${note.name}」`)
            })
          },
          onSlice: (slice: { w: number; h: number; spacing: number }) => {
            void run('改切片', async () => {
              applyWorld(await api.tileset({ op: 'slice', tilesetId: tileset.id, tileW: slice.w, tileH: slice.h, spacing: slice.spacing }))
              flash(`「${tileset.name}」切成 ${slice.w}×${slice.h}，间隙 ${slice.spacing}`)
            })
          },
        }),
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

function EventsPage(props: { world: WorldView; selected?: string; feedMode: FeedMode }): React.ReactElement {
  const { world, selected, feedMode } = props
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
    React.createElement('div', { className: 'pa-scroll pa-feed', 'data-mode': feedMode, style: { flex: 1, padding: '6px 10px' } },
      ...events.map((event) => React.createElement(EventRow, { key: event.id, event, mode: feedMode })),
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

/**
 * 一条事件。三种渲染模式共用同一份数据，差别只在"长什么样"——
 * 语义→颜色的映射在 theme.ts 的 toneOf/segmentsOf 里，渲染层不出现任何具体颜色。
 */
function EventRow(props: { event: WorldEvent; mode: FeedMode }): React.ReactElement {
  const { event, mode } = props
  const tone = toneOf(event)
  const segments = segmentsOf(event)
  // 显式映射而不是拼 `pa-seg-${kind}`：拼字符串时改个类名不会报错，只会静默失色，
  // 而且静态检索也看不到它们被用过（删样式时容易误删）。
  const SEG_CLASS: Record<string, string> = {
    quote: 'pa-seg-quote',
    dice: 'pa-seg-dice',
    object: 'pa-seg-object',
  }
  const parts = segments.map((seg, i) => {
    const cls = SEG_CLASS[seg.kind]
    return cls === undefined
      ? React.createElement('span', { key: i }, seg.text)
      : React.createElement('span', { key: i, className: cls }, seg.text)
  })

  const head = React.createElement(
    'div',
    { className: 'pa-evhead' },
    React.createElement('span', { className: 'pa-evkind' }, `${TONE_ICON[tone]} ${TONE_LABEL[tone]}`),
    React.createElement('span', { className: 'pa-evtime pa-mono' }, `#${event.tick}`),
  )

  const body = React.createElement('span', { className: 'pa-evbody' }, ...parts)

  const roll =
    event.roll === undefined
      ? null
      : React.createElement(
          'div',
          { className: 'pa-roll pa-mono' },
          React.createElement('b', null, `D6=${event.roll.roll}`),
          event.roll.decisive === true ? ' 恒定' : '',
          ` + ${event.roll.attr ?? ''} ${event.roll.attrValue ?? ''} = ${event.roll.total ?? ''}`,
          ` vs ${event.roll.difficulty ?? ''} → ${event.roll.ok === true ? '成功' : '失败'}`,
          event.roll.opponent === undefined
            ? ''
            : ` ｜对手 ${event.roll.opponent} 掷 ${event.roll.opponentRoll ?? ''} → ${event.roll.opponentTotal ?? ''}`,
        )

  if (mode === 'line') {
    return React.createElement(
      'div',
      { className: 'pa-ev', 'data-tone': tone },
      React.createElement('span', { className: 'pa-evkind pa-mono' }, `#${event.tick}`),
      body,
      event.roll === undefined ? null : roll,
    )
  }
  if (mode === 'chat') {
    return React.createElement(
      'div',
      { className: 'pa-ev', 'data-tone': tone },
      React.createElement('div', { className: 'pa-evkind' }, `${TONE_ICON[tone]} ${TONE_LABEL[tone]}`),
      React.createElement('div', null, body, roll),
    )
  }
  return React.createElement(
    'div',
    { className: 'pa-ev', 'data-tone': tone },
    head,
    body,
    roll,
  )
}
