# Execution Budget Authority 基础合同与外部交接

> 文档 ID：`DOC-IMPL-EXECUTION-BUDGET-AUTHORITY-001`
> 生命周期：`IMPLEMENTATION_RECORD`
> 适用范围：Execution Budget Authority Tasks 1–8 的 additive foundation；不代表产品切换、部署或运行可用
> 设计权威：[Execution Budget Authority / Artifact Replay 设计](../architecture/execution-budget-authority-artifact-replay-design.md)
> 后续切换权威：[Execution Authority cutover verification plan](../superpowers/plans/2026-08-21-execution-authority-cutover-verification.md)

## 1. 裁决摘要

本子项目已经在隔离 worktree `/global/backend/.codex/worktrees/production-parity`、分支 `codex/production-parity` 上完成 Backend 内部的 Execution Budget Authority 基础：共享 compact JWS/JWKS 验证、Workspace Grant 原子消费、Platform Grant transport-neutral ingestion、PostgreSQL authority/revocation/account binding、authority-aware BudgetStore，以及可观察但不参与 admission 的健康能力探针。

状态必须按以下边界理解：

- **实现状态：ADDITIVE / NON_ADMITTING**。现有产品调用仍使用 legacy `BudgetStore.open`；新的 `openAuthorized`、Workspace consumption service 和 Platform ingestion service 尚未成为所有生产调用的唯一入口。
- **产品切换：NOT_PERFORMED**。本子项目没有把 header 设为必需，没有原子切换 Company/ICP/Discovery/Site Builder/Worker，也没有删除 legacy cap-bearing path。
- **外部 Control Plane：EXTERNAL_OWNED/PARTIAL**。仓内有 verifier、schema、service 与 fail-closed seam，但没有实际 SaaS signer/JWKS、注册后的 inbound transport 或真实签名 delivery 证明。
- **部署 writer：EXTERNAL_OWNED/PARTIAL**。迁移创建固定 `NOLOGIN` role 和窄权限；真实 LOGIN、凭据、连接与 Nest provider 绑定归部署 owner，本仓没有 fallback 到 owner/app-user 连接。
- **Runtime / deploy：UNPROVEN**。没有 retained database migration、服务重启、真实 JWKS、provider/model/paid call、部署、RuntimeEvidence 或用户可用性证明。

Task 7 的 `capabilities.execution_budget_jwks`、`workspace_budget_authority` 与 `platform_budget_authority` 只由后台刷新并进入缓存。根 readiness 仍只由既有 hard `components` 决定；Site Build request guard 使用 `checkHardComponents()`，不触发 Authority JWKS/freshness probe；Worker admission/polling 未切换。因此这些 probe 是可观察性基础，不是 authority 已强制执行的声明。

## 2. 精确 provenance 与提交

| 项目 | 精确值 |
| --- | --- |
| 工作树 | `/global/backend/.codex/worktrees/production-parity` |
| 分支 | `codex/production-parity` |
| 计划 baseline | `c96b5d4f04ca8d93ad23b4b7b690e88bd2449f42` |
| Task 1–7 最终实现 | `bea4d7392344cd44cbfbc5379a7d620f418122fc` |
| Task 8 Copy successor 测试 | `907936bc8b9f296d9b7eaca0d302222ab6391d6b` |
| Task 8 Copy successor 实现/机器 receipt | `7b34625c67bb8ecce431660a0d6b169d54d3201e` |
| `origin/main` 本地合流基底（核验时） | `a5948b85d355eccb53732aa50e5f40c85167437b` |

Tasks 1–7 的完整提交序列如下；subject 只记录 Git provenance，状态裁决以本页和源码为准：

| 顺序 | Commit | Subject |
| ---: | --- | --- |
| 1 | `fb1323b5c65688b5e7b469a1749b0a138564f433` | `docs: preserve additive authority cutover` |
| 2 | `767c441aba358fefdd513fbe9926f58a6165f47b` | `feat(budget): define execution authority claims` |
| 3 | `f6710ba0f7e6fc101f719068cb4d42b7fad9edc1` | `feat(budget): verify signed execution grants` |
| 4 | `4c381f12aab9d1683ee8b2e9643a5be608f11d09` | `fix(budget): harden remote JWKS verification` |
| 5 | `1e28b80545a13c37279580dfe7a0d35460829bc2` | `feat(db): add execution budget authority` |
| 6 | `f0492ccfd6def9bbc03600d070092dd8a78f2bb3` | `fix(db): harden execution authority isolation` |
| 7 | `8c4e8861e60bd7adc9dcddef1e56aa1261b23afb` | `test(db): close execution authority coverage gaps` |
| 8 | `ffe95c8512e8e051a2cba61517c714859c4af29e` | `test(budget): specify authority repository contract` |
| 9 | `819114b01d44be8faa324964b011a61a5edb5f78` | `feat(budget): bind accounts to signed authority` |
| 10 | `fc0bdb9f679423a185f34b0ef0adc4518bf8c9ed` | `test(budget): cover authority repository review findings` |
| 11 | `d4913b331395dc6af4763ab523bd90febabfae52` | `fix(budget): harden authority repository boundaries` |
| 12 | `f7674d613d209a34ebb259f656c25b5dcaaa5b01` | `feat(budget): consume workspace execution grants` |
| 13 | `7847f51240f30e4c5616f83ee3ad7e6a09372962` | `feat(contracts): add platform execution authority command` |
| 14 | `e2a340146652bf921d2200438d4a3b9b31a2303f` | `fix(budget): harden platform authority validation` |
| 15 | `db30ce5ebc7303512ac76a9dd5df4fb844817d6a` | `test(contracts): bind platform authority audience` |
| 16 | `3bcc328493a49c529bb03cdd6372ad53cc86f855` | `feat(runtime): gate work on execution authority` |
| 17 | `bea4d7392344cd44cbfbc5379a7d620f418122fc` | `fix(runtime): isolate authority capability probes` |

Task 7 的首个 subject 使用了 “gate work”，但最终实现按 ledger ruling 是 observe-only；`bea4d739…` 锁定了 request-path isolation。没有为改写历史而 amend 已审查提交。

## 3. 评审边界与未隐藏的 deferred minors

每个范围都经过实现任务中的独立 review/fix loop；下面记录精确 diff 边界，避免把相邻任务或后续文档提交混进原审查：

| Task | Initial review boundary | Fix/closure boundary | 结论 |
| --- | --- | --- | --- |
| 1 | `fb1323b5c65688b5e7b469a1749b0a138564f433..767c441aba358fefdd513fbe9926f58a6165f47b` | 无 fix round | clean |
| 2 | `767c441aba358fefdd513fbe9926f58a6165f47b..f6710ba0f7e6fc101f719068cb4d42b7fad9edc1` | `f6710ba0f7e6fc101f719068cb4d42b7fad9edc1..4c381f12aab9d1683ee8b2e9643a5be608f11d09` | 4 Important 已关闭 |
| 3 | `4c381f12aab9d1683ee8b2e9643a5be608f11d09..1e28b80545a13c37279580dfe7a0d35460829bc2` | `1e28b80545a13c37279580dfe7a0d35460829bc2..f0492ccfd6def9bbc03600d070092dd8a78f2bb3`；`f0492ccfd6def9bbc03600d070092dd8a78f2bb3..8c4e8861e60bd7adc9dcddef1e56aa1261b23afb` | 2 Critical + review findings 已关闭 |
| 4 | `8c4e8861e60bd7adc9dcddef1e56aa1261b23afb..819114b01d44be8faa324964b011a61a5edb5f78` | `819114b01d44be8faa324964b011a61a5edb5f78..d4913b331395dc6af4763ab523bd90febabfae52` | 3 Important 已关闭 |
| 5 | `d4913b331395dc6af4763ab523bd90febabfae52..f7674d613d209a34ebb259f656c25b5dcaaa5b01` | 无 fix round | clean；原子同事务 ruling 已实现 |
| 6 | `f7674d613d209a34ebb259f656c25b5dcaaa5b01..7847f51240f30e4c5616f83ee3ad7e6a09372962` | `7847f51240f30e4c5616f83ee3ad7e6a09372962..e2a340146652bf921d2200438d4a3b9b31a2303f`；`e2a340146652bf921d2200438d4a3b9b31a2303f..db30ce5ebc7303512ac76a9dd5df4fb844817d6a` | 3 Important 已关闭 |
| 7 | `db30ce5ebc7303512ac76a9dd5df4fb844817d6a..3bcc328493a49c529bb03cdd6372ad53cc86f855` | `3bcc328493a49c529bb03cdd6372ad53cc86f855..bea4d7392344cd44cbfbc5379a7d620f418122fc` | 1 Critical + 3 Important 已关闭 |

以下 minor 没有被本收口虚构为已修：

- Task 2：verified authority 的 `Date` 仍是浅 freeze；公共不可变合同后续可评估 scalar timestamp。
- Task 4：Unavailable/InMemory adapter 缺少直接 `openAuthorized` fail-closed 回归；部分 result-shape 负例仍可扩充。
- Task 5：verifier result reducer 可进一步 deep-copy/strip；consume readback 可要求 exact one-row cardinality；provider uniqueness test 可强化为全图断言。
- Task 6：公开 fixture 可显式验证 verification time；public-only JWK test 可更完整证明无 RSA private CRT 字段并执行 `importJWK`。
- Task 7：Worker non-cutover proof 仍是 source-shape regression；background immediate/interval/in-flight/shutdown cache lifecycle 缺完整 fake-timer suite；首个 commit subject 与 observe-only 事实不一致。

这些事项不改变当前 additive foundation 的 deterministic PASS，但在 cutover、真实部署或外部 owner 接线前需要重新分级；本页不将其写成 product-ready。

## 4. 数据库合同

唯一 Authority 迁移为：

`packages/db/prisma/migrations/20260821090000_execution_budget_authority/migration.sql`

- SHA-256：`ce093012cd325a9550bf269c882d4a8f3fd6ebf762579ae59083c52c3235f62e`
- 单一显式事务：`BEGIN` / `COMMIT`，`SET LOCAL lock_timeout = '5s'`。
- 新表：`execution_budget_authority`、`execution_budget_authority_revocation`，二者均 ENABLE + FORCE RLS。
- additive account fields：`tool_budget_account.authority_id` 与 `authorized_cap_microusd` 保持 nullable，legacy product traffic 没有在本迁移中被强制切换。
- 固定 role：`execution_budget_platform_writer` 为 `NOLOGIN`、非 superuser、非 BYPASSRLS；迁移拒绝 `app_user` membership 与不安全已有 role。
- 稳定 SQL functions：
  - `consume_workspace_execution_authority(...)`
  - `ingest_platform_execution_authority(...)`
  - `open_authorized_tool_budget_v1(scope_key, authority_id, account_key, replay_scope)`
  - trigger function `mark_execution_budget_authority_revoked()`
- legacy `open_tool_budget` 未被替换或删除；产品切换属于后续原子 cutover。

Repository 以参数化 Prisma SQL 调用以上函数。Workspace verify→consume→authorized-open 由 `consumeWorkspaceAndOpen` 在同一个 `withWorkspace` transaction 内完成；Platform ingest/freshness 只接受单独注入的 `EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE`，缺失时稳定 fail closed，不回退到 owner、app-user 或 Workspace connection。

## 5. 公开契约与代码入口

| 契约/入口 | 路径与状态 |
| --- | --- |
| 共享 claim/command types | [`packages/contracts/src/execution-budget.ts`](../../packages/contracts/src/execution-budget.ts)，由 [`packages/contracts/src/index.ts`](../../packages/contracts/src/index.ts) 导出 |
| Platform signed claims schema | [`platform-execution-budget-authority-upserted.v1.schema.json`](../../packages/contracts/events/payloads/platform-execution-budget-authority-upserted.v1.schema.json)，SHA-256 `36038e1ca8dcd4b83e807d6ae71593c3d2c097f689f5d2caa23a4ed13ea2252b` |
| 公共 conformance fixture | [`platform-execution-budget-authority-upserted.v1.valid.json`](../../packages/contracts/events/fixtures/platform-execution-budget-authority-upserted.v1.valid.json)，只含 public JWK/claims，不是私钥或运行 token |
| Command identity | `PlatformExecutionBudgetAuthorityUpserted/v1`；signed payload schema 为 `execution-budget-grant/v1` |
| 固定 audience | `global-backend:execution-budget` |
| Platform purposes | `platform.acquisition`、`platform.intent_watch`、`platform.sanctions` |
| Verifier/module | [`apps/api/src/execution-budget`](../../apps/api/src/execution-budget/)；只验证，不签发，不保存 compact JWS |
| Workspace request header design | `X-Execution-Budget-Grant`；本 additive phase 尚未让现有 controller 强制要求该 header |
| Readiness OpenAPI | `GET /health/ready` 的 `capabilities` 包含三个 exact closed component status；code-first artifact 为 [`openapi.json`](../../packages/contracts/openapi/openapi.json) |

Platform command 是外部 transport 注册身份，不是 outbound `DomainEventEnvelope`，也不进入 Backend→SaaS 的 `INTEGRATION_EVENTS`。`PlatformExecutionBudgetAuthorityIngestionService.ingest` 只接受 compact JWS 字符串；JSON wrapper 或自行增加的 command/type 字段不是当前合同。

Verifier 固定配置合同：

```text
EXECUTION_BUDGET_GRANT_JWKS_URI
EXECUTION_BUDGET_GRANT_ISSUER
EXECUTION_BUDGET_GRANT_AUDIENCE=global-backend:execution-budget
EXECUTION_BUDGET_GRANT_ALGORITHMS=<non-empty subset of RS256,ES256,EdDSA>
```

真实环境的值、credential scope 与网络配置没有在本任务中读取或改动。

## 6. Copy fixed-source successor

Authority 合同新增了 active Copy v22 82-file bundle 内的 `packages/contracts/src/index.ts` 漂移。旧 v22 binding、历史 evidence 和 binding SHA 没有被改写，也没有将 Copy 冒充为 CURRENT。Task 8 通过既有 reviewed successor 机制新增精确 scope：

`PRODUCTION_PARITY_EXECUTION_BUDGET_AUTHORITY_FOUNDATION`

机器 derivation/readback：

| 字段 | 精确值 |
| --- | --- |
| Active binding | `docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v22.json` |
| Active binding SHA-256 | `135ff0a6166d30b2257de48048b5c6c093a277ace5ef376a6e3dac1582a58bcd` |
| Binding artifact | `site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-15-v22-v1` |
| Binding source bundle digest | `5f4c321e9d48f0208e5b293a4d40d8f648c0414b8a429a789bed63cf4f874ac0` |
| Current source fingerprint | `fadc301c5944d06e1a97dd77c022b3d5d6b79ce9fe52758329f22fa6e69984a9` |
| Eligibility receipt SHA-256 | `d1c79cd00e70dbc2dedd98b542fdebd632d73d7cbc31f3bc07a551bb130cdbdc` |
| Status | `STALE_HOLD` |
| Dispatch | `NOT_AUTHORIZED` |
| Pilot eligibility | `BLOCKED` |
| Required follow-up | `REBASE_FIXED_SOURCE_BEFORE_DISPATCH` |

精确 11 个 drift paths：

1. `apps/api/package.json`
2. `apps/api/src/model-gateway/new-api-request-bound-settlement.ts`
3. `apps/api/src/model-runtime/structured-task-runtime-bridge.ts`
4. `apps/api/src/site-builder/agents/ai-task.ts`
5. `apps/api/tsconfig.build.json`
6. `package.json`
7. `packages/contracts/package.json`
8. `packages/contracts/src/index.ts`
9. `packages/contracts/src/site-builder/component-qualification.ts`
10. `packages/db/prisma/schema.prisma`
11. `pnpm-lock.yaml`

Mutation tests 证明少一路、额外一路、以及用 predecessor 的旧 10-path receipt 描述当前 11-path tree 都会 fail closed。这个 successor 只允许 Authority foundation 与已审查的 Production Parity/security drift 继续进入普通 build/test；它不 rebaseline Copy、不运行 fixed-source rebuild、不授权模型调用、不证明 Copy capability/quality/promotion/route/deployment current。

## 7. Fresh verification

下表绑定代码/治理提交 `7b34625c67bb8ecce431660a0d6b169d54d3201e`；后续文档提交不改变被测产品代码。

| 检查 | 命令与结果 |
| --- | --- |
| Authority + Task 7 changed-scope coverage | `pnpm --filter @global/api exec vitest run --coverage ...`：10 files / 214 tests PASS；statements 88.30% (521/590)，branches 87.71% (400/456)，functions 86.52% (122/141)，lines 90.84% (506/557)。`execution-budget` 子目录 statements 92.11%、branches 89.71% |
| Full API | `pnpm --filter @global/api test`：327 files / 4,836 tests PASS；`pnpm --filter @global/api build` PASS |
| API lint | `pnpm --filter @global/api lint`：0 errors、17 个既有 warnings，均不在 Authority 新目录 |
| Contracts | `pnpm --filter @global/contracts build` PASS；`pnpm --filter @global/contracts lint`：0 errors、15 个既有 undefined-tag warnings |
| OpenAPI | `node apps/api/dist/main.js --export-openapi`：60 paths；artifact SHA-256 `999c04cf08de6bd0237a54e1617a4c109954d34bf26233ad0f18ba638c49b4db` |
| Prisma static | 带本地 URL 形状、无连接需求的 `prisma validate` PASS；`pnpm --filter @global/db generate` 生成 Prisma Client 6.19.3。首次无 `DATABASE_URL` 调用以 P1012 fail closed，设置必需变量后权威重跑通过 |
| Copy focused | `node --test scripts/copy-fixed-source-impact.spec.mjs`：12/12 PASS；`node scripts/copy-fixed-source-impact.mjs` readback 为 `STALE_HOLD/NOT_AUTHORIZED/BLOCKED` |
| Governance | `pnpm governance:verify`：115/115 governance tests PASS，repository verification PASS |
| Diff | `git diff --check` PASS；active Copy binding SHA 保持不变 |

### Disposable PostgreSQL 16

- 本机没有 `postgres:16` tag，且任务禁止 pull；复用已存在的 `pgvector/pgvector:pg16`，镜像 ID `sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb`，`postgres --version` 为 PostgreSQL 16.14。
- 容器：`codex-task8-authority-pg-20260821`；loopback random binding `127.0.0.1:32787 -> 5432/tcp`；`--rm`；无 host mount、无 named volume。
- `APP_DATABASE_URL=postgresql://app_user:<test-only>@127.0.0.1:32787/global_test DATABASE_URL=postgresql://global:<test-only>@127.0.0.1:32787/global_test node --test packages/db/test/execution-budget-authority.rls.spec.mjs`：20/20 PASS。
- suite 自身从空库部署全部迁移，覆盖两张 FORCE RLS 表、完整 table/routine ACL、migration role preconditions、hostile NULL、expired/replay、20-client JTI race、20-client generation race、revocation 与 legacy nullable traffic。
- `prisma migrate status`：84 migrations found；database schema up to date。
- Docker stop 后约 0.1 秒完成自动删除；事件 readback 证明 task container `6048b3f…` 已 `destroy`，匿名 PGDATA volume `2b7248da…` 已 `unmount` + `destroy`。最终容器按精确名称不存在；没有访问或修改 retained `global-postgres`。

### ContractGraph

在精确 clean commit `7b34625c67bb8ecce431660a0d6b169d54d3201e` 重建：

```text
files=1091 nodes=9731 edges=22332 errors=0
sourceHash=6864df7176e5a5f1f0b3d63bde999055f447fef161e909f77362cca80092dd39
freshness=[]
```

指定 impact 输入为 `schema.prisma`、`execution-budget.module.ts`、`budget-store.ts` 与 `runtime-readiness.service.ts`。静态推断影响 `CAP-SITE-BUILD-001 / SCN-FE-SITE-011 / PAGE-FE-040` 和 `CAP-SITE-INTAKE-001 / SCN-FE-SITE-001 / PAGE-FE-032`，并列出 Discovery/ICP/Intent/Signals/Temporal/ToolBroker 等预算消费者。该结果是静态 affected baseline；`unknowns` 明确为 “No runtime evidence was evaluated”。

## 8. 外部 owner handoff packet

| 外部项 | 当前状态 | 外部 owner 必须提供 | Backend readback gate |
| --- | --- | --- | --- |
| Control Plane signer/JWKS | `EXTERNAL_OWNED/PARTIAL` | 固定 issuer、HTTPS（开发/test loopback 例外）、bounded public JWKS、允许的 asymmetric alg/kid；不共享 private key | exact config、可导入 public key、wrong issuer/audience/alg/private JWK/oversize/redirect 全部 fail closed；真实 JWKS probe evidence |
| Workspace Grant producer | `EXTERNAL_OWNED/PARTIAL` | 按 purpose/subject/request/workspace/site 绑定签发一次性 ≤300s Grant；cap 为 canonical positive BIGINT decimal | Backend verifier + consume replay/conflict；真实 controller integration 与无 grant 负例；不得把 operator/eval authority 混入产品 Grant |
| Platform inbound transport | `EXTERNAL_OWNED/PARTIAL` | 将 `PlatformExecutionBudgetAuthorityUpserted/v1` 注册为 inbound command，把 raw compact JWS 交给 ingestion service；定义可审计 redelivery | exact schema/conformance、wrapper rejection、signature verification before DB、exact replay/冲突、fresh authority rows；不进入 outbound relay |
| Deployment writer | `EXTERNAL_OWNED/PARTIAL` | 独立 LOGIN/credential/connection，唯一直接 membership 为 `execution_budget_platform_writer`；注入 `EXECUTION_BUDGET_PLATFORM_WRITER_DATABASE` provider | session/current user、role flags、direct memberships 的同事务 attestation；不得 owner/app-user fallback；freshness query 才可执行 |
| Retained migration/deploy | `NOT_PERFORMED` | 备份/窗口/迁移 owner、精确 artifact、rollback/forward-fix run card | 84 migrations、role preconditions、schema/status、service build identity；本页 disposable PG 不代替 retained 环境证据 |
| Product cutover | `NOT_PERFORMED` | 按 cutover plan 原子切换所有 product callers、API admission 与 Worker admission，再删除/封闭 legacy cap path | header/claim/replay/error behavior、zero invented cap、Worker/API 同步 fail closed、rollback；独立 reviewer 与用户授权 |
| Runtime/release | `UNPROVEN` | immutable deploy artifact、fresh environment-bound RuntimeEvidence、Release Bundle 与可信 external provenance | health/readiness 只作为一部分；未满足不得声称 PILOT/GA/用户可用 |

外部 owner 不得从本记录推导 dispatch、费用、merge、deploy 或 release 授权。任何真实 JWKS/provider/model/paid call、retained migration、服务重启与第三方配置仍需独立、精确授权。

## 9. 回滚与后续

- Authority foundation 是 additive；回滚代码可回退 Tasks 1–7 commits，但已应用的数据库迁移不得 destructive rollback，应走显式 forward-fix。nullable account binding 保留 legacy compatibility。
- Copy successor 回滚只回退 `907936bc…`/`7b34625c…`，会恢复 governance HOLD；不能为获得 PASS 而编辑 v22 binding、历史 receipt 或 dispatch gate。
- 下一步只能从外部 owner handoff 或 cutover plan 进入；本实现记录不是整个 Execution Budget Artifact Replay program 的完成声明。
