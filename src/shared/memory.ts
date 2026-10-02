/**
 * 记忆检索（P0）。
 *
 * 对照 Stanford《Generative Agents》第 4.1 节：记忆不是"最近 N 条"，而是按
 *   score = α·recency + α·importance + α·relevance   （论文里三个 α 都是 1）
 * 选出一小撮最相关的。原文的说法是——把所有记忆塞进提示词会**分散模型注意力**，
 * 而且根本塞不下；要做的是"浮出相关的那几条"。
 *
 * 本项目此前的做法是固定取最近若干条，于是：
 *  · 刚说过的话一定盖住昨天的事（只有 recency）；
 *  · "我在这个厨房里做过什么"根本检索不出来（没有 relevance）；
 *  · 一句随口的问候和一次冲突权重相同（没有 importance）。
 *
 * ── 与论文的两处务实偏离（都写在这里，便于将来替换）──────────────────
 *
 * 1. **relevance 用 2-gram 重叠，而不是 embedding 余弦。**
 *    本项目没有 embedding 服务，硬引一个会带来外部依赖与延迟。而在小镇这个
 *    场景里，人名、地名、物件名在文本里高度重复（"林清""厨房""炉子"），
 *    字面重叠比通用语义相似度**更准**。将来若要接 embedding，只需换掉
 *    `relevanceOf` 一个函数。
 *
 * 2. **importance 先按 kind 启发式，而不是每次创建都调一次 LLM。**
 *    论文是创建记忆时让模型打 1–10 分，那意味着记忆写入也要一次模型调用
 *    （成本与延迟都翻倍）。这里先给出一个够用的静态表，并且允许在写入时
 *    显式覆盖（`importanceOf` 的第三个参数）——将来接上模型打分，只改调用方。
 */
import type { MemoryEntry, MemoryKind } from './model.ts'

/** 中文没有空格，用相邻二字（2-gram）近似："厨房" 会命中 "在厨房做饭"。 */
export function tokensOf(text: string): string[] {
  const clean = text.replace(/[\s\p{P}\p{S}]+/gu, '')
  if (clean.length === 0) return []
  if (clean.length === 1) return [clean]
  const out = new Set<string>()
  for (let i = 0; i + 2 <= clean.length; i += 1) out.add(clean.slice(i, i + 2))
  /**
   * 丢掉**纯数字**的词。
   *
   * 坐标一类的数字切出来是 "55"、"房5"、"5准" 这种噪音：既不是语义，又会在
   * 算 relevance 时把分母撑大——于是"厨房"这种真正的实词命中一次只值几分之一，
   * 被时间上的新鲜感轻易压过去。凡是带数字的片段一律丢掉。
   */
  return [...out].filter((t) => !/[0-9]/.test(t))
}

/**
 * 一件事有多要紧。数值参考论文里给模型的例子：
 * 1 = 刷牙、铺床；10 = 分手、拿到录取通知。
 */
const IMPORTANCE_BY_KIND: Record<MemoryKind, number> = {
  whisper: 8,     // 有人专门对我说的话（含上级指令——那是下一步必须照做的）
  reflection: 8,  // 反思本来就是从一堆事里提炼出来的
  summary: 7,     // 来历摘要
  speech: 6,      // 对话
  observation: 5,
  event: 5,
  plan: 5,
  thought: 4,
  action: 3,      // 自己随手做的事，最不值钱
}

const DEFAULT_IMPORTANCE = 5

/** 推导一条记忆的要紧程度；老数据没有该字段时也走这里。 */
export function importanceOf(entry: { kind: MemoryKind; text: string; importance?: number }): number {
  if (typeof entry.importance === 'number' && entry.importance > 0) return entry.importance
  let base = IMPORTANCE_BY_KIND[entry.kind] ?? DEFAULT_IMPORTANCE
  // 长句子通常承载更多信息；但别让它盖过 kind 本身的判断
  if (entry.text.length > 60) base += 1
  if (entry.text.length < 8) base -= 1
  return Math.max(1, Math.min(10, base))
}

/** recency 的衰减底数（论文用的是 0.995，按沙盒小时计）。 */
export const RECENCY_DECAY = 0.995
/**
 * 按"步"衰减的底数。
 *
 * 论文那 0.995 的单位是**沙盒小时**；本项目一步只相当于几分钟，直接照搬
 * 会让十分钟前的琐事和十分钟前的大事得分几乎一样（0.98^10 还有 0.82），
 * recency 就失去了筛选力。取 0.93：十步前衰减到约 0.48，一步前仍有 0.93——
 * "刚发生的"占优，但**压不住一条高度相关或高度重要的旧记忆**。
 */
export const RECENCY_DECAY_PER_TICK = 0.93

export interface RetrievedMemory {
  entry: MemoryEntry
  score: number
  recency: number
  importance: number
  relevance: number
}

/**
 * 按当前情境取出最该被想起的那几条。
 *
 * @param query 当前情境的文本（一般是观察里那几行），用来算 relevance
 * @param nowTick 当前世界步，用于 recency
 * @param k 最多取几条（论文按 context window 截，这里给个固定上限）
 */
export function retrieveMemories(
  memories: readonly MemoryEntry[],
  query: string,
  nowTick: number,
  k: number,
): RetrievedMemory[] {
  if (memories.length === 0 || k <= 0) return []
  const queryTokens = new Set(tokensOf(query))

  const scored: RetrievedMemory[] = memories.map((entry) => {
    // recency：距上次被取用过去了多少步。从没取用过就从它发生时算起。
    const since = Math.max(0, nowTick - (entry.lastAccessTick ?? entry.tick))
    const recency = RECENCY_DECAY_PER_TICK ** since

    const importance = importanceOf(entry) / 10

    /**
     * relevance：查询词被这条记忆覆盖了多少。
     *
     * **开平方**再参与相加。原因是三项要能互相抗衡：命中率本身是 1/词数，
     * 而 query 一长（地点名 + 若干计划项），命中一次就只剩零点几分，会被
     * recency 那零点几的差轻易压过去——"我在厨房"就想不起厨房里发生过的事，
     * 这恰恰是引入检索要解决的问题。开方把低命中率抬起来（1/3 → 0.58），
     * 又不至于让命中一次的短句压过命中三次的长句。
     */
    let relevance = 0
    if (queryTokens.size > 0) {
      const own = new Set(entry.tokens ?? tokensOf(entry.text))
      let hit = 0
      for (const t of queryTokens) if (own.has(t)) hit += 1
      relevance = Math.sqrt(hit / queryTokens.size)
    }

    return { entry, recency, importance, relevance, score: recency + importance + relevance }
  })

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k)
}

/** 把检索结果写成提示词里的几行；同时刷新 lastAccessTick（下次衰减从这里算）。 */
export function formatRetrieved(list: readonly RetrievedMemory[], nowTick: number): string[] {
  return list.map((r) => {
    r.entry.lastAccessTick = nowTick
    return `- ${r.entry.text}`
  })
}

/** 攒够多少条新记忆就值得反思一次（论文里折算下来是每天两三次）。 */
export const REFLECT_EVERY = 24
/** 反思时最多回看多少条。 */
export const REFLECT_WINDOW = 100

/**
 * 该不该反思。
 *
 * 单独抽出来是为了能测：真反思要调模型，而"什么时候调"是纯判断。
 * 条件有两条——新记忆攒够了，而且**最近确实有事发生**（全是自己随手做的
 * 日常动作时不值得，那种反思只会产出"我最近在散步"这种废话）。
 */
export function shouldReflect(
  memories: readonly MemoryEntry[],
  lastReflectAt: number | undefined,
): boolean {
  const fresh = memories.slice(lastReflectAt ?? 0)
  if (fresh.length < REFLECT_EVERY) return false
  // 至少有一条来自外界（别人说的话、发生的事），而不是清一色自己的动作
  return fresh.some((m) => m.kind !== 'action' && m.kind !== 'thought')
}

/** 反思用的提示词：让模型从经历里提炼，而不是复述。 */
export function reflectionPrompt(name: string, memories: readonly MemoryEntry[]): string {
  const lines = memories.slice(-REFLECT_WINDOW).map((m) => `- ${m.text}`).join('\n')
  return [
    `以下是${name}最近的经历：`,
    lines,
    '',
    `请用 2–3 句话写下${name}此刻的感想：这些经历让ta对身边的人或事有了什么新的认识？`,
    '要求：写ta自己的判断与态度，不要复述事件；用第一人称；只输出这几句话本身。',
  ].join('\n')
}
