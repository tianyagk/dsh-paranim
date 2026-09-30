/**
 * 从 `assets/smallville.json` 生成 `src/host/fallback.ts` 的内联兜底数据。
 *
 * 为什么要生成而不是手写：内联兜底是**镜像文件读不到时**的降级路径，两份数据
 * 必须一致。手写一份就意味着改镜像时要记得同步改两处——那种"改了一处忘了另一处"
 * 的漂移，只有在真正降级的那一刻才会被发现，而那正是最不希望出问题的时候。
 *
 * 裁剪口径（兜底不需要可读性，需要的是体积与自洽）：
 *   · places 只留 id/name/kind/x/y/w/h/color/state，丢掉 desc 与 tags；
 *   · objects 保留全部状态槽与 affordances（右键菜单要有东西可改）；
 *   · props 整组丢弃（与 objects 语义重复，兜底只留一套）；
 *   · agents 保留六维、坐标、身份、外貌、性格、目标、计划与随身，截断长文本。
 *
 * 用法：node scripts/gen-fallback.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const raw = JSON.parse(readFileSync(join(root, 'assets', 'smallville.json'), 'utf8'))

const clip = (text, max) => {
  if (typeof text !== 'string') return ''
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`
}

const attrs = (input) => {
  const src = input ?? {}
  const one = (v) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(20, Math.max(1, Math.round(n))) : 7
  }
  return { str: one(src.str), con: one(src.con), dex: one(src.dex), app: one(src.app), int: one(src.int), pow: one(src.pow) }
}

const places = (raw.places ?? []).map((p) => ({
  id: p.id,
  name: p.name,
  kind: 'place',
  x: Math.round(p.x),
  y: Math.round(p.y),
  ...(p.w === undefined ? {} : { w: Math.round(p.w) }),
  ...(p.h === undefined ? {} : { h: Math.round(p.h) }),
  color: p.color,
  interactive: p.interactive !== false,
  state: p.state ?? {},
}))

const objects = [...(raw.objects ?? [])]
  .map((o) => ({
    id: o.id,
    name: o.name,
    kind: o.kind ?? 'prop',
    x: Math.round(o.x),
    y: Math.round(o.y),
    color: o.color,
    interactive: o.interactive !== false,
    state: o.state ?? {},
    ...(Array.isArray(o.affordances) && o.affordances.length > 0 ? { affordances: o.affordances.slice(0, 8) } : {}),
  }))
  // 兜底只保留"能改状态"的物件：没有状态槽的东西放进来只会占位。
  .filter((o) => Object.keys(o.state).length > 0)

const agents = (raw.agents ?? []).map((a) => ({
  id: a.id,
  name: a.name,
  concept: clip(a.concept, 32),
  x: Math.round(a.x),
  y: Math.round(a.y),
  appearance: clip(a.appearance, 32),
  persona: clip(a.persona, 56),
  backstory: clip(a.backstory, 72),
  goal: clip(a.goal, 40),
  attrs: attrs(a.attrs),
  plan: (a.plan ?? []).map((step) => clip(step, 36)).slice(0, 4),
  inventory: (a.inventory ?? []).map((item) => clip(item, 16)).slice(0, 4),
  color: a.color ?? '#7aa2f7',
  portrait: a.portrait ?? '🙂',
}))

const relations = (raw.relations ?? []).map((r) => ({
  a: r.a,
  b: r.b,
  label: r.label,
  affinity: Math.max(-100, Math.min(100, Math.round(Number(r.affinity) || 0))),
}))

const json = (value) => JSON.stringify(value, null, 2).split('\n').map((line, i) => (i === 0 ? line : `  ${line}`)).join('\n')

const out = `/**
 * 内联兜底小镇 —— **由 scripts/gen-fallback.mjs 从 assets/smallville.json 生成，不要手改**。
 *
 * 作用：镜像文件读不到（缺失 / JSON 坏了 / 打包时 assets 没带上）时，引擎与 UI
 * 仍要能立刻可用。因此它是**降级路径**，不追求完整：${places.length} 处地标、
 * ${objects.length} 件可改状态的物件、${agents.length} 位居民，全部取自发货镜像本身，
 * 只是裁掉了长文本与重复的 props 组。
 *
 * 素材出处：${clip(raw.attribution, 160)}
 * 许可：${raw.license ?? '见 assets/README.md'}
 *
 * 改动镜像后请重新生成：node scripts/gen-fallback.mjs
 */
import type { Sandbox } from '../shared/model.ts'

export const INLINE_SMALLVILLE: Sandbox = {
  v: 1,
  id: 'smallville',
  name: 'Smallville · 斯坦福小镇',
  desc: ${JSON.stringify(clip(raw.desc, 120))},
  attribution: ${JSON.stringify(clip(raw.attribution, 200))},
  license: ${JSON.stringify(String(raw.license ?? '见 assets/README.md'))},
  builtin: true,
  createdAt: 0,
  updatedAt: 0,
  map: ${json({ width: raw.map.width, height: raw.map.height, ground: raw.map.ground })},
  places: ${json(places)},
  objects: ${json(objects)},
  relations: ${json(relations)},
  agents: ${json(agents)},
  startTick: 0,
}
`

writeFileSync(join(root, 'src', 'host', 'fallback.ts'), out, 'utf8')
console.log(
  `生成 src/host/fallback.ts：${places.length} 地标 / ${objects.length} 物件 / ${agents.length} 智能体（源：assets/smallville.json）`,
)
