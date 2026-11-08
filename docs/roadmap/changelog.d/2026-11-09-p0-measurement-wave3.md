---
date: 2026-11-09
title: Machine-read the metric dictionary and enforce it in CI (metrics:lint), plus the PR metric-impact block
---

- 起因：ch01 PR-01 要求指标字典落到机器可读、可 lint 的一等公民（字段齐全、公式来源存在、版本递增）；PR-16 要求补文档入口与 PR 模板的「指标影响」栏。
- 改动：
  - 新增 `docs/metrics/dictionary/` 六份 `metric-definition/v1` JSON（t0-vric / t1-coverage / t2-reachability / t3-engagement / t4-business / guardrails），共 44 个指标；每指标含 id/name/tier/unit/owner/status/version/effectiveFrom/definition/分子/分母/排除项/窗口/分层/CI 方法/benchmark/changelog。
  - 新增 `docs/metrics/schemas/metric-definition.v1.schema.json`（单指标 JSON Schema）与 `docs/metrics/schemas/sources.v1.json`（数据源登记：existing 18 / planned 8 / saas 5；ACTIVE 指标只许引用 existing）。
  - 新增 `scripts/metrics/metrics-lint.mjs`：零依赖校验器——未知字段拒绝（typo 防线）、ID/名称唯一、tier 与 ID 前缀及文件一致、来源必须登记、ratio 类必须有分母、窗口/分层/CI 词表闭合（GUARDRAIL 允许 ci=none）、changelog 版本 1..N 连续且末条等于 version；`--json` 供机器读；非零退出供 CI。
  - 新增 `docs/metrics/README.md` 门户（PR-16）；`.github/pull_request_template.md` 增加「指标影响」栏（指标 ID/口径是否升版本/是否重跑金标）。
  - 指标字典升 v1.2：§7-5 改为机器化已落地（JSON 而非 YAML 的理由：仓库无可直接引用的 YAML 依赖，引入会动锁文件与 Copy 绑定）；§8 增 v1.2 条目。
  - `scripts/governance-contracts.spec.mjs` 导入 `metrics-lint.test.mjs`，使字典 lint（44 指标、0 问题）与 frame registry 校验（19 法域、0 问题）随 `docs:verify` 在 CI 强制执行。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿（新增 lint 9 例：checked-in 字典全过、未知字段、来源未登记、ACTIVE 用 planned 源、版本缺口、跨文件重复、故意改坏判红）；`node scripts/metrics/metrics-lint.mjs` 0 问题；`node scripts/verify-docs.mjs` PASS；`node --test scripts/governance-contracts.spec.mjs` 全绿（含 spec 可达性）。
- 未做：未做 `EXPLAIN` 级公式校验（需数据库，CI 不连库）；未动 frame 适配器/DB 迁移（P2 会话在改引擎 registry/snapshot）；未采购任何数据；未做真实金标标注。
