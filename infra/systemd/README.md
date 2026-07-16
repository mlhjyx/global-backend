# systemd units — 开机自启 API + Temporal worker

Ubuntu 服务器（见 [AGENTS.md §3](../../AGENTS.md)）上让**后端 API 与 Temporal worker 开机自启、崩溃自愈**的两个 systemd 单元。跑**构建产物**（`node dist/*.js`，非 watch），由 systemd 托管；配合 docker 整栈 + `temporal-dev.service`，重启后整栈自恢复。

| 单元 | 进程 | 端口/职责 |
|---|---|---|
| `global-api.service` | `node dist/main.js` | API，监听 `:3000` |
| `global-worker.service` | `node dist/temporal/worker.js` | Temporal worker（无监听端口） |

## 前置假设（换机/换路径时按需改 unit）

- 代码 checkout 在 `/global/backend`，工作目录 `WorkingDirectory=/global/backend/apps/api`（两入口 `import 'dotenv/config'` 从 cwd 载 `apps/api/.env`）。
- Node 用 fnm 稳定默认路径 `/root/.fnm/aliases/default/bin/node`（systemd 无 shell PATH，不能用 fnm 的 per-shell 临时路径）。
- `root` 用户；`docker.service` + `temporal-dev.service` 已存在并 enabled。
- 所有 `pnpm`/`docker compose` 命令均从仓库根目录 `/global/backend` 执行。
- **已先构建**：`cd /global/backend && pnpm --filter @global/api build`（unit 跑 `dist/`，不含热重载）。

## 安装

```bash
cd /global/backend
# 1) 建 symlink（改了本仓文件即生效，比 cp 好）
sudo ln -sf /global/backend/infra/systemd/global-api.service    /etc/systemd/system/global-api.service
sudo ln -sf /global/backend/infra/systemd/global-worker.service /etc/systemd/system/global-worker.service
# 2) 重载 + 开机自启 + 立即起
sudo systemctl daemon-reload
sudo systemctl enable --now global-api.service global-worker.service
# 3) 核验
systemctl is-active global-api global-worker         # 期望 active
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/portal   # 期望 200
```

## 日常管理

```bash
systemctl status  global-api global-worker    # 状态
systemctl restart global-api global-worker     # rebuild 后必须重启才加载新 dist
journalctl -u global-api -f                     # 跟日志
```

> **改代码后**：systemd 跑的是构建产物；从 `/global/backend` 执行 `pnpm --filter @global/api build` 后，
> 再执行 `systemctl restart global-api global-worker` 才生效。

## 🔴 与热重载开发的端口让位

systemd 的 `global-api` 占 `:3000`；`pnpm --filter @global/api start:dev`（nest --watch）也要 `:3000`，会冲突。热重载开发前先让位：

```bash
cd /global/backend
systemctl stop global-api                       # 先停 systemd 版
pnpm --filter @global/api start:dev             # 再跑 watch
# 开发完交还：
systemctl start global-api
```

worker 无端口冲突（Temporal 允许多 poller），systemd worker 与手动 worker 可并存。
