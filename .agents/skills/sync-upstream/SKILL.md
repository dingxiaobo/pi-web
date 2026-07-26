---
name: sync-upstream
description: 把开源上游 agegr/pi-web 的最新代码合并到当前分支，构建生产模式到 /home/dxb/app/pi-web 并用 pm2 重启。源项目保持干净。当用户请求"更新开源最新代码"、"同步上游"、"merge upstream"、"拉取开源最新代码"时使用本技能。
---

# Sync Upstream — 合并开源最新代码并部署

把上游开源仓库 `git@github.com:agegr/pi-web.git` 的最新提交合并进当前分支，重新构建生产产物到部署目录 `/home/dxb/app/pi-web`，并用 pm2 重启服务。

## 路径约定

| 角色 | 路径 |
|---|---|
| 源项目（fork，用于开发/git 操作） | `/home/dxb/projects/pi-web` |
| 部署目录（独立，构建+运行） | `/home/dxb/app/pi-web` |
| 上游仓库 | `git@github.com:agegr/pi-web.git`，remote 名 `upstream` |
| pm2 进程名 | `pi-web` |
| 端口 | `30141`（监听 `0.0.0.0`） |

源项目**永不生成 `.next`**（构建在部署目录进行），不影响 `npm run dev` 与 `git pull`。部署目录的 `node_modules` 软链到源项目（共享，避免 1.5G 重复）。

## 步骤

### 1. 合并上游（运行脚本）

```bash
bash ./scripts/merge-upstream.sh
```

脚本会：确保 `upstream` remote → `fetch` → 探测上游默认分支 → `git merge --no-edit upstream/<默认分支>` 到当前分支。

### 2. 若出现冲突

脚本以非零码退出并打印冲突文件列表。处理原则（不要盲目 `--theirs`/`--ours`）：

- **`package.json` / `package-lock.json`** 中 pi 依赖**版本号**冲突：本技能目标是"同步到上游最新"，通常取上游侧；即 `git checkout --theirs -- package.json package-lock.json` 后 `npm install` 重整 lock。**但**若本地有非版本的定制（如内网镜像源、`^` 锁版策略），须先与用户确认是否保留这些定制再决定。
- **其它文件**：把冲突内容展示给用户决策，不要擅自解决。

解决后提交：
```bash
git add -A && git commit --no-edit
```

> 若无冲突，脚本直接完成 merge，跳到步骤 3。

### 3. 安装依赖（源项目）

上游可能改动了依赖：
```bash
cd /home/dxb/projects/pi-web && npm install
```

`npm install` 可能重写 `package-lock.json`（如补 peer 元数据）。必须提交以保持工作区干净，否则下次 `merge-upstream.sh` 会因脏树拒绝：
```bash
git diff --quiet || git commit -am "chore: lockfile after upstream sync"
```

### 4. 构建并 pm2 重启（部署目录）

```bash
bash ./scripts/deploy.sh
```

`deploy.sh` 依次：rsync 源码→部署目录（保留部署目录的 `.next`/`logs`/`node_modules` 软链）→ 软链 `node_modules` → `npm run build`（产出部署目录的 `.next`）→ `pm2 restart pi-web`（首次自动 `pm2 start` + `pm2 save`）。

### 5. 汇报

- 合并的提交：`git log --oneline -5`
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
- 监听 `0.0.0.0:30141` **无鉴权**，仅在可信网络使用。改回环：编辑 `ecosystem.config.cjs` 的 `-H 0.0.0.0` 为 `-H 127.0.0.1`。
- pm2 为 **fork 单实例**，勿改 cluster（`rpc-manager` 的 `globalThis.__piSessions` 注册表与 SSE 是进程内状态）。
- 合并仅作用于本地当前分支；推送到 origin（你的 fork）由你手动决定：`git push`。
