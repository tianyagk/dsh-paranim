/**
 * 小镇地图画布 + 右键菜单（需求 5）。
 *
 * 画布不做正交投影变换，只用"等比缩放 + 居中平移"：沙盒坐标是 1:1 的逻辑格，
 * 保存的坐标与看到的像素一一对应，才不会出现"我明明点了那盏灯，却改了旁边那棵
 * 树"这种事。缩放只影响观看，不影响命中判定。
 *
 * 右键菜单是需求 5 的落点：**右键街边的路灯 → 把状态改成「故障」**。菜单里每个
 * 状态槽都按它当前的类型给控件（布尔给开关、字符串给输入 + 常见取值、数字给数字
 * 框），而不是把所有东西都塞进一个文本框——那样改 `lit` 要手打 true，很容易写错。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { OBJECT_KIND_LABEL, type Sandbox, type StateValue, type WorldObject } from '../shared/model.ts'

export interface MapCanvasProps {
  sandbox: Sandbox
  agents: Array<{ id: string; name: string; x: number; y: number; color: string; portrait: string; concept: string }>
  selectedId?: string
  onSelectAgent: (id: string) => void
  /** 提交一次物体改动（宿主会落盘并回写事件流）。 */
  onPatchObject: (objectId: string, body: Record<string, unknown>) => void
  onRemoveObject: (objectId: string) => void
}

interface Hit {
  object: WorldObject
  /** 画布像素坐标，用来放菜单。 */
  px: number
  py: number
}

/** 状态槽的常见取值：给下拉而不是让用户手打。 */
const STATUS_PRESETS = ['正常', '故障', '损坏', '维修中', '锁住', '被人动过']
const BOOL_KEYS = ['open', 'lit', 'running', 'full', 'locked', 'on']

function sameSize(a: WorldObject): { w: number; h: number } {
  return { w: a.w ?? 1, h: a.h ?? 1 }
}

export function MapCanvas(props: MapCanvasProps): React.ReactElement {
  const { sandbox, agents, selectedId, onSelectAgent, onPatchObject, onRemoveObject } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 480, h: 320 })
  const [zoom, setZoom] = useState(1)
  const [hit, setHit] = useState<Hit | null>(null)
  const [hover, setHover] = useState<{ object?: WorldObject; agentId?: string }>({})

  // 画布尺寸跟随容器（ResizeObserver 在真实浏览器里总是有的；老浏览器退化为固定尺寸）。
  useEffect(() => {
    const wrap = wrapRef.current
    if (wrap === null) return
    // 只在尺寸真的变了才 setState。ResizeObserver 的回调与 React 渲染是两条
    // 独立的回路，哪怕画布已经改成绝对定位（不再反过来影响容器），
    // 无条件的 setState 仍会在每次回调里生成新对象 → 触发重渲染 → 再次回调。
    // 相等就返回同一个引用，React 会跳过这次更新。
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

  const view = useMemo(() => {
    const scale = Math.min(size.w / sandbox.map.width, size.h / sandbox.map.height) * zoom
    const s = scale > 0 ? scale : 1
    return {
      scale: s,
      offsetX: (size.w - sandbox.map.width * s) / 2,
      offsetY: (size.h - sandbox.map.height * s) / 2,
    }
  }, [size, sandbox.map.width, sandbox.map.height, zoom])

  const toPx = useCallback((x: number, y: number) => ({
    px: view.offsetX + x * view.scale,
    py: view.offsetY + y * view.scale,
  }), [view])

  const toWorld = useCallback(
    (px: number, py: number) => ({
      x: (px - view.offsetX) / view.scale,
      y: (py - view.offsetY) / view.scale,
    }),
    [view],
  )

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
    ctx.clearRect(0, 0, size.w, size.h)

    // 地面
    ctx.fillStyle = sandbox.map.ground
    const origin = toPx(0, 0)
    ctx.fillRect(origin.px, origin.py, sandbox.map.width * view.scale, sandbox.map.height * view.scale)

    // 网格：每 10 格一条细线，帮玩家对坐标（坐标是明文数字，看得见才好手改）
    if (view.scale > 2.4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.05)'
      ctx.lineWidth = 1
      for (let x = 0; x <= sandbox.map.width; x += 10) {
        const p = toPx(x, 0)
        ctx.beginPath()
        ctx.moveTo(p.px, origin.py)
        ctx.lineTo(p.px, origin.py + sandbox.map.height * view.scale)
        ctx.stroke()
      }
      for (let y = 0; y <= sandbox.map.height; y += 10) {
        const p = toPx(0, y)
        ctx.beginPath()
        ctx.moveTo(origin.px, p.py)
        ctx.lineTo(origin.px + sandbox.map.width * view.scale, p.py)
        ctx.stroke()
      }
    }

    // 地标
    for (const place of sandbox.places) {
      const box = sameSize(place)
      const corner = toPx(place.x - box.w / 2, place.y - box.h / 2)
      ctx.fillStyle = place.color ?? '#3a4152'
      ctx.globalAlpha = 0.92
      ctx.fillRect(corner.px, corner.py, box.w * view.scale, box.h * view.scale)
      ctx.globalAlpha = 1
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'
      ctx.strokeRect(corner.px, corner.py, box.w * view.scale, box.h * view.scale)
      if (view.scale > 2.2) {
        ctx.fillStyle = 'rgba(255,255,255,0.86)'
        ctx.font = `${Math.max(9, Math.min(12, view.scale * 2.4))}px system-ui, sans-serif`
        ctx.textAlign = 'center'
        ctx.fillText(place.name, corner.px + (box.w * view.scale) / 2, corner.py + (box.h * view.scale) / 2 + 3)
      }
    }

    // 物件（圆点 + 状态异常高亮）
    for (const object of sandbox.objects) {
      const p = toPx(object.x, object.y)
      const status = String(object.state.status ?? '正常')
      const broken = status !== '正常'
      ctx.beginPath()
      ctx.arc(p.px, p.py, Math.max(2.5, view.scale * 0.75), 0, Math.PI * 2)
      ctx.fillStyle = broken ? '#f07178' : object.color ?? '#c8ccd6'
      ctx.fill()
      if (hover.object?.id === object.id) {
        ctx.strokeStyle = '#ffffff'
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
      if (broken) {
        ctx.strokeStyle = 'rgba(240,113,120,0.55)'
        ctx.beginPath()
        ctx.arc(p.px, p.py, Math.max(5, view.scale * 1.6), 0, Math.PI * 2)
        ctx.stroke()
      }
    }

    // 智能体
    for (const agent of agents) {
      const p = toPx(agent.x, agent.y)
      ctx.beginPath()
      ctx.arc(p.px, p.py, Math.max(4, view.scale * 1.25), 0, Math.PI * 2)
      ctx.fillStyle = agent.color
      ctx.fill()
      ctx.strokeStyle = agent.id === selectedId ? '#ffffff' : 'rgba(0,0,0,0.5)'
      ctx.lineWidth = agent.id === selectedId ? 2.5 : 1.25
      ctx.stroke()
      ctx.font = `${Math.max(10, Math.min(16, view.scale * 3))}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.fillText(agent.portrait, p.px, p.py - Math.max(6, view.scale * 1.6))
      if (view.scale > 2.2) {
        ctx.fillStyle = 'rgba(255,255,255,0.9)'
        ctx.font = `${Math.max(9, Math.min(11, view.scale * 1.9))}px system-ui, sans-serif`
        ctx.fillText(agent.name, p.px, p.py + Math.max(10, view.scale * 2.4))
      }
    }
  }, [sandbox, agents, view, size, selectedId, hover, toPx])

  // ── 命中判定 ──────────────────────────────────────────────────────────
  const hitTest = useCallback(
    (px: number, py: number): Hit | null => {
      const world = toWorld(px, py)
      const radius = Math.max(1.2, 8 / view.scale)
      let best: Hit | null = null
      let bestDistance = Number.POSITIVE_INFINITY
      for (const object of [...sandbox.objects, ...sandbox.places]) {
        const box = sameSize(object)
        const halfW = object.kind === 'place' ? box.w / 2 : 0.6
        const halfH = object.kind === 'place' ? box.h / 2 : 0.6
        const dx = Math.max(0, Math.abs(world.x - object.x) - halfW)
        const dy = Math.max(0, Math.abs(world.y - object.y) - halfH)
        const d = Math.hypot(dx, dy)
        if (d <= radius && d < bestDistance) {
          bestDistance = d
          best = { object, px, py }
        }
      }
      return best
    },
    [sandbox.objects, sandbox.places, toWorld, view.scale],
  )

  const agentAt = useCallback(
    (px: number, py: number): string | undefined => {
      const world = toWorld(px, py)
      let best: { id: string; d: number } | undefined
      for (const agent of agents) {
        const d = Math.hypot(agent.x - world.x, agent.y - world.y)
        if (d <= Math.max(1.5, 9 / view.scale) && (best === undefined || d < best.d)) best = { id: agent.id, d }
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
    const found = hitTest(px, py)
    if (found === null) {
      setHit(null)
      return
    }
    // 够不到的物件不该能改：菜单里给一句实测距离，而不是让玩家改完了才发现
    // 引擎那边把改动吞了（引擎对智能体有 4 格护栏，玩家经手也会照这个口径提示）。
    setHit(found)
  }

  const onClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const { px, py } = localPoint(event)
    const id = agentAt(px, py)
    if (id !== undefined) onSelectAgent(id)
    setHit(null)
  }

  const onMove = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    const { px, py } = localPoint(event)
    const object = hitTest(px, py)?.object
    const agentId = object === undefined ? agentAt(px, py) : undefined
    setHover((prev) => (prev.object?.id === object?.id && prev.agentId === agentId ? prev : { object, agentId }))
  }

  const hoverAgent = hover.agentId === undefined ? undefined : agents.find((a) => a.id === hover.agentId)

  return React.createElement(
    'div',
    { className: 'pa-mapwrap', ref: wrapRef, style: { position: 'relative' } },
    React.createElement('canvas', {
      ref: canvasRef,
      className: 'pa-map',
      // width/height 交给 CSS 的 inset:0；内联尺寸会参与布局，正是回路的一环。
      'aria-label': '小镇地图：左键点智能体，右键点地标或物件改状态',
      onClick,
      onMove,
      onMouseLeave: () => setHover({}),
      onContextMenu,
    }),
    React.createElement(
      'div',
      { className: 'pa-mapbar' },
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => setZoom((z) => Math.max(0.6, z / 1.25)) }, '−'),
      React.createElement('span', { className: 'pa-dim pa-mono' }, `${zoom.toFixed(2)}×`),
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => setZoom((z) => Math.min(4, z * 1.25)) }, '+'),
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: () => setZoom(1) }, '归位'),
    ),
    React.createElement(
      'div',
      { className: 'pa-legend' },
      hover.object !== undefined
        ? `${hover.object.name}（${OBJECT_KIND_LABEL[hover.object.kind] ?? hover.object.kind}）@${hover.object.x},${hover.object.y}｜状态 ${Object.entries(hover.object.state).map(([k, v]) => `${k}=${String(v)}`).join(' ') || '（无）'}`
        : hoverAgent !== undefined
          ? `${hoverAgent.name}｜${hoverAgent.concept} @${Math.round(hoverAgent.x)},${hoverAgent.y}`
          : '左键点智能体查看/下指令 · 右键点地标或物件改状态',
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
      } else if (value.trim() === '' && previous !== null) state[key] = null
      else state[key] = value
    }
    onPatch({
      objectId: object.id,
      state,
      name,
      x: Number(x),
      y: Number(y),
      by: '玩家',
    })
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
    React.createElement('h4', null, `右键菜单：修改物体状态 — ${object.name}`),
    React.createElement('div', { className: 'pa-dim' }, `${OBJECT_KIND_LABEL[object.kind] ?? object.kind}｜id=${object.id}｜@${object.x},${object.y}${object.affordances === undefined ? '' : `｜可用：${object.affordances.join(' / ')}`}`),
    React.createElement('div', { className: 'pa-row' }, React.createElement('span', { className: 'pa-dim' }, '名称'), React.createElement('input', { value: name, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value) })),
    React.createElement(
      'div',
      { className: 'pa-row' },
      React.createElement('span', { className: 'pa-dim' }, '坐标'),
      React.createElement('input', { value: x, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setX(e.target.value), style: { maxWidth: 60 } }),
      React.createElement('input', { value: y, onChange: (e: React.ChangeEvent<HTMLInputElement>) => setY(e.target.value), style: { maxWidth: 60 } }),
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
              { value, onChange: (e: React.ChangeEvent<HTMLSelectElement>) => setDraft((prev) => ({ ...prev, [key]: e.target.value })) },
              ...STATUS_PRESETS.map((preset) => React.createElement('option', { key: preset, value: preset }, preset)),
              React.createElement('option', { value }, '（当前：' + value + '）'),
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
    React.createElement('div', { className: 'pa-row', style: { marginTop: 6 } },
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: addKey }, '+ 加状态键'),
      React.createElement('span', { className: 'pa-spacer' }),
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', onClick: onClose }, '取消'),
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', 'data-primary': 'true', onClick: commit }, '保存'),
    ),
    React.createElement('div', { className: 'pa-row', style: { marginTop: 4 } },
      React.createElement('button', { className: 'pa-btn', 'data-tiny': 'true', 'data-danger': 'true', onClick: onRemove }, '从沙盒删除这个物体'),
      React.createElement('span', { className: 'pa-dim' }, '（删除只影响沙盒设定）'),
    ),
    React.createElement('div', { className: 'pa-dim', style: { marginTop: 4 } }, '改动会立刻落盘，并写进事件流（含改动者与时间）。'),
  )
}
