# Prisma datamodel 与迁移链漂移门

> 生命周期：`GUIDE`
> 生命周期依据：ch08 §3.1.7（《GainOS 深化计划 v3.0》第 8 章）；F-01 审计（真库 153 表 = datamodel 132 + 20 张 SQL-only 活表 + `_prisma_migrations`）

2026-11-08 审计发现 `packages/db/prisma/schema.prisma` 与迁移链已分叉：15 张 skill/pack/agent/http-cache 表由 M1 链路以手写 SQL 合入、从未写回 datamodel，另有 `tool_budget_operation.receipt_usage` / `unresolved_since` 两列不在 datamodel。分叉期间任何人在共享库上跑 `prisma migrate dev` 都会被引导生成 `DROP TABLE`（含平台出网围栏与撤销 ACK 表）。本门把「新增漂移」变成 CI 红灯。

## 1. 门是什么

`packages/db/scripts/prisma-drift-gate.mjs`：

1. 把迁移链 `prisma migrate deploy` 到一个**一次性库**（CI 即 service 的 `global_test`；本地用 `PRISMA_DRIFT_FROM_URL` 指向 `prisma_drift_scratch` 之类的库，脚本只允许库名匹配 `*_test` / `*_scratch` / `prisma_drift_*`，绝不容许落到共享 `global_dev`）；
2. 与 `schema.prisma` 做 `prisma migrate diff --from-url <一次性库> --to-schema-datamodel --script`；
3. 逐条比对 `packages/db/prisma/drift-baseline.json` 的已知差异清单（baseline）。

不使用 `--from-migrations` 的影子重放：Prisma 的重放会重置影子库且**不创建** `_prisma_migrations`，而 `20261010090000_app_user_table_privileges` 会对该表做 REVOKE/GRANT 与全库权限对账，重放必失败（P3006/P1014，2026-11-09 实测）。`migrate deploy` 维护 `_prisma_migrations`，与真实部署路径一致。

CI 位置：`build-test` job 的 `Prisma drift gate（datamodel ⇄ migrations，基线允许清单）` 步骤（`run_db_tests` 为真时运行，即改动涉及 `packages/db/*`、`apps/api/*`、`packages/contracts/*`、`scripts/*`、锁文件或 CI 自身）。

## 2. 基线是 ratchet（只许收紧）

`drift-baseline.json` 每条差异必须带 `statement` / `owner` / `expiresAt` / `reason`：

- **出现清单外的差异** → 红：要么把结构补进 `schema.prisma`（推荐），要么经评审后登记（写明 owner 与到期日）；
- **清单内的条目在当前差异中消失** → 红：结构修好后必须删除条目，不允许清单静默过期；
- **`expiresAt` 早于今天** → 红：补 datamodel 或书面续期。

当前基线条目 = 20 张 SQL-only 表 + 2 列（见 F-01 审计清单）；补齐 datamodel（P5c-BE-30）后应逐条删除直至清单为空。

## 3. 本地怎么跑

```bash
# 在 worktree 里。先建一个一次性库（本机 global 属主）：
docker exec global-postgres psql -U global -d postgres -c 'CREATE DATABASE prisma_drift_scratch;'
# 用 packages/db/.env 的 DATABASE_URL 派生一次性库 URL 后运行：
PRISMA_DRIFT_FROM_URL='postgresql://global:<pw>@localhost:5432/prisma_drift_scratch' \
  node packages/db/scripts/prisma-drift-gate.mjs
```

- 脚本会向目标库 apply 迁移链（`migrate deploy`），因此只接受一次性库名（`*_test` / `*_scratch` / `prisma_drift_*`），**不触碰 `global_dev` 等业务库**。
- CI 直接使用 service 的 `global_test`（名字匹配 `_test`），无需额外配置。

## 4. 有意新增 SQL-only 结构时

迁移里手写 SQL 建表/加列是允许的（权限、函数、扩展等 Prisma 表达不了的除外仍需登记），但**同一 PR 必须**把对应结构写进 `schema.prisma`（raw SQL 访问的表可用 `@@ignore` + `/// @raw-sql:` 注释）。做不到时：

```bash
node packages/db/scripts/prisma-drift-gate.mjs --write-baseline   # 以当前差异重写基线（人工评审后提交）
```

重写后逐条补 `owner` 与 `expiresAt`，并在 PR 描述里说明为什么不能进 datamodel。
