---
date: 2026-11-09
title: Implement the approved local_query lineage variant — registry_frame receipts, governed registration and the registry.query domain-ack binding
---

- 起因：2026-11-09 用户经 P2 看板采纳 A 方案（决策简报 `docs/superpowers/plans/2026-11-09-registry-frame-local-lineage-decision-brief.md`）：`registry_frame` 是零出网本地枚举，没有物理调用可出 durable 回执，此前恒被 governed-lineage 闸门排除。获批后按设计 `2026-11-09-registry-frame-local-lineage.md` §2 落地契约本体。
- 改动：普通 7 个 provider 校验路径零放宽。
  - `company-discovery-lineage.ts`：`DiscoveryCompanyLineageProviderKey` ∪ `registry_frame`；`PROVIDER_RECEIPT_CONTRACT` 增 `registry_frame → {provider:'registry.query', resultSchema:'registry-query/v1'}`。
  - `registry/local-query-receipt.ts`（新）：确定性 local 回执构造——`operationKey=registry.query:<runId>:<queryDigest>`、operationId 由 (runId,queryDigest) 派生 UUID、resultDigest=归一候选集规范 JSON 的 sha256（**可从 registry_entity 重算**）、usage 恒 0/`not_incurred`；`buildRegistryQueryLineage` 单回执覆盖全部记录（空结果给合法空血缘）。
  - `discovery-query-governed-lineage.ts`：`PROVIDER_CONTRACT` 增 registry_frame（consumer `RegistryFrameDiscoveryProvider`，classes `company_registry`）；`durable-results/domain-ack-consumer-bindings.ts` 的 `DISCOVERY_GOVERNED_COMPANY_ACK_BINDINGS` 增 `registry.query` 绑定；`discovery.activities.ts` 的 `DISCOVERY_DOMAIN_ACK_PRODUCERS` 增 `registry.query`，并在执行上下文注入 `durableBudgetAuthority`（authorityId/accountId 来自 run 预算绑定）。
  - `provider-contract.ts`：`ExecutionContext` 增可选 `durableBudgetAuthority`（有物理调用的 provider 忽略）。
  - `registry-frame.provider.ts`：`REGISTRY_FRAME_PROVIDER=on` 才声明血缘并报送本地回执；缺预算绑定/非法 filters 均 fail-closed 为空集+空血缘；`provider.registry.ts` 读取该开关（默认 off = 原行为，关闭即回滚；data_provider 默认 DISABLED 为第二道开关）。
- 测试：新增 `local-query-receipt.spec`（规范 JSON/摘要敏感性与稳定性、确定性 UUID、回执过 `parseDurableExecutionReceipt` 严格校验、血缘过 `parseDiscoveryCompanyResultLineage`、空结果合法）；适配器 spec 增 lineage 模式五项（开关声明、确定性回执+回调一致、缺预算 fail-closed、非法 filters 空血缘、**governed plan 端到端接受**）；provider.registry spec 更新血缘不变量（registry_frame 在白名单但默认 off 不声明）。相关套件 18 文件 219 项 + activities/durable-results 37 文件 1106 项全绿；build/lint 通过。真库证据：一次性库导 FR 帧（3 实体）→ 适配器两次执行得到同一 operationId（baf33523…）与同一 resultDigest（9bd75428…），且 digest 由独立 DB 查询重算一致；库已删。
- 未做：`company_domain_resolution`/`domain_review_task` 两表落库、产物池导出、Temporal 工作流与 shadow→on 灰度（执行面后续 PR）；不碰 Copy 文件、无迁移、未发车。
