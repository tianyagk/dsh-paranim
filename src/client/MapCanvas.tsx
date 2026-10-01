/**
 * 小镇画布 + 右键菜单（需求 5）。
 *
 * 渲染交给 `town.ts`（材质化地块 / 建筑 / 道路 / 角色），这里只负责三件事：
 *  1. 视图——等比缩放 + 居中平移。沙盒坐标是 1:1 的逻辑格，不引入投影变换，
 *     否则会出现"点了这盏灯、改到那棵树"。
 *  2. 命中——右键找最近的物件、左键找最近的智能体。
 *  3. 尺寸——画布由 CSS 绝对定位铺满容器，本组件**不写任何影响父容器尺寸的
 *     属性（否则容器尺寸与画布尺寸会互相喂养），ResizeObserver 回调也只在
 *     尺寸真的变化时才更新 state。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  OBJECT_KIND_LABEL,
  type Sandbox,
  type SandboxAgent,
  type StateValue,
  type WorldEvent,
  type WorldObject,
} from '../shared/model.ts'
import { TILE_PX, collectImages, mapPixelSize, renderTown, screenToWorld, stepOf, worldToScreen, type View } from './town.ts'
import { objectsOf, objectIdAt } from '../shared/tilemap.ts'
import { allSheetsReady, loadSheets } from './tiles.ts'

export interface MapCanvasProps {
  sandbox: Sandbox
  agents: SandboxAgent[]
  events: WorldEvent[]
  /** 世界步数：驱动行走动画的帧选择（同一格不抖）。 */
  tick: number
  selectedId?: string
  onSelectAgent: (id: string) => void
  /** 提交一次物体改动（宿主会落盘并回写事件流）。 */
  onPatchObject: (objectId: string, body: Record<string, unknown>) => void
  onRemoveObject: (objectId: string) => void
  /**
   * 镜像编辑模式：非空时地图接受"涂抹/放置"，不再走右键看状态那条路。
   *
   * 运行时与编辑时是两种心智：前者问"这盏灯现在怎么样"，后者问"这里该是什么"。
   * 用同一个交互承载两者的话，玩家想改状态会不小心把地面刷掉。
   */
  /** 编辑哪一层（不传 = 运行模式，不落笔）。 */
  edit?: { layer: 'background' | 'structure' | 'object' }
  /** 当前笔刷的瓦片引用。null = 橡皮；undefined = 还没选。 */
  dropRef?: string | null
  /** 笔刷落下：一次给一串格子（拖动时连续），宿主按这一笔刷新。 */
  onPaint?: (cells: Array<{ x: number; y: number }>) => void
}

interface Hit {
  /** 可能是地标（WorldObject）也可能是格子上的物件（TileObject）。 */
  object: { id: string; name: string; x: number; y: number; state: Record<string, unknown> }
  /** 画布像素坐标，用来放菜单。 */
  px: number
  py: number
}

/** 状态槽的常见取值：给下拉而不是让用户手打。 */
const STATUS_PRESETS = ['正常', '故障', '损坏', '维修中', '锁住', '被人动过']
const BOOL_KEYS = ['open', 'lit', 'running', 'full', 'locked', 'on', 'spinning', 'flowing', 'occupied', 'tuned']

export function MapCanvas(props: MapCanvasProps): React.ReactElement {
  const { sandbox, agents, events, tick, selectedId, onSelectAgent, onPatchObject, onRemoveObject, edit, dropRef, onPaint } = props
  /** 一笔还没上传的格子。攒着是为了不让每一格都打一次请求。 */
  const strokeRef = useRef<Array<{ x: number; y: number }>>([])
  const paintingRef = useRef(false)
  /** 还没发出去的这一批格子，见 flushSoon。 */
  const pendingRef = useRef<Array<{ x: number; y: number }>>([])
  const flushRef = useRef<number | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 480, h: 320 })
  const [zoom, setZoom] = useState(1)
  const [hit, setHit] = useState<Hit | null>(null)
  const [hover, setHover] = useState<{ x?: number; y?: number; agentId?: string }>({})

  // 容器尺寸。只在真的变了才 setState：ResizeObserver 回调与 React 渲染是两条
  // 独立回路，无条件 setState 会互相喂养。
  useEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null) return
    const update = (): void => {
      const w = Math.max(1, Math.round(wrap.clientWidth))
      const h = Math.max(1, Math.round(wrap.clientHeight))
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(wrap)
    return () => observer.disconnect()
  }, [])

  // 气泡：每个角色最近说过的一句话
  const bubbles = useMemo(() => {
    const map = new Map<string, string>()
    for (const event of events) {
      if (event.kind !== 'say') continue
      const match = event.text.match(/「(.+?)」/)
      const who = event.actor
      if (match !== null && !map.has(who)) map.set(who, match[1])
    }
    return map
  }, [events])

  // 图集解码：异步，只在挂载时做一次。未就绪时先不画，避免闪一帧空地图。
  const [sheetsReady, setSheetsReady] = useState(() => allSheetsReady())
  useEffect(() => {
    if (sheetsReady) return
    let alive = true
    void loadSheets().then((result) => {
      if (alive) setSheetsReady(result.ok || allSheetsReady())
    })
    return () => {
      alive = false
    }
  }, [sheetsReady])

  // 地块底图：只在地标布局真的变了时才重建
  // 视图：把整张地图的**像素尺寸**塞进容器，再乘用户缩放。
  // 1 倍时整镇可见；放大看细节时精灵按最近邻放大，不会糊。
  const view = useMemo<View>(() => {
    const mapPx = mapPixelSize(sandbox)
    const fit = Math.min(size.w / mapPx.w, size.h / mapPx.h) * zoom
    const s = fit > 0 && Number.isFinite(fit) ? fit : 0.5
    const contentW = mapPx.w * s
    const contentH = mapPx.h * s
    return {
      scale: s,
      offsetX: (size.w - contentW) / 2 + TILE_PX * 3 * s,
      offsetY: (size.h - contentH) / 2 + TILE_PX * 3 * s,
    }
  }, [size, sandbox, zoom])

  // 换算的坑（曾经漏乘 TILE_PX 差 16 倍）统一封在 town.ts 的 stepOf/screenToWorld 里
  const toWorld = useCallback((px: number, py: number) => screenToWorld(px, py, view), [view])

  // ── 绘制 ──────────────────────────────────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return
    const dpr = typeof window === 'undefined' ? 1 : Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.max(1, Math.floor(size.w * dpr))
    canvas.height = Math.max(1, Math.floor(size.h * dpr))
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    if (!sheetsReady) {
      ctx.fillStyle = '#12161d'
      ctx.fillRect(0, 0, size.w, size.h)
      ctx.fillStyle = '#78849a'
      ctx.font = '12px system-ui, "PingFang SC", sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('正在解码像素素材…', size.w / 2, size.h / 2)
      return
    }
    renderTown(ctx, {
      sandbox,
      view,
      size,
      agents,
      images: collectImages(sandbox),
      selectedId,
      hover: { x: hover.x, y: hover.y, agentId: hover.agentId },
      bubbles,
      tick,
      // 编辑某一层时只画那一层：不然地面被建筑/物件盖住，刷了也看不见
      only: edit?.layer,
    })

    // 地标名下方补一行小字：所属类别，帮玩家认出"这是什么地方"
    if (view.scale >= 2) {
      ctx.font = '9px system-ui, "PingFang SC", sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      // 一格占多少屏幕像素：所有"格坐标 → 画布像素"的换算都得用它，
      // 直接乘 scale 会差 16 倍（与 toWorld 修正前同一个错误）。
      const step = stepOf(view)
      for (const object of objectsOf(sandbox.map)) {
        const label = String(object.state.status ?? '')
        if (label === '' || label === '正常') continue
        const { px, py } = worldToScreen(object.x, object.y, view)
        ctx.fillStyle = 'rgba(240,113,120,0.95)'
        ctx.fillText(label, px, py + step * 1.6)
      }
    }
  }, [sandbox, view, size, agents, selectedId, hover, bubbles, tick, sheetsReady, edit?.layer])

  // ── 命中判定 ──────────────────────────────────────────────────────────
  const hitTest = useCallback(
    (px: number, py: number): Hit | null => {
      const world = toWorld(px, py)
      // 命中半径：屏幕 12px 折成多少格。此前写作 `12 / (scale*16/16)` = 12/scale，
      // 缩放 0.7 时半径有 17 格——整个地图都算"点中了"，右键永远命中最近的那个。
      const radius = Math.max(1.2, 12 / stepOf(view))
      let best: Hit | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const object of objectsOf(sandbox.map)) {
        const d = Math.hypot(world.x - object.x, world.y - object.y)
        if (d <= radius && d < bestDistance) {
          bestDistance = d
          best = { object, px, py }
        }
      }
      if (best !== null) return best
      for (const place of sandbox.places) {
        const halfW = (place.w ?? 4) / 2
        const halfH = (place.h ?? 4) / 2
        const dx = Math.max(0, Math.abs(world.x - place.x) - halfW)
        const dy = Math.max(0, Math.abs(world.y - place.y) - halfH)
        const d = Math.hypot(dx, dy)
        if (d <= radius && d < bestDistance) {
          bestDistance = d
          best = { object: place, px, py }
        }
      }
      return best
    },
    [sandbox.map, sandbox.places, toWorld, view.scale],
  )

  const agentAt = useCallback(
    (px: number, py: number): string | undefined => {
      const world = toWorld(px, py)
      let best: { id: string; d: number } | undefined
      for (const agent of agents) {
        const d = Math.hypot(agent.x - world.x, agent.y - world.y)
        if (d <= Math.max(1.6, 11 / stepOf(view)) && (best === undefined || d < best.d)) best = { id: agent.id, d }
      }
      return best?.id
    },
    [agents, toWorld, view.scale],
  )

  const localPoint = (event: React.MouseEvent<HTMLCanvasElement>): { px: number; py: number } => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { px: event.clientX - rect.left, py: event.clientY - rect.top }
  }

  const onContextMenu = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    event.preventDefault()
    const { px, py } = localPoint(event)
    const agentId = agentAt(px, py)
    if (agentId !== undefined) {
      // 右键点角色：直接切到它的编辑页，比弹菜单快
      onSelectAgent(agentId)
      setHit(null)
      return
    }
    setHit(hitTest(px, py))
  }

  const cellAt = (px: number, py: number): { x: number; y: number } => {
    const w = toWorld(px, py)
    return { x: Math.round(w.x), y: Math.round(w.y) }
  }

  /**
   * 把这一格并进当前这一笔；同一格不重复记。返回它是不是**新**格子。
   *
   * 拖动时每一帧都会问一次，所以"没有新格子"必须能立刻判定——否则同一格
   * 会被反复提交，一次涂抹打出上百个重复请求。
   */
  const pushCell = (px: number, py: number): { x: number; y: number } | undefined => {
    if (onPaint === undefined) return undefined
    const c = cellAt(px, py)
    if (c.x < 0 || c.y < 0 || c.x >= sandbox.map.width || c.y >= sandbox.map.height) return undefined
    if (strokeRef.current.some((p) => p.x === c.x && p.y === c.y)) return undefined
    strokeRef.current.push(c)
    return c
  }

  /**
   * 攒一小批再发。
   *
   * 快速拖动时一格一个请求会打出上百个（服务端虽然会排队，但请求本身有成本）；
   * 攒 40ms 既保住了"笔过之处立刻上色"的手感，又把请求数压到十几条。
   */
  const flushSoon = (): void => {
    if (flushRef.current !== null) return
    flushRef.current = window.setTimeout(() => {
      flushRef.current = null
      if (pendingRef.current.length === 0 || onPaint === undefined) return
      const batch = pendingRef.current
      pendingRef.current = []
      onPaint(batch)
    }, 40)
  }

  const flushNow = (): void => {
    if (flushRef.current !== null) {
      window.clearTimeout(flushRef.current)
      flushRef.current = null
    }
    if (pendingRef.current.length === 0 || onPaint === undefined) return
    const batch = pendingRef.current
    pendingRef.current = []
    onPaint(batch)
  }

  const onPointerDown = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    if (edit === undefined) return
    const { px, py } = localPoint(event)
    {
      paintingRef.current = true
      strokeRef.current = []
      pendingRef.current = []
      const first = pushCell(px, py)
      if (first !== undefined) pendingRef.current.push(first)
      // 单击也要立刻出效果：不然点一下没反应，像是坏了
      flushNow()
    }
  }

  const onPointerUp = (): void => {
    if (!paintingRef.current) return
    paintingRef.current = false
    flushNow()   // 收笔时把攒着的那一批发出去
    strokeRef.current = []
  }

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    if (edit !== undefined) return
    const { px, py } = localPoint(event)
    const id = agentAt(px, py)
    if (id !== undefined) onSelectAgent(id)
    setHit(null)
  }

  const onMove = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const { px, py } = localPoint(event)
    if (edit !== undefined) {
      if (paintingRef.current) {
        const added = pushCell(px, py)
        if (added !== undefined) {
          pendingRef.current.push(added)
          flushSoon()
        }
      }
      return
    }
    if (edit !== undefined) {
      // 编辑态：hover 记格子——渲染层用它画"下一笔落在哪"的高亮
      const c = cellAt(px, py)
      setHover((prev) => (prev.x === c.x && prev.y === c.y && prev.agentId === undefined ? prev : { x: c.x, y: c.y }))
      return
    }
    const agentId = agentAt(px, py)
    const c = cellAt(px, py)
    setHover((prev) => (prev.x === c.x && prev.y === c.y && prev.agentId === agentId ? prev : { x: c.x, y: c.y, agentId }))
  }

  const hoverAgent = hover.agentId === undefined ? undefined : agents.find((a) => a.id === hover.agentId)
  /** 悬停格上的物件（有名字才显示，没标注的瓦片只显示坐标）。 */
  const hoverTile = hover.x === undefined || hover.y === undefined
    ? undefined
    : objectsOf(sandbox.map).find((o) => o.x === hover.x && o.y === hover.y)
  const hoverTileName = hoverTile?.name ?? '（空格）'
  const hoverTileState = hoverTile === undefined
    ? ''
    : Object.entries(hoverTile.state).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join('/') : String(v)}`).join('　')

  return React.createElement(
    'div',
    { className: 'pa-mapwrap', ref: wrapRef },
    React.createElement('canvas', {
      ref: canvasRef,
      className: 'pa-map',
      'data-editing': edit === undefined ? undefined : 'true',
      onMouseDown: onPointerDown,
      onMouseUp: onPointerUp,
      onMouseLeave: () => { setHover({}); onPointerUp() },
      'aria-label':
        edit === undefined
          ? '小镇地图：左键点智能体，右键点地标或物件改状态'
          : '正在编辑镜像：按住拖动即可连续涂抹，点一下放一个物件',
      onClick,
      /**
       * 必须是 onMouseMove —— 之前写成了 onMove。
       *
       * React 不认识 onMove 这个 prop，它不会被报错、不会被警告，只是**被丢掉**：
       * 于是 mousedown 那一下能落笔，而按住拖动时一次都不触发。原生事件实测
       * 到达了 21 次，React 处理器一次没跑。（DOM 元素上的事件 prop 一律是
       * on + 事件名首字母大写：onClick / onMouseMove / onMouseDown。）
       */
      onMouseMove: onMove,
      onContextMenu,
    }),
    // 内描边 + 暗角：地图边缘收进容器，视觉上"这是一张图"而不是糊满整个框
    React.createElement('div', { className: 'pa-mapvignette' }),
    // 视图控制：图标用字符而不是 emoji，避免各系统字体不一致渲染成空白方块
    React.createElement(
      'div',
      { className: 'pa-mapbar' },
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', title: '缩小', onClick: () => setZoom((z) => Math.max(0.6, z / 1.25)) }, '−'),
      React.createElement('span', { className: 'pa-dim pa-mono' }, `${zoom.toFixed(2)}×`),
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', title: '放大', onClick: () => setZoom((z) => Math.min(5, z * 1.25)) }, '+'),
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', title: '回到默认缩放', onClick: () => setZoom(1) }, '1:1'),
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', title: '铺满可用区域', onClick: () => setZoom(2.6) }, '铺满'),
    ),
    React.createElement(
      'div',
      { className: 'pa-legend' },
      hover.x !== undefined && hover.y !== undefined && hover.agentId === undefined
        ? React.createElement(
            'span',
            null,
            React.createElement('b', null, hoverTileName),
            `　@${hover.x},${hover.y}${hoverTileState === '' ? '' : `　${hoverTileState}`}`,
          )
        : hoverAgent !== undefined
          ? React.createElement('span', null, React.createElement('b', null, hoverAgent.name), `　${hoverAgent.concept}　@${Math.round(hoverAgent.x)},${Math.round(hoverAgent.y)}`)
          : React.createElement('span', null, '左键点角色看详情 · 右键点建筑或物件改状态 · 滚轮区外的 ＋/− 缩放'),
    ),
    hit === null
      ? null
      : React.createElement(ObjectMenu, {
          hit,
          onClose: () => setHit(null),
          onPatch: (body) => {
            onPatchObject(hit.object.id, body)
            setHit(null)
          },
          onRemove: () => {
            onRemoveObject(hit.object.id)
            setHit(null)
          },
        }),
  )
}

// ── 右键菜单：改状态 / 改名 / 挪位置 / 删除 ──────────────────────────────

interface ObjectMenuProps {
  hit: Hit
  onClose: () => void
  onPatch: (body: Record<string, unknown>) => void
  onRemove: () => void
}

function ObjectMenu(props: ObjectMenuProps): React.ReactElement {
  const { hit, onClose, onPatch, onRemove } = props
  const object = hit.object
  const [draft, setDraft] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {}
    for (const [key, value] of Object.entries(object.state)) {
      init[key] = Array.isArray(value) ? value.join(',') : String(value)
    }
    return init
  })
  const [name, setName] = useState(object.name)
  const [x, setX] = useState(String(object.x))
  const [y, setY] = useState(String(object.y))

  const commit = (): void => {
    const state: Record<string, StateValue | null> = {}
    for (const [key, value] of Object.entries(draft)) {
      const previous = object.state[key]
      // 按**上一次的类型**解析：原本是布尔就收 true/false，原本是数字就收数字。
      // 全按字符串写回去会把 `lit` 变成 "false"（真值！）——那种 bug 要等到
      // 引擎读它的时候才会现形。
      if (typeof previous === 'boolean') state[key] = /^(true|1|是|开|on)$/i.test(value.trim())
      else if (typeof previous === 'number') {
        const n = Number(value)
        state[key] = Number.isFinite(n) ? n : previous
      } else if (value.trim() === '' && previous !== undefined) state[key] = null
      else state[key] = value
    }
    onPatch({ objectId: object.id, state, name, x: Number(x), y: Number(y), by: '玩家' })
  }

  const addKey = (): void => {
    const key = window.prompt('新状态键名（如 电量 / 主人 / 上次维修）', '备注')
    if (key === null || key.trim() === '') return
    setDraft((prev) => ({ ...prev, [key.trim()]: '' }))
  }

  const entries = Object.entries(draft)

  return React.createElement(
    'div',
    { className: 'pa-menu', style: { left: Math.min(hit.px, 120), top: Math.min(hit.py, 80) } },
    React.createElement('h4', null, `修改物体状态 — ${object.name}`),
    React.createElement(
      'div',
      { className: 'pa-dim' },
      `id=${object.id}｜@${object.x},${object.y}${Object.keys(object.state).length === 0 ? '' : `｜${Object.entries(object.state).map(([k, v]) => `${k}=${String(v)}`).join(' ')}`}`,
    ),
    React.createElement('div', { className: 'pa-row' }, React.createElement('span', { className: 'pa-dim' }, '名称'), React.createElement('input', { value: name, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value) })),
    React.createElement(
      'div',
      { className: 'pa-row' },
      React.createElement('span', { className: 'pa-dim' }, '坐标'),
      React.createElement('input', { value: x, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setX(e.target.value), style: { maxWidth: 58 } }),
      React.createElement('input', { value: y, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setY(e.target.value), style: { maxWidth: 58 } }),
    ),
    React.createElement('div', { style: { height: 1, background: 'var(--pa-border)', margin: '6px 0' } }),
    entries.length === 0 ? React.createElement('div', { className: 'pa-dim' }, '这个物体还没有状态槽。') : null,
    ...entries.map(([key, value]) => {
      const previous = object.state[key]
      const isBool = typeof previous === 'boolean' || (previous === undefined && BOOL_KEYS.includes(key))
      const isStatus = key === 'status'
      return React.createElement(
        'div',
        { className: 'pa-row', key },
        React.createElement('span', { className: 'pa-dim', style: { minWidth: 58 } }, key),
        isStatus
          ? React.createElement(
              'select',
              {
                value: STATUS_PRESETS.includes(value) ? value : '',
                onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setDraft((prev) => ({ ...prev, [key]: e.target.value })),
              },
              ...[
                ...STATUS_PRESETS.map((preset) => React.createElement('option', { key: preset, value: preset }, preset)),
                // 当前值不在预设里时补一条，而不是把 select 的 value 设成一个
                // 不存在的选项（浏览器会退回第一个，看着像"值被改掉了"）。
                ...(STATUS_PRESETS.includes(value) ? [] : [React.createElement('option', { key: '__current', value: '' }, `（当前：${value}）`)]),
              ],
            )
          : isBool
            ? React.createElement(
                'button',
                {
                  className: 'pa-btn',
                  'data-tiny': 'true',
                  onClick: () => setDraft((prev) => ({ ...prev, [key]: /^(true|1|是|开|on)$/i.test(prev[key] ?? '') ? 'false' : 'true' })),
                },
                /^(true|1|是|开|on)$/i.test(value) ? '是（点击改为否）' : '否（点击改为是）',
              )
            : React.createElement('input', { value, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setDraft((prev) => ({ ...prev, [key]: e.target.value })) }),
        React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', 'data-danger': 'true', onClick: () => setDraft((prev) => { const next = { ...prev }; next[key] = ''; return next }) }, '清'),
      )
    }),
    React.createElement(
      'div',
      { className: 'pa-row', style: { marginTop: 6 } },
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: addKey }, '＋ 加状态键'),
      React.createElement('span', { className: 'pa-spacer' }),
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: onClose }, '取消'),
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', 'data-primary': 'true', onClick: commit }, '保存'),
    ),
    React.createElement(
      'div',
      { className: 'pa-row', style: { marginTop: 4 } },
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', 'data-danger': 'true', onClick: onRemove }, '从沙盒删除这个物体'),
      React.createElement('span', { className: 'pa-dim' }, '（只影响沙盒设定）'),
    ),
    React.createElement('div', { className: 'pa-dim', style: { marginTop: 4 } }, '改动立刻落盘，并写进事件流（含改动者与时间）。'),
  )
}
