---
name: deploy-pi-web
description: Deploy a built pi-web tarball to the local machine (npm global install + restart the pi-web systemd user service) and/or the static server (scp + switch the pi-web.tgz symlink). Use when the user says "deploy pi-web", "部署 pi-web", "发布到 local/服务器", "更新本机 pi-web", "重启 pi-web 服务", or asks to install or upload a built agegr-pi-web-*.tgz. Does not build or merge — deploy only.
---

# Deploy pi-web

Deploy an already-built `agegr-pi-web-<version>.tgz` to **local**, **server**,
or both. Every step is a command the agent runs in order; stop and report on
any failure.

Both scripts live next to this SKILL.md:
`.agents/skills/deploy-pi-web/deploy-to-local.sh` and
`.agents/skills/deploy-pi-web/deploy-to-server.sh`. Run them from the repo
root (paths below are repo-root relative).

## Inputs

- **Target**: `local`, `server`, or `both`. If the user does not name one,
  ask. "部署/更新 pi-web" with no target → ask.
- **Artifact**: an absolute path to a `.tgz`. If not given, use the newest
  `agegr-pi-web-*.tgz` in the repo root:

  ```bash
  ls -t "$PWD"/agegr-pi-web-*.tgz | head -1
  ```

  If none exists, do NOT invent one — tell the user to build first
  (`npm run build && npm pack`) or ask whether to build now. Never deploy a
  tarball whose name does not start with `agegr-pi-web-`.

Confirm the chosen artifact (name + size) with the user before deploying when
it was picked implicitly (no path given).

## Deploy local

```bash
.agents/skills/deploy-pi-web/deploy-to-local.sh /abs/path/agegr-pi-web-<version>.tgz
```

What it does (fail-fast, `set -euo pipefail`):

1. Validates the argument: absolute path, file exists, `.tgz`, name starts
   with `agegr-pi-web-`.
2. `npm install -g <tgz>` (global prefix `~/app/node24`; the `pi-web` bin
   link at `~/.local/bin/pi-web` is what the service runs).
3. `systemctl --user restart pi-web` (user service; the script sets
   `XDG_RUNTIME_DIR` so it also works over ssh).
4. Verifies with `systemctl --user is-active`; on failure it prints the last
   30 `journalctl --user -u pi-web` lines and exits non-zero — surface those
   lines to the user.

After success, report the installed version (`npm ls -g @agegr/pi-web
--depth=0`) and the service status line the script prints.

## Deploy server

```bash
.agents/skills/deploy-pi-web/deploy-to-server.sh /abs/path/agegr-pi-web-<version>.tgz
```

The script sources `~/.bashrc` itself and needs two env vars defined there:
`STATIC_SSH_DEST` (ssh target) and `STATIC_SSH_DEST_PORT` (port, default 22).
If it errors with "请在 ~/.bashrc 中定义 STATIC_SSH_DEST", tell the user to
define the vars — do not hardcode host or port.

What it does:

1. Validates the argument (absolute path, `.tgz`, no special characters in
   the filename).
2. `scp -P $PORT <tgz> $STATIC_SSH_DEST:/root/app/static/`.
3. Over ssh: `test -s` the uploaded file, then
   `ln -sfn /root/app/static/<basename> /root/app/static/pi-web.tgz`.
4. Verifies by listing the symlink on the server.

Report the server listing (`ls -l pi-web.tgz`) the script prints — it shows
the version the symlink now points at.

## Deploy both

Run local first, then server, stopping on the first failure:

```bash
.agents/skills/deploy-pi-web/deploy-to-local.sh /abs/path/agegr-pi-web-<version>.tgz && \
.agents/skills/deploy-pi-web/deploy-to-server.sh /abs/path/agegr-pi-web-<version>.tgz
```

Rationale: local restart is the faster smoke test; if the new build crashes
the service, the journalctl output is already in front of the user before the
tarball is published to the server.

## Notes

- Both scripts are idempotent: re-running re-uploads/re-installs and
  re-points/restarts to the same artifact.
- Four-part versions (e.g. `0.9.1.2`) are fine for tarball installs but are
  NOT valid for `npm publish`; deploying via these scripts is the only
  supported path for such versions.
- The server keeps every versioned tarball (nothing is deleted); the symlink
  is the only thing that moves.
- These scripts do not run tests or build. If the user wants
  merge + build + deploy, that is the `sync-and-build-pi-web` skill's job.
