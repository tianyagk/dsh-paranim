/**
 * 在 house 沙盒里跑 5–10 步并逐步观察：哪一步用什么模型、产出了什么、有没有降级。
 *
 * 用法：
 *   node scripts/simulate-house.mjs                     # 6 步，模型用 workbuddy/cn:hy4-preview-f
 *   node scripts/simulate-house.mjs --steps 8 --model workbuddy/cn:auto
 *   node scripts/simulate-house.mjs --dry               # 只做离线预演，不打网络
 *
 * 为什么单独写一个脚本而不是让你手点：步进是"每步一次模型调用、四个智能体并发"，
 * 出错时需要在**同一份数据**上反复试。脚本把"载入 → 统一模型 → 逐步 → 汇总"固定下来，
 * 失败时能直接看是哪一步、哪个智能体、降级原因是什么。
 */
const BASE = process.env.PARANIM_BASE ?? 'http://127.0.0.1:3080'
const args = process.argv.slice(2)
const pickArg = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const STEPS = Math.max(1, Math.min(10, Number(pickArg('--steps', '6'))))
const MODEL = String(pickArg('--model', 'workbuddy/cn:hy4-preview-f'))
const SANDBOX = String(pickArg('--sandbox', 'house'))
const DRY = args.includes('--dry')

async function call(path, body, timeoutMs = 300000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error(`超时 ${timeoutMs}ms`)), timeoutMs)
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await res.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`响应不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
    }
    if (!parsed.ok) throw new Error(`${path} → ${parsed.error ?? `HTTP ${res.status}`}`)
    return parsed.data
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  console.log(`目标 ${BASE}｜沙盒 ${SANDBOX}｜模型 ${MODEL}｜步数 ${STEPS}${DRY ? '｜(离线预演)' : ''}\n`)

  // 0) 模型是否在当前目录里 —— 先查再加，避免把一个不存在的路由写进每个智能体
  const models = await call('/paranim/models')
  const hit = (models.models ?? []).find((m) => `${m.provider}/${m.model}` === MODEL)
  console.log(`可用模型 ${models.models?.length ?? 0} 个；${MODEL} ${hit ? '✅ 在目录里' : '❌ 不在目录里'}`)
  if (!hit) {
    const near = (models.models ?? []).filter((m) => m.model.includes('hy4') || m.provider === MODEL.split('/')[0])
    for (const m of near) console.log(`    近似的候选：${m.provider}/${m.model}（${m.modelName}）`)
    if (!DRY) throw new Error(`模型 ${MODEL} 不在宿主已注册的 provider 目录里，无法继续`)
  }

  // 1) 载入 house
  const world = await call('/paranim/sandbox', { action: 'select', id: SANDBOX })
  console.log(`沙盒 ${world.sandbox.id}（${world.sandbox.map.width}×${world.sandbox.map.height}）｜居民 ${world.agentCount}\n`)

  // 2) 四个智能体统一模型
  for (const agent of world.run.agents) {
    await call('/paranim/agent', { op: 'patch', agentId: agent.id, patch: { model: { provider: MODEL.split('/')[0], model: MODEL.split('/').slice(1).join('/') } } })
  }
  const after = await call('/paranim/world')
  console.log('模型已统一：')
  for (const a of after.run.agents) console.log(`  ${a.name} → ${a.model ? `${a.model.provider}/${a.model.model}` : '（跟随默认）'}`)
  console.log('')

  if (DRY) {
    console.log('离线预演完成：模型目录、沙盒载入、模型写入三步都通。')
    return
  }

  // 3) 逐步跑
  const summary = []
  for (let i = 1; i <= STEPS; i += 1) {
    const started = Date.now()
    let result
    try {
      result = await call('/paranim/step', {})
    } catch (error) {
      console.error(`\n第 ${i} 步失败：${error.message}`)
      summary.push({ step: i, ok: false, note: error.message })
      break
    }
    const ms = Date.now() - started
    const fallbacks = result.outcomes.filter((o) => o.source !== 'model')
    console.log(`第 ${result.tick} 步（${ms}ms）驱动 ${result.driven} 人｜事件 ${result.events.length} 条｜降级 ${fallbacks.length}`)
    for (const o of result.outcomes) console.log(`  ${o.source === 'model' ? '✓' : '⚠'} ${o.agentName}：${o.detail.slice(0, 90)}`)
    const rolls = result.events.filter((e) => e.roll !== undefined)
    for (const e of rolls) console.log(`      🎲 ${e.roll.text.slice(0, 100)}`)
    const moves = result.events.filter((e) => e.kind === 'move')
    for (const e of moves) console.log(`      🚶 ${e.text.slice(0, 100)}`)
    for (const e of result.events.filter((ev) => ev.kind === 'act' || ev.kind === 'say').slice(0, 4)) {
      console.log(`      ${e.kind === 'say' ? '💬' : '◆'} ${e.text.slice(0, 100)}`)
    }
    console.log('')
    summary.push({ step: result.tick, ok: fallbacks.length === 0, note: fallbacks.map((f) => `${f.agentName}: ${f.detail.slice(0, 60)}`).join(' / ') })
  }

  // 4) 汇总：心情与想法是否随步进变化
  const fin = await call('/paranim/world')
  console.log('=== 收尾状态 ===')
  for (const a of fin.run.agents) {
    const mood = a.mood ? `${a.mood.label} ${a.mood.value}/10` : '（无）'
    const thought = [...a.memory].reverse().find((m) => m.kind === 'thought')
    console.log(`  ${a.name.padEnd(5)} 心情 ${mood.padEnd(12)} 步数 ${a.stepsTaken}　想法：${(thought?.text ?? '（无）').slice(0, 46)}`)
  }
  const bad = summary.filter((s) => !s.ok)
  console.log(`\n共 ${summary.length} 步，其中带降级的 ${bad.length} 步`)
  for (const b of bad) console.log(`  第 ${b.step} 步：${b.note}`)
}

main().catch((error) => {
  console.error(`\n中断：${error.message}`)
  process.exit(1)
})
