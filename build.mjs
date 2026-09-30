import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'

/**
 * Build gate: typecheck before bundling, abort on failure.
 * Set PA_SKIP_TYPECHECK=1 only for a debugging build.
 *
 * The two failure modes are reported separately on purpose: "tsc never
 * started" (devDependencies missing / wrong path / no permission) and "tsc
 * found type errors" need different fixes, and reporting the second for the
 * first sends you hunting a type error that does not exist.
 */
if (process.env.PA_SKIP_TYPECHECK !== '1') {
  try {
    execFileSync('node_modules/.bin/tsc', ['--noEmit', '-p', 'tsconfig.json'], { stdio: 'inherit' })
  } catch (error) {
    const status = typeof error?.status === 'number' ? error.status : null
    if (status === null) {
      const reason = error?.code ?? error?.message ?? String(error)
      console.error(`\nBuild aborted: tsc could not start (${reason}).`)
      console.error('This usually means dependencies are missing: run `npm i` at the project root.')
      console.error('Set PA_SKIP_TYPECHECK=1 to skip the gate for a debugging build.\n')
      process.exit(2)
    }
    if (typeof error?.signal === 'string') {
      console.error(`\nBuild aborted: tsc was killed by signal ${error.signal}.\n`)
      process.exit(3)
    }
    console.error(`\nBuild aborted: typecheck failed (tsc --noEmit, exit ${status}).\n`)
    process.exit(1)
  }
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const PA_VERSION = String(pkg.version ?? '0.0.0')

rmSync('lib', { recursive: true, force: true })

/** Module specifiers the web shell shares into the frozen module table. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
]

const banner = `window.__ModuleLoader__.load({
\tid: "dsh-paranim",
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;`

const footer = `return module.exports;
\t}
});`

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  sourcemap: false,
  // assets/ ships beside lib/ and is read from disk at runtime, so the host
  // bundle must not inline it — the default sandbox stays editable on disk.
  external: [],
  loader: { '.json': 'json' },
  define: { 'process.env.NODE_ENV': '"production"', __PA_VERSION__: JSON.stringify(PA_VERSION) },
})

await build({
  entryPoints: ['src/client/index.tsx'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2020',
  sourcemap: false,
  external: CLIENT_EXTERNALS,
  jsx: 'transform',
  define: { 'process.env.NODE_ENV': '"production"', __PA_VERSION__: JSON.stringify(PA_VERSION) },
  banner: { js: banner },
  footer: { js: footer },
})

/**
 * Build-time assertions: esbuild cannot see that a JSX branch was never
 * written, and a silent "one UI piece missing" bug passes tsc and the host
 * selftest. Check the produced client bundle for the load-bearing snippets
 * instead. The bundle escapes non-ASCII to uppercase \uXXXX, so the comparison
 * must use that form or it yields a false negative.
 */
const escapeUpper = (text) =>
  [...text].map((c) => (c.charCodeAt(0) > 127 ? `\\u${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}` : c)).join('')

const REQUIRED_CLIENT_SNIPPETS = [
  'dsh-paranim',        // 侧边栏 tab 注册 id
  '他化自在天',          // tab 标题
  '右键菜单：修改物体状态', // 需求 5 的右键交互入口
  '手动步进',            // 需求 6 的手动步进
  '自动步进',            // 需求 6 的自动步进
  '时间流速',            // 需求 6 的流速设置
  '世界沙盒',            // 需求 2 的沙盒库
  '新增智能体',          // 需求 3 的智能体数量自定义
  '驱动模型',            // 需求 3 的每智能体模型选择
  '下达指令',            // 需求 3 的指令引导
  '力量',                // 需求 4 的 STR
  '意志',                // 需求 4 的 POW
  '内在驱力',            // 需求 3 的想要/恐惧/隐瞒成段
  '恐惧',                // 需求 3 的 fear
  '隐瞒',                // 需求 3 的 secret
  '驱动模型',            // 需求 3 的每智能体模型选择
]

const clientBundle = readFileSync('lib/client.js', 'utf8')
if (!clientBundle.includes(PA_VERSION)) {
  console.error(`\nBuild check failed: lib/client.js does not contain version ${PA_VERSION} (__PA_VERSION__ define did not apply)\n`)
  process.exit(1)
}
const missing = REQUIRED_CLIENT_SNIPPETS.filter(
  (snippet) => !clientBundle.includes(snippet) && !clientBundle.includes(escapeUpper(snippet)),
)
if (missing.length > 0) {
  console.error(`\nBuild check failed: lib/client.js is missing these UI snippets — ${missing.join(' / ')}`)
  console.error('(usually a JSX branch that was never written, or was skipped by a guard)\n')
  process.exit(1)
}

console.log(`built lib/index.js + lib/client.js (v${PA_VERSION}, client snippet check passed: ${REQUIRED_CLIENT_SNIPPETS.length} items)`)
