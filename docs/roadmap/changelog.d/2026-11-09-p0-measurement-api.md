---
date: 2026-11-09
title: Add the read-only metrics API — catalog, observations and rollups with keyset pagination (ch01 PR-04)
---

- 起因：ch01 PR-04 要求把度量工作流（PR-03）写入的观测与聚合以只读 API 暴露给运营与后续看板；本切片实现 catalog/observations/rollups 三端点。
- 改动：
  - 新增 `apps/api/src/measurement/measurement.controller.ts` + `measurement.service.ts` + `measurement.module.ts`（AppModule 挂载）：`GET /metrics/catalog`（metric_definition 平台只读）、`GET /metrics/observations`（metric_observation，本 workspace RLS，window_end 倒序 keyset 分页）、`GET /metrics/rollups`（daily|weekly 两表，桶倒序 + 指标/维度 keyset）；统一 `acquisition:read` scope 与 page envelope；参数/游标不合法 400 VALIDATION_ERROR；数值列 double、stratum 原样 JSON。
  - 新增 `apps/api/scripts/measurement-sync-definitions.mts`：把 `docs/metrics/dictionary/*.json`（44 指标）幂等 upsert 到 `metric_definition`（owner 连接，按 (metric_id, version)，content_hash 记录内容指纹），使 catalog 开箱有 30+ 指标。
  - `apps/api/src/docs/operation-descriptions.ts` 增加三条操作描述（operation-descriptions.spec 机械校验）；重导出 `packages/contracts/openapi/openapi.json`（新增纯加法，oasdiff 不判 breaking）。
  - 新增 `measurement.service.spec.ts`（游标往返/非法输入/分页/表选择/映射，5 例）与 `docs/metrics/metrics-api.md`（端点、可见性、游标、同步命令、余量）。
- 测试：service 单测随 vitest 执行；本地重导出 openapi 后 `git status` 干净（由 CI 的 drift/spectral/oasdiff 复核）；`verify-docs` PASS。
- 未做：/metrics/vric、scorecards、evals、frames、recapture、benchmarks 端点为后续切片；SaaS BFF 代理与看板（PR-05）不在本 PR；未部署不发车。
