---
date: 2026-11-10
title: 理解流程准入租期 30 分钟——修复 onboarding 理解预览在慢抓取时卡死
---

- 起因：2026-11-10 前端实测 onboarding 理解预览无限转圈；根因是 understanding.run 没有 admission lease——crawl4ai 上游 502 重试把流程拖过 Grant 5 分钟窗口后，`crawlPages`/`extractAndPersistProfile` 全部报 `EXECUTION_BUDGET_GRANT_EXPIRED`，工作流卡死到超时。
- 改动：沿用 20261009170000（discovery.run 3h）/20261010110000（ICP 30min）的既有机制，新迁移 `20261110090000_understanding_admission_lease` 把 `understanding.run + company` 加入租期（consumed_at + 30 分钟）：CHECK 约束放行该配对，`consume_workspace_execution_authority` 逐字复制上一版仅新增一个 CASE 分支；attest 的 COALESCE 判期逻辑不变，Grant 本身仍在自己的窗口内被呈现与准入，撤销/scope/cap/耗尽检查不变，无回填。
- 测试：`understanding-admission-lease.migration.spec.ts`（单一事务、无回填、约束精确、consume 与上一版仅差一个分支）；迁移在本机库事务内创建后 ROLLBACK 验证。
- 部署：需与镜像同窗口（运行时取最后完成的迁移）。
- 未做：前端失败态已由 #149 自带的 failed 视图覆盖（本轮未改动）；Grant 本身窗口（quote 5 分钟）不变——admission lease 只延长「准入后」的有效期。
