---
date: 2026-11-10
title: 域名解析与召回审计两条 Temporal workflow + run 产出池导出（ch03 执行面 3b）
---

- 起因：ch03 §3.12/§3.17 的执行面需要把已合入的解析/复核契约（T3-13/T3-15）与两表存储（PR-3a）接成可编排的流水；召回审计此前只有 CLI 文件通道，缺 run 产出池导出与 workflow 编排。
- 改动：
  - `apps/api/src/registry/recall-pool-export.ts` + `.prisma.ts`：run 产出池导出——按 `discovery_company_materialization_outcome` 去重到公司，注册身份只从 `registry_frame` 类提供者的 `scheme:number` externalId 解析，联系人数取 `canonical_contact` 计数；规范排序 + sha256 指纹，输出即 `recall-audit.mjs --pool` 输入。配套 `scripts/frames/recall-pool-export.mts` CLI（owner 只读 + 显式 workspace 过滤）。
  - `apps/api/src/registry/recall-frame-export.prisma.ts`：frame 导出的共享取数层（CLI 与 Temporal 活动同口径，`recall-frame-export.mts` 改为复用它）。
  - `apps/api/src/temporal/domain-resolution.{activities,workflow}.ts`：逐公司 resolve → verify → persist 的有界编排（≤50 公司、按 companyId 排序确定性重放）；落库走 PR-3a 存储契约（upsert / 唯一 VERIFIED 选中 / 复核工单幂等入队），VERIFIED 行可按 `auditSampleRate` 确定性抽样进复核。
  - `apps/api/src/temporal/recall-audit.{activities,workflow}.ts`：frame 导出 → 池导出 → `auditRecall`（Wilson 95% CI）的编排；载荷护栏（frame ≤5000 行、池 ≤20000 行，超限点名 CLI 文件通道）。
  - worker 注册面：`customer-workflows.ts` 导出两条 workflow，`worker.ts` 注册两个活动工厂（`createDomainResolutionActivities` / `createRecallAuditActivities`），不注册任何 schedule。
  - 灰度门默认关：`DOMAIN_RESOLUTION_WORKFLOW_ENABLED` / `RECALL_AUDIT_WORKFLOW_ENABLED` 未开时活动一律抛 `DOMAIN_RESOLUTION_DISABLED` / `RECALL_AUDIT_DISABLED`，零调用零落库；本 PR 未在任何 env/compose/夹具里开启。
- 测试：池导出单测 7 例（解析/去重合并/哈希可复算/与 auditRecall 直连）；两条 workflow 编排单测 8 例 + 活动单测 19 例（灰度门、零页面确定性 NO_LEGAL_PAGE、注入页面证据走通 VERIFIED、落库幂等/选中/复核入队、改判前清选中、frame/池护栏）；`pnpm --filter @global/api build` 全量类型检查绿。
- 未做：真实页面抓取与 search/ct/cc/wikidata 适配器接线（ports 已留位，接线后即为生产路径）；selected 行回写 `canonical_company.domain`；审计报告落盘持久化（仍走 CLI 文件通道）；灰度开启与 schedule 注册属后续授权动作。
