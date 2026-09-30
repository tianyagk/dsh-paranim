#!/usr/bin/env bash
# dsh-paranim（他化自在天）安装助手：把插件装进一个 dsh web profile。
#
# 用法:  bash scripts/install.sh [profile-dir] [project-dir]
#   profile-dir  默认 ${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}
#   project-dir  默认本仓库根目录
#
# 做的事：
#   1. 缺 lib/ 就先构建（node build.mjs，内含 tsc 类型门禁）
#   2. 往 profile 的 dependencies 里写 "dsh-paranim": "link:<project>"
#   3. 把 dsh-paranim 追加进 profile 的 dsh.profile.bundles
#   4. 在 profile 里跑 pnpm install
#   5. 打印重启提示（客户端 bundle 需要重启 dsh 才会加载）
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_DIR="${1:-${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}}"
PROJECT_DIR="${2:-$HERE}"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "找不到 profile：$PROFILE_DIR（把它作为 \$1 传入，或设 DSH_PROFILE_DIR）" >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/lib/index.js" ] || [ ! -f "$PROJECT_DIR/lib/client.js" ]; then
  echo "构建 $PROJECT_DIR …"
  (cd "$PROJECT_DIR" && node build.mjs)
fi

node - "$PROFILE_DIR" "$PROJECT_DIR" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const [profileDir, projectDir] = process.argv.slice(2)
const file = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.dependencies = pkg.dependencies ?? {}
pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? []
const spec = `link:${projectDir}`
let changed = false
if (pkg.dependencies['dsh-paranim'] !== spec) {
  pkg.dependencies['dsh-paranim'] = spec
  changed = true
}
if (!pkg.dsh.profile.bundles.includes('dsh-paranim')) {
  pkg.dsh.profile.bundles.push('dsh-paranim')
  changed = true
}
if (!changed) {
  console.log('dsh-paranim 已在', file, '中登记')
} else {
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  console.log('已在', file, '中登记 dsh-paranim')
}
EOF

echo "安装 profile 依赖（pnpm）…"
if command -v pnpm >/dev/null 2>&1; then
  (cd "$PROFILE_DIR" && pnpm install --no-frozen-lockfile)
else
  echo "未找到 pnpm——请手动执行：  (cd $PROFILE_DIR && pnpm install)" >&2
fi

cat <<EOF

✅ dsh-paranim 已在 $PROFILE_DIR 就位

下一步（重要）:
  重启 dsh web 进程，让插件装载（客户端 bundle 也需要重新构建加载）：
    用你启动 web profile 的那条命令/服务重启即可。
  之后在侧边栏「+」菜单里选择「他化自在天」页签。

  沙盒数据落在：  \${DSH_HOME:-~/.dsh}/dsh-paranim/
    sandboxes/        世界沙盒（可编辑的明文 JSON）
    runs/<工作区>/    运行态（步数、记忆、事件流）
    step/<工作区>.json 步进设置（手动/自动 + 时间流速）

  卸载: bash $PROJECT_DIR/scripts/uninstall.sh $PROFILE_DIR
EOF
