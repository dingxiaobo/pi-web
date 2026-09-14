#!/usr/bin/env bash
#
# 部署 pi-web 构建产物（tarball）到本机并重启服务。
#
# 用法（从仓库根目录）:
#   .agents/skills/deploy-pi-web/deploy-to-local.sh /abs/path/to/agegr-pi-web-0.9.1.2.tgz
#
# 本机布局:
#   npm 全局 prefix:  ~/app/node24（bin 链接在 ~/.local/bin/pi-web）
#   systemd 用户服务: ~/.config/systemd/user/pi-web.service
#                     ExecStart=/home/hermes/.local/bin/pi-web -H 0.0.0.0 --no-open
#
# 流程: 校验参数 → npm 全局安装 tarball → systemctl --user 重启 pi-web → 验证。

set -euo pipefail

SERVICE="pi-web"

die() {
  echo "deploy-local: 错误: $*" >&2
  exit 1
}

# --- 1. 参数：最新构建产物的绝对路径 -------------------------------------------

[[ $# -eq 1 ]] || die "用法: $0 /绝对路径/agegr-pi-web-x.y.z.tgz"
ARTIFACT=$1
[[ $ARTIFACT == /* ]] || die "需要绝对路径，收到: $ARTIFACT"
[[ -f $ARTIFACT ]] || die "文件不存在: $ARTIFACT"
[[ $ARTIFACT == *.tgz ]] || die "只接受 .tgz 构建产物，收到: $ARTIFACT"

BASENAME=$(basename "$ARTIFACT")
[[ $BASENAME == agegr-pi-web-* ]] || die "看起来不是 pi-web 的构建产物: $BASENAME"

# --- 2. npm 全局安装 -----------------------------------------------------------

echo "==> 安装 ${BASENAME} ($(du -h "$ARTIFACT" | cut -f1)) 到全局..."
npm install -g "$ARTIFACT"

echo "==> 当前全局版本:"
npm ls -g @agegr/pi-web --depth=0

# --- 3. 重启 systemd 用户服务 --------------------------------------------------

# ssh/脚本环境下 XDG_RUNTIME_DIR 可能缺失，导致 systemctl --user 连不上用户总线。
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-"/run/user/$(id -u)"}

echo "==> 重启 ${SERVICE}.service..."
systemctl --user restart "$SERVICE"

# --- 4. 验证 -------------------------------------------------------------------

sleep 1
if systemctl --user is-active --quiet "$SERVICE"; then
  echo "==> ${SERVICE} 已激活:"
  systemctl --user status "$SERVICE" --no-pager | sed -n '1,4p'
  echo "==> 完成"
else
  echo "==> ${SERVICE} 未运行！最近日志:" >&2
  journalctl --user -u "$SERVICE" -n 30 --no-pager >&2 || true
  die "服务重启后未进入 active 状态"
fi
