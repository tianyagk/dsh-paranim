#!/usr/bin/env bash
# 找一个带 playwright 的 python：优先 PATH 上的 python3，再退到常见安装位置。
# （本机只有 python 版 Playwright，node 版没装，所以断言那半是 python 写的。）
set -euo pipefail
for py in python3 /home/hu/miniconda3/bin/python; do
  if command -v "$py" >/dev/null 2>&1 && "$py" -c 'import playwright' >/dev/null 2>&1; then
    exec "$py" "$(dirname "$0")/smoke-run.py"
  fi
done
echo "跳过渲染冒烟：本机没有带 playwright 的 python" >&2
exit 0
