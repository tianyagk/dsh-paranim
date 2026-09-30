#!/usr/bin/env bash
# dsh-paranim 卸载助手：从 profile 里摘掉 bundle 与依赖声明。
# 沙盒数据（~/.dsh/dsh-paranim/）默认保留——那里可能有玩家手写的世界。
#
# 用法:  bash scripts/uninstall.sh [profile-dir]
set -euo pipefail

PROFILE_DIR="${1:-${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/web}}"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  echo "找不到 profile：$PROFILE_DIR" >&2
  exit 1
fi

node - "$PROFILE_DIR" <<'EOF'
const fs = require('node:fs')
const path = require('node:path')
const profileDir = process.argv[2]
const file = path.join(profileDir, 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
let changed = false
if (pkg.dependencies && 'dsh-paranim' in pkg.dependencies) {
  delete pkg.dependencies['dsh-paranim']
  changed = true
}
const bundles = pkg.dsh?.profile?.bundles
if (Array.isArray(bundles)) {
  const next = bundles.filter((b) => b !== 'dsh-paranim')
  if (next.length !== bundles.length) {
    pkg.dsh.profile.bundles = next
    changed = true
  }
}
if (changed) {
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  console.log('已从', file, '摘除 dsh-paranim')
} else {
  console.log('dsh-paranim 本来就不在', file, '中')
}
EOF

echo
echo "沙盒数据未删除。要一并清掉（会丢掉你写的世界）请手动执行："
echo "  rm -rf \"\${DSH_HOME:-\$HOME/.dsh}/dsh-paranim\""
