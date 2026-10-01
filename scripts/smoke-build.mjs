/**
 * 渲染冒烟测试的第一步：把渲染函数打成一个自包含的页面。
 *
 * 为什么需要这个：dev 侧的界面改动一直只能靠"重启 dsh 后肉眼看"，因为 dsh
 * 的侧栏面板挂载时好时坏、没法稳定自动化。这里绕开整个宿主，直接把真实渲染
 * 函数装进一个空白页——凡是"瓦片画不出来""图层叠加看不见""编辑器一片黑"
 * 这类问题，都能被自动抓住。
 *
 * 第二步（断言）在 scripts/smoke-run.py：本机只有 python 版 Playwright。
 */
import { build } from 'esbuild'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'lib')
mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'scripts', 'smoke-entry.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  jsx: 'transform',
  loader: { '.json': 'json' },
  outfile: join(outDir, 'smoke.js'),
  logLevel: 'error',
})

writeFileSync(join(outDir, 'smoke.html'), `<!doctype html><meta charset="utf-8">
<title>paranim smoke</title>
<style>body{margin:0;background:#0d1014}canvas{display:block}</style>
<canvas id="cv" width="240" height="160"></canvas>
<script src="./smoke.js"></script>
`)

console.log('  冒烟页面已生成：lib/smoke.html')
