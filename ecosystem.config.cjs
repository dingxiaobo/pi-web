/**
 * PM2 进程配置 — pi-web (Next.js 生产服务)
 *
 * 由 .agents/skills/sync-upstream/scripts/deploy.sh 同步到部署目录后加载:
 *   pm2 start $HOME/app/pi-web/ecosystem.config.cjs
 *
 * 关键约束：必须 fork + 单实例!
 *   - lib/rpc-manager.ts 把 AgentSessionWrapper 注册表存在 globalThis.__piSessions
 *   - SSE 连接 / 会话状态都是进程内状态
 *   - 用 cluster 模式会导致会话分散到不同 worker，状态错乱。勿改!
 *
 * 监听 0.0.0.0:30141，可公网/局域网访问（无鉴权，仅限可信网络）。
 */
module.exports = {
  apps: [
    {
      name: "pi-web",
      // 直接跑 node + next CLI，避免 bin/pi-web.js spawn 子进程导致 pm2 stop 时产生孤儿
      script: "node",
      args: "node_modules/next/dist/bin/next start -H 0.0.0.0 -p 30141",
      cwd: __dirname, // 从部署目录加载时即 $HOME/app/pi-web
      exec_mode: "fork", // 单进程，勿改 cluster
      instances: 1, // 勿增加实例数
      autorestart: true,
      max_memory_restart: "1G",
      watch: false,
      kill_timeout: 10000, // 给 SSE/请求优雅关闭时间
      env: {
        NODE_ENV: "production",
        PORT: "30141",
      },
      out_file: "./logs/pm2-out.log",
      error_file: "./logs/pm2-error.log",
      merge_logs: true,
      time: true,
    },
  ],
};
