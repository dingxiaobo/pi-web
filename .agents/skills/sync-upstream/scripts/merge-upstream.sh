#!/usr/bin/env bash
# 合并上游 agegr/pi-web 最新代码到当前分支
# - 确保 upstream remote
# - fetch + 探测上游默认分支
# - git merge --no-edit upstream/<默认分支>
# 冲突时以非零码退出并打印冲突文件，交由 agent/用户解决。
set -euo pipefail

PROJECT_DIR="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$PROJECT_DIR"

REMOTE=upstream
URL="git@github.com:agegr/pi-web.git"

echo "==> [1/4] 确保 upstream remote"
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  git remote add "$REMOTE" "$URL"
elif [ "$(git remote get-url "$REMOTE")" != "$URL" ]; then
  git remote set-url "$REMOTE" "$URL"
fi
echo "    $REMOTE -> $(git remote get-url "$REMOTE")"

echo "==> [2/4] fetch upstream"
git fetch "$REMOTE" --tags

echo "==> [3/4] 探测 upstream 默认分支"
git remote set-head "$REMOTE" -a 2>/dev/null || true
UP_BRANCH="$(git symbolic-ref --short "refs/remotes/$REMOTE/HEAD" 2>/dev/null | sed "s#^$REMOTE/##" || true)"
if [ -z "$UP_BRANCH" ]; then
  if git show-ref --verify --quiet "refs/remotes/$REMOTE/main"; then
    UP_BRANCH=main
  elif git show-ref --verify --quiet "refs/remotes/$REMOTE/master"; then
    UP_BRANCH=master
  else
    echo "✗ 无法确定 upstream 默认分支，请手动指定后重试" >&2
    exit 1
  fi
fi
echo "    upstream 默认分支: $UP_BRANCH"

CUR_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "==> [4/4] merge upstream/$UP_BRANCH -> $CUR_BRANCH"

# 工作区必须干净
if [ -n "$(git status --porcelain)" ]; then
  echo "✗ 工作区有未提交改动，请先 commit/stash 后重试：" >&2
  git status --short >&2
  exit 1
fi

if ! git merge --no-edit "$REMOTE/$UP_BRANCH"; then
  echo
  echo "⚠️  存在冲突，请解决后继续。冲突文件："
  git diff --name-only --diff-filter=U
  echo
  echo "解决后执行："
  echo "  git add -A && git commit --no-edit"
  echo "  bash .agents/skills/sync-upstream/scripts/deploy.sh"
  exit 1
fi

echo
echo "✅ merge 完成: $CUR_BRANCH <- upstream/$UP_BRANCH"
git --no-pager log --oneline -5
