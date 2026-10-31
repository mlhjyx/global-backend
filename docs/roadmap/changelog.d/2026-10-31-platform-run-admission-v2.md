---
date: 2026-10-31
title: Admit platform schedule runs through signed v2 Grants issued by gain-saas
---

- 起因：平台运行准入仍指向执行权已被收回的 `admit_platform_execution_budget_run_v1`，四个平台工作流起步即 `permission denied`；v2 链路（验签器 + ingestion 服务 + SQL）早已写齐但没有调用方，权威方也没有持久的平台 Grant 签发。
- 改动：
  - 平台 worker 的 `admitPlatformSchedule` 改为 quote → 经 mTLS 向 gain-saas 取平台 Grant → `ingestAndAdmit`（v2），workflowId 只从 Temporal 读取；`PLATFORM_GRANT_ENDPOINT` 进编排。
  - 删除 `BudgetStore.admitPlatformRun`（v1）及其替身与测试。
  - 新增迁移 `20261031140000_platform_writer_business_grants`：平台写入者补齐 10 张业务表的精确权限（先全收再授予 + 迁移内 DO 自检 fail closed），清单 `docs/governance/platform-writer-table-privileges.json` 与零容器一致性测试。
  - 设计文档 `docs/superpowers/plans/2026-10-31-platform-run-admission-gainsaas.md` 转 `APPROVED` 并补施工注记（部署绑定 actionSha ≠ policy request sha，权威改持自己的策略副本）。
- 测试：`APP_DATABASE_URL= vitest run` 全量 10496 passed / 199 skipped；`contracts build + nest build` 通过。
- 未做：四个 schedule 仍 paused；启用与否由产品负责人单独决定。Cross-window 端到端（手动单次 run + 撤销 fence）在发版后验证。
