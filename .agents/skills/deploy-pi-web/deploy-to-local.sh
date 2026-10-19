#!/usr/bin/env bash
#
# 部署 pi-web 构建产物（tarball）到本机并重启。
#
# 用法（从仓库根目录）:
#   .agents/skills/deploy-pi-web/deploy-to-local.sh /abs/path/to/agegr-pi-web-0.9.1.2.tgz
#
# 本机布局:
#   npm 全局 prefix 由 `npm prefix -g` 决定（本机为 ~/.local/node，
#   可执行文件 ~/.local/node/bin/pi-web）。
#   重启方式: 若 systemd 用户服务 pi-web 可用（用户总线可达且 unit 存在），
#   走 `systemctl --user restart`；否则直接管理进程 —— 停掉现有 pi-web
#   进程后用 nohup 重新拉起，日志追加到 ~/.local/state/pi-web.log。
#
# 流程: 校验参数 → npm 全局安装 tarball → 重启 pi-web → 验证。

set -euo pipefail

SERVICE="pi-web"
RUN_ARGS=(-H 0.0.0.0 --no-open)
LOG_FILE="$HOME/.local/state/pi-web.log"

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

# 可执行文件位置由 npm 全局 prefix 决定，不写死路径。
BIN="$(npm prefix -g)/bin/pi-web"
[[ -x $BIN ]] || die "未找到 pi-web 可执行文件: $BIN"

# --- 2.5 机器本地环境变量（仓库外维护） ----------------------------------------
# 若存在 ~/.config/pi-web/env（KEY=VALUE 行），加载并导出给 pi-web 进程。
# 适合放 PI_WEB_ALLOWED_HOSTS 这类机器相关配置，避免写进项目代码。
ENV_FILE="$HOME/.config/pi-web/env"
if [[ -f $ENV_FILE ]]; then
  echo "==> 加载机器本地环境变量: ${ENV_FILE}"
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

# --- 3. 重启 pi-web -------------------------------------------------------------
# ssh/脚本环境下 XDG_RUNTIME_DIR 可能缺失，导致 systemctl --user 连不上用户总线。
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-"/run/user/$(id -u)"}

# 停掉不在排除名单里的 pi-web 进程。按 $BIN 精确匹配命令行：
# 不会误杀本脚本、也不会碰其他用户/其他路径启动的 pi-web 实例。
# $1（可选）: 要排除的 pid（如 systemd 正在管理的 MainPID）。
stop_pi_web() {
  local exclude_pid=${1:-}
  local pids="" p

  strays() {
    local out=""
    for p in $(pgrep -f "$BIN" || true); do
      if [[ -n $exclude_pid && $p == "$exclude_pid" ]]; then continue; fi
      out+=" $p"
    done
    echo "${out# }"
  }

  pids=$(strays)
  [[ -z $pids ]] && return 0
  echo "==> 停止现有 pi-web 进程 (pid: ${pids})..."
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  for _ in $(seq 1 20); do
    pids=$(strays)
    [[ -z $pids ]] && return 0
    sleep 0.5
  done
  pids=$(strays)
  [[ -z $pids ]] && return 0
  echo "==> 进程未自行退出，强制 SIGKILL..." >&2
  # shellcheck disable=SC2086
  kill -KILL $pids 2>/dev/null || true
}

if systemctl --user cat "$SERVICE" >/dev/null 2>&1; then
  # --- 3a. systemd 用户服务可用 -------------------------------------------------
  # systemd 服务不继承本脚本环境，把 PI_WEB_* 变量导入用户管理器。
  pi_web_envs=("${!PI_WEB_@}")
  if ((${#pi_web_envs[@]} > 0)); then
    systemctl --user import-environment "${pi_web_envs[@]}"
  fi
  # 清理非 systemd 管理的残留进程（如此前 nohup 启动的），避免端口冲突。
  UNIT_PID=$(systemctl --user show "$SERVICE" -p MainPID --value 2>/dev/null || true)
  stop_pi_web "${UNIT_PID:-}"
  echo "==> 重启 ${SERVICE}.service（systemd 用户服务）..."
  systemctl --user restart "$SERVICE"

  # --- 4a. 验证 ------------------------------------------------------------------
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
else
  # --- 3b. 无 systemd 用户服务（如本机 dxb 没有用户总线），直接管理进程 ----------
  echo "==> systemd 用户服务 ${SERVICE} 不可用，直接管理进程..."
  stop_pi_web

  mkdir -p "$(dirname "$LOG_FILE")"
  echo "==> 启动: ${BIN} ${RUN_ARGS[*]}"
  echo "---- $(date '+%F %T') deploy ${BASENAME} ----" >> "$LOG_FILE"
  nohup "$BIN" "${RUN_ARGS[@]}" >> "$LOG_FILE" 2>&1 </dev/null &

  # --- 4b. 验证 ------------------------------------------------------------------
  sleep 2
  NEW_PID=$(pgrep -n -f "$BIN" || true)
  if [[ -n $NEW_PID ]] && kill -0 "$NEW_PID" 2>/dev/null; then
    echo "==> pi-web 已运行 (pid ${NEW_PID}):"
    ps -p "$NEW_PID" -o pid,etime,args --no-headers
    echo "==> 日志: ${LOG_FILE}"
    echo "==> 完成"
  else
    echo "==> pi-web 未存活！最近日志 (${LOG_FILE}):" >&2
    tail -n 30 "$LOG_FILE" >&2 || true
    die "进程启动后未存活"
  fi
fi
