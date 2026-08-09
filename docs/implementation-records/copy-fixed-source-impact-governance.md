# Copy fixed-source 影响治理

> 文档 ID：`DOC-IMPL-COPY-FIXED-SOURCE-IMPACT-001`
> 生命周期：`CURRENT`
> 适用范围：Site Builder Copy Sonnet recovery v15 与共享 Prisma schema 的变更边界

## 1. 问题

Copy v15 runtime binding 把完整 `packages/db/prisma/schema.prisma` 作为编译依赖写入 82-file source bundle。该绑定是正确的：Prisma client 会参与 API 编译，schema 漂移后不能继续声称当前二进制仍与 v15 binding 相同。

但 v15 仍是 `NOT_AUTHORIZED` 的 create-only 输入。若 CI 对任何 schema 漂移都只允许重做新的 Copy recovery 版本，那么与 Copy 无关的获客表、合规表和运行账本会被一个未授权评测永久冻结。反过来，直接跳过 fixed-source 重建又会把已经失效的 binding 冒充为 current。

## 2. 机器合同

[eligibility receipt](../evidence/site-builder/copy-runtime-eligibility.json) 是当前 source tree 相对活跃 v15 runtime binding 的机器状态。`scripts/copy-fixed-source-impact.mjs` 在 required build 中执行并验证：

1. 活跃 binding 路径、文件 SHA-256、artifact ID 与 source bundle digest 必须逐字等于已审查的 v15 artifact；receipt 不能自行替换信任根。
2. 对 binding 中全部 source path 重新读取有界 regular file 并计算 SHA-256；source fingerprint 与 drift path 集必须和 receipt 完全一致。
3. 零漂移只能声明 `CURRENT`；有漂移只能声明 `STALE_HOLD`。
4. `STALE_HOLD` 当前只允许 `packages/db/prisma/schema.prisma`，并要求 `stale_scope=PRISMA_SCHEMA_EVOLUTION`。runner、verifier、model runtime、lockfile、package manifest 或其他承重路径漂移一律失败。
5. 两种状态都固定 `dispatch_authorization=NOT_AUTHORIZED` 与 `pilot_eligibility=BLOCKED`。`CURRENT` 的下一门是 `SEPARATE_DISPATCH_AUTHORIZATION`；`STALE_HOLD` 则必须 `REBASE_FIXED_SOURCE_BEFORE_DISPATCH`。
6. 只有 `CURRENT` 才执行 manifest/runtime binding 双 fixed-source rebuild；`STALE_HOLD` 只表示允许无关 schema 演进进入常规 build/test，不会升级 Copy 的 capability、dispatch、promotion、route 或生产状态。

## 3. 安全边界

当 schema 进入 `STALE_HOLD` 时，v15 verifier/runner/model runtime 自身必须仍与 binding 精确相同。现有 dispatch source verification 会在 client、ledger 和 wire 前发现 schema source digest 不匹配。因此 stale receipt 不能成为 dispatch authorization，也不能用于 Release Bundle 或真实试点。

如果未来确需修改允许列表、活跃 binding 或 Copy 承重源码，必须另做 TDD、独立 correctness/security review、Hosted CI 和明确合并决策；不能只编辑 receipt。

## 4. 验证

- `node --test scripts/copy-fixed-source-impact.spec.mjs`
- `node scripts/copy-fixed-source-impact.mjs`
- `pnpm governance:test`
- `COPY_SONNET_RECOVERY_MANIFEST_REBUILD_TEST=1 COPY_SONNET_RECOVERY_REBUILD_TEST=1 pnpm --filter @global/api exec vitest run src/site-builder/eval/copy-sonnet-recovery-manifest-prep.spec.ts src/site-builder/eval/copy-sonnet-recovery-runtime-binding-prep.spec.ts`（仅 `CURRENT`）

这些只提供源码与确定性合同证据。Hosted GitHub Actions、live ruleset、部署构建身份、RuntimeEvidence 与真实 pilot 仍是独立门。
