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
    if (tile === undefined) return
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

export { OBJECT_LIBRARY, SLOT_LABEL }
