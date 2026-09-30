/**
 * 主题系统：多套配色方案 + 消息栏的三种渲染模式。
 *
 * 设计要点：
 *  1. **主题只改 CSS 变量，不改组件**。所有组件都用 `--pa-*` 变量取色，切主题
 *     只是换一份变量表，不需要任何条件渲染——这样加主题是加数据，不是加分支。
 *  2. **消息着色按语义而不是按序号**。事件本来就分 kind（走/说/做/改/判定/系统…），
 *     判定还带成败；主题为每个语义定义前景色、底色与左边条色，让"谁在说话、
 *     哪条是判定、哪条是状态改动"一眼分得开——这是消息栏可读性的关键，
 *     而不是把行距调大一点。
 *  3. **可发现但克制**：底栏放一个主题选择器（不是藏在设置页），因为在调风格时
 *     需要立刻看到结果。
 *
 * 主题表放在数据里：加一套主题 = 在 `THEMES` 里加一项，不必动渲染代码。
 */
import type { WorldEvent } from '../shared/model.ts'

export type ThemeId = 'obsidian' | 'parchment' | 'terminal' | 'daylight'

/** 消息栏的渲染模式。 */
export type FeedMode = 'card' | 'line' | 'chat'

export const FEED_MODE_LABEL: Record<FeedMode, string> = {
  card: '卡片',
  line: '日志',
  chat: '对白',
}

export interface Theme {
  id: ThemeId
  name: string
  /** 一句话说明这套主题的适用场景。 */
  hint: string
  /** CSS 变量表。键名不带前缀，注入时统一加 `--pa-`。 */
  vars: Record<string, string>
}

/**
 * 四套主题。切换只换变量表。
 *
 * 配色依据：界面底色与小镇（草地绿 + 暖瓦红/蓝瓦）之间要有明确明度差——
 * 地图是主角，工作台必须退到后面。所以四套主题的 `--pa-bg` 都比草地暗或亮一档，
 * 而不是同明度换色相。
 */
export const THEMES: readonly Theme[] = [
  {
    id: 'obsidian',
    name: '黑曜石',
    hint: '深色工作台，地图最亮。默认。',
    vars: {
      bg: '#0b0e13',
      layer: '#121722',
      layer3: '#1a2130',
      layer4: '#222b3d',
      text: '#eef2f8',
      textDim: '#a7b2c6',
      textFaint: '#78849a',
      border: '#2c364a',
      borderSoft: '#1f2635',
      gold: '#ffc861',
      goldDim: '#a8802f',
      accent: '#7aa2f7',
      danger: '#f0736f',
      ok: '#7fc98b',
      warn: '#e8b45f',
      shadow: '0 8px 26px rgba(0,0,0,.5)',
      feedBg: '#0e131c',
      feedRow: '#141b27',
      feedText: '#e4eaf4',
      feedMeta: '#7f8b9f',
      overlay: 'rgba(14,17,23,.86)',
      vignette: 'rgba(0,0,0,.45)',
    },
  },
  {
    id: 'parchment',
    name: '羊皮纸',
    hint: '暖色纸面，适合长时间阅读事件流。',
    vars: {
      bg: '#f4efe4',
      layer: '#faf6ec',
      layer3: '#ffffff',
      layer4: '#efe8d9',
      text: '#2f2a22',
      textDim: '#6b6152',
      textFaint: '#95897a',
      border: '#d9cfbb',
      borderSoft: '#e7dfd0',
      gold: '#a4761f',
      goldDim: '#c9a45a',
      accent: '#3f6d8c',
      danger: '#b4462f',
      ok: '#4a7a45',
      warn: '#a4761f',
      shadow: '0 8px 22px rgba(80,66,42,.18)',
      feedBg: '#fbf8f0',
      feedRow: '#f4eee1',
      feedText: '#2b261e',
      feedMeta: '#8a7d6a',
      overlay: 'rgba(250,246,236,.92)',
      vignette: 'rgba(90,74,48,.18)',
    },
  },
  {
    id: 'terminal',
    name: '终端绿',
    hint: '单色磷光，记事帖式的冷峻感。',
    vars: {
      bg: '#050b07',
      layer: '#08120c',
      layer3: '#0c1a11',
      layer4: '#122417',
      text: '#b9f5cf',
      textDim: '#6fbd8c',
      textFaint: '#4a8a63',
      border: '#17512f',
      borderSoft: '#0f3a22',
      gold: '#8cffb4',
      goldDim: '#3f7f5a',
      accent: '#5ce1a0',
      danger: '#ff8f7a',
      ok: '#8cffb4',
      warn: '#e8e05f',
      shadow: '0 8px 26px rgba(0,0,0,.6)',
      feedBg: '#050d08',
      feedRow: '#0a1810',
      feedText: '#c6f7d8',
      feedMeta: '#5a9c76',
      overlay: 'rgba(5,13,8,.88)',
      vignette: 'rgba(0,0,0,.5)',
    },
  },
  {
    id: 'daylight',
    name: '白昼',
    hint: '浅灰冷调，白背景下不刺眼。',
    vars: {
      bg: '#eef1f6',
      layer: '#f7f9fc',
      layer3: '#ffffff',
      layer4: '#e4e9f2',
      text: '#1d2430',
      textDim: '#5c6779',
      textFaint: '#8b95a6',
      border: '#cfd7e4',
      borderSoft: '#e2e7f0',
      gold: '#9a6b12',
      goldDim: '#c8a765',
      accent: '#2f5fa8',
      danger: '#c0392b',
      ok: '#2f7d4f',
      warn: '#9a6b12',
      shadow: '0 8px 22px rgba(40,52,74,.16)',
      feedBg: '#f9fbfe',
      feedRow: '#eef2f8',
      feedText: '#20283a',
      feedMeta: '#7c8798',
      overlay: 'rgba(247,249,252,.94)',
      vignette: 'rgba(60,74,96,.16)',
    },
  },
]

export const DEFAULT_THEME: ThemeId = 'obsidian'
export const DEFAULT_FEED_MODE: FeedMode = 'card'

export function themeById(id: ThemeId | string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]
}

/** 生成注入用的 CSS 文本（`:root` 作用域由调用方给选择器）。 */
export function themeCss(theme: Theme, selector = '.pa-root'): string {
  const lines = Object.entries(theme.vars).map(([key, value]) => `  --pa-${key}: ${value};`)
  return `${selector} {\n${lines.join('\n')}\n}`
}

// ── 消息的语义分类 ────────────────────────────────────────────────────────
//
// 消息栏的可读性来自"同类同形、异类异色"。这里把事件的 kind + 判定结果
// 压成一个语义键，主题再按语义给出颜色——渲染代码里不该出现任何具体颜色。

export type FeedTone =
  | 'system'      // 世界级的开场/重置
  | 'move'        // 移动
  | 'say'         // 对话
  | 'act'         // 行动
  | 'mutate'      // 状态改动
  | 'directive'   // 用户下的指令
  | 'spawn'       // 入场
  | 'despawn'     // 离场
  | 'rollOk'      // 判定成功
  | 'rollFail'    // 判定失败
  | 'rollCrit'    // 恒定成功（骰面 6）
  | 'rollFumble'  // 恒定失败（骰面 1）

export const TONE_LABEL: Record<FeedTone, string> = {
  system: '世界',
  move: '移动',
  say: '对话',
  act: '行动',
  mutate: '改动',
  directive: '指令',
  spawn: '入场',
  despawn: '离场',
  rollOk: '判定成功',
  rollFail: '判定失败',
  rollCrit: '大成功',
  rollFumble: '大失败',
}

export const TONE_ICON: Record<FeedTone, string> = {
  system: '✦',
  move: '→',
  say: '❝',
  act: '◆',
  mutate: '✎',
  directive: '⌘',
  spawn: '＋',
  despawn: '－',
  rollOk: '✓',
  rollFail: '✗',
  rollCrit: '★★',
  rollFumble: '⚠',
}

/** 把一条事件压成语义色调。判定优先于 kind——判定块本身比它属于哪一类更重要。 */
export function toneOf(event: WorldEvent): FeedTone {
  const roll = event.roll
  if (roll !== undefined) {
    if (roll.decisive === true) return roll.ok === true ? 'rollCrit' : 'rollFumble'
    return roll.ok === true ? 'rollOk' : 'rollFail'
  }
  switch (event.kind) {
    case 'move':
      return 'move'
    case 'say':
      return 'say'
    case 'mutate':
      return 'mutate'
    case 'directive':
      return 'directive'
    case 'spawn':
      return 'spawn'
    case 'despawn':
      return 'despawn'
    case 'system':
      return 'system'
    default:
      return 'act'
  }
}

/** 事件正文里可高亮的片段（引用的话、骰值）：交给渲染层套一层强调色。 */
export interface FeedSegment {
  text: string
  kind: 'plain' | 'quote' | 'dice' | 'object'
}

/**
 * 把事件正文切成带语义的片段。
 *
 * 只认三种在文本里**确实存在**的标记：对话的「…」、判定记录的 `D6=n`、
 * 以及被「」括起来的物件名。不引入正则黑魔法，也不猜——认不出来就当普通文本。
 */
export function segmentsOf(event: WorldEvent): FeedSegment[] {
  const out: FeedSegment[] = []
  const pattern = /「([^」]{1,60})」|(D6=\d)|([^\s「」]+[（(]id=[^\s)）]+[）)])/g
  let last = 0
  for (const match of event.text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (index > last) out.push({ text: event.text.slice(last, index), kind: 'plain' })
    if (match[1] !== undefined) out.push({ text: `「${match[1]}」`, kind: 'quote' })
    else if (match[2] !== undefined) out.push({ text: match[2], kind: 'dice' })
    else if (match[3] !== undefined) out.push({ text: match[3], kind: 'object' })
    last = index + match[0].length
  }
  if (last < event.text.length) out.push({ text: event.text.slice(last), kind: 'plain' })
  return out.length === 0 ? [{ text: event.text, kind: 'plain' }] : out
}
