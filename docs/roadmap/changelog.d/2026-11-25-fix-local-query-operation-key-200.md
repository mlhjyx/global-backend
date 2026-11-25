---
date: 2026-11-25
pr: 1102
title: "fix(discovery): 修复本地查询血缘 operationKey 超 200 字符导致现网发现失败并补齐异常日志"
---

- 起因：Batch 1.5 上线后在现网重跑意大利光伏完整发现任务（run `06ee7aaf`），`registry_frame` 拿到 `SELECT` 权限正常查库后，在构造本地血缘回执阶段触发 `DOMAIN_ACK_DISCOVERY_QUERY_LINEAGE_RECEIPT_MISMATCH`。定位发现生产环境传入 `ctx.runId` 为 129 字符的 `binding.accountKey`（`discovery.run:discovery_run:<uuid>:<sha256>`），`local-query-receipt.ts` 与 `channel-catalog-receipt.ts` 直接拼接 64 字符 `queryDigest` 分别达到 209 字符和 216 字符，超出 `durable-execution-receipt` 200 字符 `SAFE_KEY` 上限并抛出普通 `Error`；同时 `discovery.activities.ts` 静默跳过非控制类 rejected provider 异常导致日志缺失真实根因。
- 改动：在 `apps/api/src/registry/local-query-receipt.ts` 与 `apps/api/src/discovery/channel-catalog-receipt.ts` 中，对超过 200 字符上限的 `operationKey` 将 `runId` 确定性折算为 `r.<sha256(runId)[0..32]>`（总长固定 114 / 121 字符且满足 `SAFE_KEY` 正则与重放幂等）；在 `apps/api/src/temporal/discovery.activities.ts` 对 rejected 的非控制类 provider 异常补齐告警日志；补充 129 字符真实生产 `binding.accountKey` 的回归单测。
- 测试：通过 `local-query-receipt.spec.ts`、`registry-frame.provider.spec.ts`、`channel-catalog.provider.spec.ts`、`discovery.activities.spec.ts`、`nest build`、`eslint`、`check-file-budgets`、`governance-module-boundaries`、`governance-verify`、`copy-fixed-source-impact`、`governance-document-drift`、`docs:verify` 与 `gitleaks`。
- 未做：不涉及数据库迁移与 sha256 锁定核心文件；待发版上线后立即重跑意大利光伏完整发现任务验证全 7 条查询与两层 L1 评分实测效果。
