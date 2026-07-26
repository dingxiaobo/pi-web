#!/usr/bin/env bash
# 构建 pi-web 生产模式到部署目录并用 pm2 重启
# - rsync 源码 -> 部署目录（保留 .next / logs / node_modules 软链）
# - 软链 node_modules -> 源项目（避免 1.5G 重复）
# - npm run build（产出部署目录的 .next）
# - pm2 restart pi-web（首次自动 pm2 start + pm2 save）
set -euo pipefail

PROJECT_DIR="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
DEPLOY_DIR="/home/dxb/app/pi-web"
PM2_NAME="pi-web"
ECO_FILE="$DEPLOY_DIR/ecosystem.config.cjs"

echo "==> [1/5] 同步源码到部署目录 (rsync --delete, 保留 .next/logs/node_modules)"
mkdir -p "$DEPLOY_DIR/logs"
rsync -a --delete \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.git' \
  --exclude='.agents' \
  --exclude='logs' \
  "$PROJECT_DIR"/ "$DEPLOY_DIR"/

echo "==> [2/5] 软链 node_modules -> 源项目"
if [ -L "$DEPLOY_DIR/node_modules" ] || [ ! -e "$DEPLOY_DIR/node_modules" ]; then
  ln -sfn "$PROJECT_DIR/node_modules" "$DEPLOY_DIR/node_modules"
else
  echo "    警告: $DEPLOY_DIR/node_modules 是真实目录，跳过软链（如需软链请先删除）"
fi

echo "==> [3/5] 生产构建 (输出到 $DEPLOY_DIR/.next)"
cd "$DEPLOY_DIR"
NODE_ENV=production npm run build

echo "==> [4/5] pm2 重启"
if pm2 describe "$PM2_NAME" >/dev/null 2>&1; then
  pm2 restart "$PM2_NAME" --update-env
else
  pm2 start "$ECO_FILE"
  pm2 save
  echo "    (首次启动，已 pm2 save；开机自启需额外执行一次 pm2 startup)"
fi

echo "==> [5/5] 状态"
pm2 describe "$PM2_NAME" 2>/dev/null | grep -E "status|pid|exec mode|cwd|script args" || true
echo
echo "✅ 部署完成: http://0.0.0.0:30141  (监听 0.0.0.0:30141)"
