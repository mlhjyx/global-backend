---
date: 2026-11-04
title: Wire the full DB test suite into CI and enforce docs freshness
---

- 起因：`packages/db/test` 的 28 个数据库/RLS 测试里 CI 只点名跑了 2 个，最强的租户隔离保障大部分靠手工；权威文档的「最后核验」没有机械门（治理索引停在 2026-08-07）。
- 改动：
  - 新增 `packages/db/test/ci-manifest.json`（service / isolated / static 三组）与 `scripts/run-db-tests.mjs`（清单完整性校验 + 轮转分片 + tsx 运行）；未登记文件或失效登记直接失败。
  - `ci.yml` 增加 `db-tests-service`（CI PostgreSQL service）与 `db-tests-isolated`（2 分片、自起 pgvector）两个 job，按路径 scope 触发，纯文档 PR 跳过。
  - 新增 `scripts/docs-freshness.mjs` 并接入 `verify-docs`：权威页「最后核验」超过 90 天按 `freshness.mode` 报 `DOC_STALE` / `DOC_VERIFICATION_MISSING`（当前 `warn`，观察期后转 `error`）。
  - 两个新 spec 由 `db-tests-service` job 以 `node --test` 直接执行；根 `governance:test` 保持不变（Copy 固定源约束）。
- 测试：`node --test scripts/run-db-tests.spec.mjs scripts/docs-freshness.spec.mjs` 9/9；`node scripts/verify-docs.mjs` PASS（0 errors；16 条 warning 为权威页缺「最后核验」，观察期预期）。
- 未做：不改写历史证据与 16 个缺日期权威页的正文；DB 测试所需角色与迁移沿用现有 CI service 约定，首轮 CI 若暴露既有失败，登记豁免并另开修复。
