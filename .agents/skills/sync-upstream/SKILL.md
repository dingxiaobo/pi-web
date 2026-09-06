---
name: sync-upstream
description: 先同步 origin 当前分支，再合并 origin/main 和开源上游 agegr/pi-web 的最新代码，随后构建到 $HOME/app/pi-web 并用 pm2 重启。源项目保持干净。当用户请求"更新开源最新代码"、"同步上游"、"merge upstream"、"拉取开源最新代码"、"更新本地 main 并合并"、"合并 remote main 后重新构建重启"时使用本技能。
---

# Sync Upstream — 同步 fork、合并开源最新代码并部署

依次把 `origin/<当前分支>`、`origin/main` 和上游开源仓库 `git@github.com:agegr/pi-web.git` 的最新提交合并进当前分支，重新构建生产产物到部署目录 `$HOME/app/pi-web`，并用 pm2 重启服务。直接合并远端引用，不依赖本地 `main` 是否已更新。

## 路径约定

| 角色 | 路径 |
|---|---|
| 源项目（fork，开发/git 操作） | 本 skill 所在 git 仓库根（脚本用 `git rev-parse --show-toplevel` 自动探测） |
| 部署目录（独立，构建+运行） | `$HOME/app/pi-web` |
| fork 仓库 | remote 名 `origin`；同步当前同名分支并合并 `origin/main` |
| 上游仓库 | `git@github.com:agegr/pi-web.git`，remote 名 `upstream` |
| pm2 进程名 | `pi-web` |
| 端口 | `30141`（监听 `127.0.0.1`，公网由 caddy 反代） |

源项目**永不生成 `.next`**（构建在部署目录进行），不影响 `npm run dev` 与 `git pull`。部署目录的 `node_modules` 软链到源项目（共享，避免 1.5G 重复）。

## 步骤

### 1. 同步 fork 并合并上游（运行脚本）

```bash
bash .agents/skills/sync-upstream/scripts/merge-upstream.sh
```

脚本要求工作区干净，然后按固定顺序执行：

1. `fetch origin` 和 `fetch upstream`
2. 合并 `origin/<当前分支>`，确保本地定制分支没有漏掉远端提交
3. 合并 `origin/main`，不依赖本地 `main` 指针
4. 合并 `upstream/<默认分支>`，获取开源最新代码

任一远端分支不存在或任一步合并冲突，脚本立即退出，不会继续构建。

### 2. 若出现冲突

脚本以非零码退出并打印冲突文件列表。处理原则（不要盲目 `--theirs`/`--ours`）：

- 合并 `origin/<当前分支>` 或 `origin/main` 冲突：把冲突内容展示给用户决策，不要擅自选边。
- 合并 `upstream/<默认分支>` 时，若 `package.json` / `package-lock.json` 仅有 pi 依赖**版本号**冲突，目标是同步上游最新，通常取上游侧，再执行 `npm install` 重整 lock。若本地有非版本定制（如内网镜像源、`^` 锁版策略），须先与用户确认。
- **其它文件**：把冲突内容展示给用户决策，不要擅自解决。

解决后提交：
```bash
git add -A && git commit --no-edit
```

> 若无冲突，脚本完成三路 merge，跳到步骤 3。

### 3. 安装依赖（源项目）

上游可能改动了依赖：
```bash
cd "$(git rev-parse --show-toplevel)" && npm install
```

`npm install` 可能重写 `package-lock.json`（如补 peer 元数据）。必须提交以保持工作区干净，否则下次 `merge-upstream.sh` 会因脏树拒绝：
```bash
git diff --quiet || git commit -am "chore: lockfile after upstream sync"
```

### 4. 构建并 pm2 重启（部署目录）

```bash
bash .agents/skills/sync-upstream/scripts/deploy.sh
```

`deploy.sh` 依次：同步源码→部署目录（保留部署目录的 `.next`/`logs`/`node_modules` 软链）→ 软链 `node_modules` → `npm run build`（产出部署目录的 `.next`）→ `pm2 restart pi-web`（首次自动 `pm2 start` + `pm2 save`）。

### 5. 汇报

- 合并的提交：`git log --oneline -5`
- 当前分支相对 fork：`git rev-list --left-right --count origin/$(git branch --show-current)...HEAD`
- 当前分支必须包含 remote main：`git rev-list --left-right --count origin/main...HEAD` 的第一列应为 `0`
- pm2 状态：`pm2 describe pi-web` 中的 `status` / `pid` / 监听端口
- 访问地址：`http://<host>:30141`

## 首次部署（开机自启，仅一次）

若该机器尚未配置 pm2 开机自启：
```bash
pm2 save
pm2 startup   # 按它输出的提示，执行那条 sudo ... 命令
```

## 注意

- 构建在部署目录进行，源项目 `.next` 永不生成，故 `npm run dev` 不受影响。
- 部署目录 `node_modules` 软链到源项目：源项目执行 `npm install` 会同步影响部署（通常即期望行为，因为部署前会重新 build）。若需完全隔离，把软链换成 `cp -a` 拷贝。
- 监听 `127.0.0.1:30141` **无鉴权**，仅回环；公网/局域网访问经 caddy 反代。勿改 `ecosystem.config.cjs` 的 `-H 127.0.0.1` 为 `0.0.0.0`。
- pm2 为 **fork 单实例**，勿改 cluster（`rpc-manager` 的 `globalThis.__piSessions` 注册表与 SSE 是进程内状态）。
- 合并顺序固定为 `origin/<当前分支>` → `origin/main` → `upstream/<默认分支>`。
- 合并仅作用于本地当前分支；推送到 origin（你的 fork）由你手动决定：`git push`。
