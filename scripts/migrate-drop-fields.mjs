/**
 * 沙盒数据字段迁移：移除已废弃的智能体字段。
 *
 * 为什么要写成脚本而不是手改 JSON：沙盒是**明文数据**，它在三个地方各有一份
 * （发货镜像 `assets/smallville.json`、玩家机器上的种入副本 `~/.dsh/.../sandboxes/`、
 * 以及任何玩家自己另存的副本）。手改必然漏掉某一份，而漏掉的那一份会以
 * "字段还在、界面不显示"的形式长期存在——最难发现的那种脏数据。
 *
 * 这个脚本只**删键**，不碰其它任何东西：玩家的坐标、状态槽、事件流、自加的角色
 * 全部原样保留。删掉的键会被如实打印出来，改了什么一目了然。
 *
 * 用法：
 *   node scripts/migrate-drop-fields.mjs fear secret          # 对默认目标
 *   node scripts/migrate-drop-fields.mjs fear secret --file <path-to-sandbox.json>
 *   node scripts/migrate-drop-fields.mjs --list               # 看默认会处理哪些文件
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

function dataHome() {
  const base = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh')
  return join(base, 'dsh-paranim')
}

/** 默认目标：发货镜像 + 玩家机器上所有沙盒副本。 */
export function defaultTargets() {
  const targets = [join(root, 'assets', 'smallville.json')]
  const sandboxes = join(dataHome(), 'sandboxes')
  if (existsSync(sandboxes)) {
    for (const name of readdirSync(sandboxes)) {
      if (name.endsWith('.json')) targets.push(join(sandboxes, name))
    }
  }
  return targets
}

/**
 * 从一个沙盒对象里删掉指定字段（遍历 agents 及其它可能存放角色的数组）。
 * @returns {{ changed: number, fields: string[] }}
 */
export function dropFields(sandbox, fields) {
  const dropped = new Map()
  const scrub = (agent) => {
    if (agent === null || typeof agent !== 'object') return
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(agent, field)) {
        delete agent[field]
        dropped.set(field, (dropped.get(field) ?? 0) + 1)
      }
    }
  }
  for (const key of ['agents', 'characters', 'npcs']) {
    if (Array.isArray(sandbox?.[key])) for (const agent of sandbox[key]) scrub(agent)
  }
  let changed = 0
  for (const count of dropped.values()) changed += count
  return { changed, fields: [...dropped.keys()] }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--list')) {
    console.log('默认目标：')
    for (const file of defaultTargets()) console.log('  ' + file)
    return
  }
  const fileIndex = argv.indexOf('--file')
  const explicit = fileIndex >= 0 ? argv[fileIndex + 1] : undefined
  const fields = argv.filter((a) => !a.startsWith('--') && a !== explicit)
  if (fields.length === 0) {
    console.error('用法：node scripts/migrate-drop-fields.mjs <字段...> [--file <沙盒.json>]')
    process.exit(2)
  }
  const targets = explicit === undefined ? defaultTargets() : [explicit]
  let total = 0
  for (const file of targets) {
    if (!existsSync(file)) {
      console.log(`  跳过（不存在）：${file}`)
      continue
    }
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      console.log(`  跳过（JSON 不合法）：${file} — ${error.message}`)
      continue
    }
    const before = JSON.stringify(parsed)
    const { changed, fields: hit } = dropFields(parsed, fields)
    if (changed === 0) {
      console.log(`  无改动：${file}`)
      continue
    }
    // 只在这一步之后才写盘：JSON.parse 失败的文件一个字节都不会被覆盖。
    writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    total += changed
    console.log(`  已清理 ${changed} 个字段（${hit.join(', ')}）：${file}`)
    void before
  }
  console.log(`\n共清理 ${total} 处。只有键被删除，其它内容原样保留。`)
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('migrate-drop-fields.mjs')) main()
