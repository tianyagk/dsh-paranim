/**
 * 物件资源池：把素材库里的可用贴图**摆出来让人挑**。
 *
 * 为什么要有它：物件此前共用一张通用图——名字里写着"自行车"，画出来还是同一个方块。
 * 现在每个物件都有 `sprite` 字段，这里把 `OBJECT_LIBRARY` 里每个槽位的**真实贴图**
 * 渲染出来，点一下就用在新物件上，或者换掉选中物件的贴图。
 *
 * 只依赖三件事：`PROPS`（槽位 → 图集坐标）、`SLOT_LABEL`（中文名）、`drawTile`（画一格）。
 * 素材里没有的东西不会出现在这里——宁可少一项，也不放一张看不出来的图。
 */
import * as React from 'react'
import { OBJECT_LIBRARY, PROPS, SLOT_LABEL, pickSlot } from './mapStyle.ts'
import { allSheetsReady, drawTile, loadSheets } from './tiles.ts'

/** 按钮边长（CSS 像素）。素材是 16×16，这里放大到 1.5 倍左右才看得清。 */
const CELL = 30
const ZOOM = 1.6

/** 一个槽位的贴图按钮：直接把素材画进 canvas，不用 emoji 代替。 */
export function SpriteButton(props: {
  slot: string
  label?: string
  active?: boolean
  title?: string
  onClick: () => void
}): React.ReactElement {
  const ref = React.useRef<HTMLCanvasElement | null>(null)
  const [ready, setReady] = React.useState(allSheetsReady())

  React.useEffect(() => {
    let alive = true
    if (!ready) {
      void loadSheets().then(() => {
        if (alive) setReady(true)
      })
    }
    return () => {
      alive = false
    }
  }, [ready])

  React.useEffect(() => {
    const canvas = ref.current
    if (canvas === null || !ready) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = CELL * dpr
    canvas.height = CELL * dpr
    const ctx = canvas.getContext('2d')
    if (ctx === null) return
    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    const tile = pickSlot(PROPS, props.slot, 0)
    if (tile === undefined) {
      // 该槽位还没有确认过的贴图：画问号，与地图上的占位保持一致。
      // 画空白的话，看的人只会以为贴图没加载出来。
      ctx.strokeStyle = 'rgba(255,200,97,0.7)'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 2])
      ctx.strokeRect(1.5, 1.5, CELL - 3, CELL - 3)
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,200,97,0.85)'
      ctx.font = '13px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('?', CELL / 2, CELL / 2)
      return
    }
    // drawTile 的语义与地图上一致：给定"底边中点"与缩放，其余交给渲染层
    ctx.save()
    ctx.scale(dpr, dpr)
    drawTile(ctx, tile, CELL / 2, CELL - 1, ZOOM)
    ctx.restore()
  }, [ready, props.slot])

  return React.createElement(
    'button',
    {
      className: 'pa-spr',
      'data-on': props.active === true,
      title: props.title ?? props.label ?? props.slot,
      onClick: props.onClick,
    },
    React.createElement('canvas', { ref, className: 'pa-spr-cv', width: CELL, height: CELL }),
    props.label === undefined
      ? null
      : React.createElement('span', null, props.label),
  )
}

/** 按分组摆出全部可用贴图；点击即回调槽位名。 */
export function SpritePalette(props: {
  activeSlot?: string
  onPick: (slot: string, label: string) => void
  /** 只显示某一组（留空显示全部）。 */
  onlyGroup?: string
}): React.ReactElement {
  const groups = new Map<string, typeof OBJECT_LIBRARY[number][]>()
  for (const entry of OBJECT_LIBRARY) {
    if (props.onlyGroup !== undefined && entry.group !== props.onlyGroup) continue
    if ((PROPS[entry.slot] ?? []).length === 0) continue
    const list = groups.get(entry.group) ?? []
    list.push(entry)
    groups.set(entry.group, list)
  }
  return React.createElement(
    'div',
    { className: 'pa-palette' },
    ...[...groups.entries()].map(([group, entries]) =>
      React.createElement(
        'div',
        { key: group, className: 'pa-pal-group' },
        React.createElement('span', { className: 'pa-dim' }, group),
        React.createElement(
          'div',
          { className: 'pa-sprs' },
          ...entries.map((entry) =>
            React.createElement(SpriteButton, {
              key: entry.slot,
              slot: entry.slot,
              label: entry.label,
              active: entry.slot === props.activeSlot,
              onClick: () => props.onPick(entry.slot, entry.label),
            }),
          ),
        ),
      ),
    ),
  )
}

/**
 * 还没有确认过贴图的槽位（PROPS 里为空）。
 *
 * 资源池不摆它们——点一个画不出东西的按钮没有意义；但也不能假装它们不存在，
 * 界面上会单独列出还差哪几种，好让人知道该去标注器里补。
 */
export const PENDING_SLOTS: readonly string[] = OBJECT_LIBRARY
  .filter((entry) => (PROPS[entry.slot] ?? []).length === 0)
  .map((entry) => entry.label)

export { OBJECT_LIBRARY, SLOT_LABEL }
