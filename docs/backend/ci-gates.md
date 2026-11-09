# CI 门登记簿（G1–G14 已落地部分）

> 生命周期：`GUIDE`
> 生命周期依据：ch08 §3.4（《GainOS 深化计划 v3.0》第 8 章「CI 门 G1–G14」）；每道门上线同一天更新本页

原则：每道门先基线化（`docs/governance/ci-baselines/<gate>.json`），门只对**新增**问题失败；基线只许缩小（条目不再适用即红，必须先删）。门的失败信息带修复指引；例外必须写 owner 与到期日。

| 门 | 位置 | 阻断条件 | 基线 | owner |
|---|---|---|---|---|
| G1 Prisma schema⇄migrations 漂移 | `build-test` · `Prisma drift gate` | datamodel 与迁移链有任何未登记差异 | `packages/db/prisma/drift-baseline.json`（110 条，见 [prisma-schema-drift.md](prisma-schema-drift.md)） | P5c-BE-30/31 |
| G2 迁移命名与 checksum | `build-test` · `Migration integrity gate` | 目录名不合规 / 新增时间戳撞车 / `_prisma_migrations.checksum` ≠ 文件 sha256 / 存在失败或回滚行 | `docs/governance/ci-baselines/g2-migration-integrity.json`（历史撞车组） | P6-CI-01 |
| G5 RLS/租户目录 | `build-test` · `RLS catalog gate` | 带 `workspace_id` 的表缺 ENABLE+FORCE RLS 或策略；无 `workspace_id` 的表未在目录登记；`app_user` 默认表权限不是只读 | `docs/governance/ci-baselines/g5-rls-catalog.json`（platform_table / owner_only / rls_enforced 三类目录） | P6-CI-07 |
| G9 文件体量与复杂度 | `build-test` · `File and complexity budget gate` | >1200 行未登记文件；已登记文件超过棘轮上限；圈复杂度 >40 未登记函数或超过基线 | `docs/governance/ci-baselines/g9-size-budget.json`（>800 行文件、>20 复杂度函数） | P6-CI-10 |

## 本地复现

```bash
# G1（一次性库；见 prisma-schema-drift.md）
node packages/db/scripts/prisma-drift-gate.mjs

# G2 / G5：同一口径——先建一次性库，再指 PRISMA_CIGATE_FROM_URL
docker exec global-postgres psql -U global -d postgres -c 'CREATE DATABASE prisma_drift_scratch;'
PRISMA_CIGATE_FROM_URL='postgresql://global:<pw>@localhost:5432/prisma_drift_scratch' \
  node packages/db/scripts/migration-integrity-gate.mjs
PRISMA_CIGATE_FROM_URL='postgresql://global:<pw>@localhost:5432/prisma_drift_scratch' \
  node packages/db/scripts/rls-catalog-gate.mjs

# G9（纯静态，无需数据库）
node scripts/check-file-budgets.mjs
```

G2/G5 都会向目标库 `migrate deploy`，脚本只接受一次性库名（`*_test` / `*_scratch` / `prisma_drift_*`），拒绝落到共享 `global_dev`。

## 基线怎么改

> G9 的函数基线键是「文件#函数名（同名按出现顺序加序号）」，**不含行号**：行号会随他人无关编辑漂移，把行号钉进键会让每次同步 main 都误报「条目失效」（2026-11-09 实测 6 例）。

- **新增例外**：先评估能否直接修（拆分文件、补 RLS、换迁移时间戳）。确实不能，才在 PR 里向对应基线 JSON 加条目，写明 `owner` 与 `expiresAt`，并在 PR 描述说明原因。
- **条目不再适用**（文件已拆分/表已删/撞车已修/函数已降复杂度）：必须删除条目，否则门红（ratchet）。
- **到期**：`expiresAt` 早于当天即红；续期要在 PR 里说明为什么还不能修。
- 基线重生成：G2/G5 `--write-baseline`、G9 `--write-baseline`（只用于首次落地或批量变更，评审后提交）。

## G5 的 nightly 部分（manual RLS 套件）：暂缓，原因已查明

2026-11-09 尝试把 `manual` 组里 7 个「只需要 `DATABASE_URL` + `APP_DATABASE_URL`」的套件析出为 `manual-runnable` 并在一次性库上运行，结论是**暂不可自动化**：

- `execution-budget-authority.rls.spec.mjs` 等依赖**集群级角色预置**（`execution_budget_platform_writer` 等角色及其 GRANT 由 infra 脚本创建；在只有迁移链的库上 DROP/CREATE ROLE 会因跨库依赖失败，2BP01）；
- `generic-operation-artifact*.spec.mjs` 存在**测试腐化**：夹具 `TRUNCATE generic_operation_artifact` 被新外键 `personal_artifact_cleanup_command` 挡住（0A000），需先修夹具；
- 其余套件需要外部预置容器（`DISCOVERY_QUERY_LINEAGE_PG_CONTAINER`、`GOVERNED_RELATION_PG_CONTAINER` 等）。

因此 19 个套件保持 `manual` 现状（按文件头注释手工执行）；把它们接入 nightly 需要先修复夹具并在工作流里补齐角色 provisioning，作为 G5 的后续项单列。

## 尚未落地的门

G3 事件 schema、G4 OpenAPI 对账（SaaS 侧）、G6 env registry、G7 分层依赖、G8 死代码、G10–G12 前端预算、G13 错误码、G14 安全回归——按 ch08 §3.4 的实施顺序在后续 Wave 排期。
