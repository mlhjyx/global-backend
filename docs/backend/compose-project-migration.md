# Compose 项目名迁移（`global-backend` → `global`）

> 目的：防止从旧 Mac/WSL 或旧 checkout 启动 Compose 时，因项目名变化撞固定容器名、切到空卷或误删数据库。当前 Ubuntu 实机已核验使用 `project=global` 与 `global_pgdata`；本 runbook 只在发现旧 `global-backend` 资源时使用。

## 1. 只读预检

```bash
cd /global/backend
docker ps -a --format 'table {{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.Status}}'
docker volume ls --format '{{.Name}}' | sort
docker inspect global-postgres --format '{{json .Mounts}}'
```

- 已有 `project=global` 且卷为 `global_pgdata`：继续使用 `pnpm infra:up`，不要迁移、不要删卷。
- 已有 `project=global-backend` 或只存在 `global-backend_*` 卷：先使用 `pnpm infra:up:legacy` 保持服务可用，再做第 2 节迁移。
- 同时出现两套资源：停止并核对，**不要**让两个 Postgres 绑定同一个端口，也不要猜哪个卷是真数据。

## 2. 数据库迁移（显式、可回滚）

以下命令示例只迁移 PostgreSQL；Redis、new-api、MinIO、Ollama 等卷必须按各自数据重要性单独备份，不得把改项目名当作迁移完成。

```bash
cd /global/backend
mkdir -p /data/backups/global

# 旧项目仍在运行时导出；备份文件落在持久盘，先核对大小和 pg_restore/psql 可读性。
docker compose -p global-backend exec -T postgres \
  pg_dump -U global -d global_dev --no-owner \
  > /data/backups/global/global_dev-$(date +%Y%m%d-%H%M%S).sql

# 先停旧项目容器，不删除卷；确认旧容器/卷仍可 inspect，且备份文件可读。
docker compose -p global-backend stop

# 固定 container_name 会让“仅 stop”仍阻塞新项目启动；在确认标签和备份后，
# 只移除旧的已停止容器，不移除卷。这里禁止追加 -v。
docker compose -p global-backend ps -a
docker inspect global-postgres --format '{{json .Config.Labels}} {{json .Mounts}}'
docker compose -p global-backend rm -f

# 旧容器已移除、卷仍在后再启动新项目。
docker compose -p global up -d postgres

# 将已核对的备份导入新项目；不要使用 down -v。
cat /data/backups/global/<已核对备份>.sql | \
  docker compose -p global exec -T postgres psql -U global -d global_dev
```

## 3. 验收与清理门

1. `docker inspect global-postgres` 指向预期 `global_pgdata`，`docker compose -p global ps` 全部健康。
2. 执行 `DATABASE_URL=postgresql://global:global@localhost:5432/global_dev pnpm --filter @global/db exec prisma migrate deploy`，再按项目 verify 脚本核对关键表/行数和 API/worker。
3. 对比迁移前后关键业务计数、`pg_catalog` 表和应用健康检查；失败就停在新项目、保留旧项目和备份回滚，不删除任何旧卷。
4. 只有用户确认验收后，才可人工清理旧卷；本项目脚本不自动清理卷，也不把 `docker compose down -v` 写入迁移流程。第 2 节的 `docker compose ... rm -f` 仅清理已停止容器，是为释放固定容器名，不等于清理数据卷。

`pnpm infra:up`/`infra:down` 是当前 `global` 项目；`pnpm infra:up:legacy`/`infra:down:legacy` 仅用于迁移前兼容，不应长期与两套卷并行运行。
