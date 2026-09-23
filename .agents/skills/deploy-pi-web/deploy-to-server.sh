#!/usr/bin/env bash
#
# 部署 pi-web 构建产物（tarball）到静态服务器。
#
# 用法（从仓库根目录）:
#   .agents/skills/deploy-pi-web/deploy-to-server.sh /abs/path/to/agegr-pi-web-0.9.1.2.tgz
#
# 环境变量（定义在 ~/.bashrc，脚本会先 source）:
#   STATIC_SSH_DEST       ssh 目标，如 root@1.2.3.4 或 ~/.ssh/config 里的别名
#   STATIC_SSH_DEST_PORT  ssh 端口（缺省 22）
#
# 服务器布局（REMOTE_DIR = /root/app/static）:
#   agegr-pi-web-0.9.1.tgz
#   pi-web.tgz -> /root/app/static/agegr-pi-web-0.9.1.tgz   # 始终指向最新
#
# 流程: 校验参数 → scp 上传 → 切换 pi-web.tgz 软链接 → 远端校验。

# 先加载用户环境（拿到 STATIC_SSH_DEST / STATIC_SSH_DEST_PORT），再打开严格
# 模式——顺序不能反：~/.bashrc 里的未定义变量不应触发下面的 set -u。
# shellcheck disable=SC1091
source "$HOME/.bashrc" >/dev/null 2>&1 || true
set -euo pipefail

REMOTE_DIR="/root/app/static"
LINK_NAME="pi-web.tgz"

die() {
  echo "deploy: 错误: $*" >&2
  exit 1
}

# --- 1. 参数：最新构建产物的绝对路径 -------------------------------------------

[[ $# -eq 1 ]] || die "用法: $0 /绝对路径/agegr-pi-web-x.y.z.tgz"
ARTIFACT=$1
[[ $ARTIFACT == /* ]] || die "需要绝对路径，收到: $ARTIFACT"
[[ -f $ARTIFACT ]] || die "文件不存在: $ARTIFACT"
[[ $ARTIFACT == *.tgz ]] || die "只接受 .tgz 构建产物，收到: $ARTIFACT"

BASENAME=$(basename "$ARTIFACT")
# 文件名会拼进远端单引号字符串，含引号/空白时直接拒绝而不是静默出错。
[[ $BASENAME != *[*?\'\ ]* ]] || die "文件名含特殊字符，请重命名: $BASENAME"

# --- 2. 环境变量 ---------------------------------------------------------------

: "${STATIC_SSH_DEST:?请在 ~/.bashrc 中定义 STATIC_SSH_DEST（如 root@host）}"
PORT=${STATIC_SSH_DEST_PORT:-22}

echo "==> 目标: ${STATIC_SSH_DEST}:${PORT}${REMOTE_DIR}"
echo "==> 产物: ${ARTIFACT} ($(du -h "$ARTIFACT" | cut -f1))"

# --- 3. scp 上传 ---------------------------------------------------------------

echo "==> 上传中..."
scp -P "$PORT" -- "$ARTIFACT" "${STATIC_SSH_DEST}:${REMOTE_DIR}/"

# --- 4. 切换软链接 -------------------------------------------------------------

# ln -sfn: 目标链接已存在时替换它，且不跟随旧链接。
echo "==> 切换 ${LINK_NAME} -> ${BASENAME}"
ssh -p "$PORT" "$STATIC_SSH_DEST" "
  set -e
  test -s '${REMOTE_DIR}/${BASENAME}'          # 上传的文件必须在且非空
  ln -sfn '${REMOTE_DIR}/${BASENAME}' '${REMOTE_DIR}/${LINK_NAME}'
"

# --- 5. 远端校验 ---------------------------------------------------------------

echo "==> 服务器当前状态:"
ssh -p "$PORT" "$STATIC_SSH_DEST" "ls -l '${REMOTE_DIR}/${LINK_NAME}'"
echo "==> 完成"
