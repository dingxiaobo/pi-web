#!/usr/bin/env bash
# 依次同步 fork 当前分支、fork main 和开源 upstream 到当前分支。
# 冲突时以非零码退出并打印冲突文件，交由 agent/用户解决。
set -euo pipefail

PROJECT_DIR="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$PROJECT_DIR"

ORIGIN=origin
UPSTREAM=upstream
UPSTREAM_URL="git@github.com:agegr/pi-web.git"
CUR_BRANCH="$(git branch --show-current)"

if [ -z "$CUR_BRANCH" ]; then
  echo "✗ 当前处于 detached HEAD，无法同步分支" >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区有未提交改动，请先 commit/stash 后重试：" >&2
  git status --short >&2
  exit 1
fi

merge_ref() {
  local ref="$1"
  echo "    merge $ref -> $CUR_BRANCH"
  if ! git merge --no-edit "$ref"; then
    echo
    echo "⚠️  合并 $ref 时存在冲突，请解决后继续。冲突文件："
    git diff --name-only --diff-filter=U
    echo
    echo "解决后执行："
    echo "  git add -A && git commit --no-edit"
    echo "  bash .agents/skills/sync-upstream/scripts/merge-upstream.sh"
    exit 1
  fi
}

echo "==> [1/5] 确保 upstream remote"
if ! git remote get-url "$UPSTREAM" >/dev/null 2>&1; then
  git remote add "$UPSTREAM" "$UPSTREAM_URL"
elif [ "$(git remote get-url "$UPSTREAM")" != "$UPSTREAM_URL" ]; then
  git remote set-url "$UPSTREAM" "$UPSTREAM_URL"
fi
echo "    $UPSTREAM -> $(git remote get-url "$UPSTREAM")"

echo "==> [2/5] fetch origin + upstream"
git fetch "$ORIGIN" --prune
git fetch "$UPSTREAM" --tags

echo "==> [3/5] 探测 upstream 默认分支"
git remote set-head "$UPSTREAM" -a 2>/dev/null || true
UP_BRANCH="$(git symbolic-ref --short "refs/remotes/$UPSTREAM/HEAD" 2>/dev/null | sed "s#^$UPSTREAM/##" || true)"
if [ -z "$UP_BRANCH" ]; then
  if git show-ref --verify --quiet "refs/remotes/$UPSTREAM/main"; then
    UP_BRANCH=main
  elif git show-ref --verify --quiet "refs/remotes/$UPSTREAM/master"; then
    UP_BRANCH=master
  else
    echo "✗ 无法确定 upstream 默认分支" >&2
    exit 1
  fi
fi
echo "    upstream 默认分支: $UP_BRANCH"

echo "==> [4/5] 校验 origin 分支"
for ref in "$ORIGIN/$CUR_BRANCH" "$ORIGIN/main"; do
  if ! git show-ref --verify --quiet "refs/remotes/$ref"; then
    echo "✗ 远端分支 $ref 不存在" >&2
    exit 1
  fi
done

echo "==> [5/5] 依次合并 fork 当前分支、fork main、upstream"
merge_ref "$ORIGIN/$CUR_BRANCH"
merge_ref "$ORIGIN/main"
merge_ref "$UPSTREAM/$UP_BRANCH"

echo
echo "✅ 同步完成: $CUR_BRANCH 已包含 $ORIGIN/$CUR_BRANCH、$ORIGIN/main、$UPSTREAM/$UP_BRANCH"
git --no-pager log --oneline -5
