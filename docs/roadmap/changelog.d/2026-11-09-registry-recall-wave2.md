---
date: 2026-11-09
title: Extend the registry frame foundation — query contract, multi-source frame catalog, recall report v2
---

- 起因：ch03 P2 第二波（#907 地基合入后的下一批卡片）——给「frame → 候选枚举」补上可执行的查询契约，把 frame 从 2 个样例扩到 4 个源形态（含 FR Sirene 的 `;` 分隔与 NAF 编码、US SAM 的嵌套 JSON），并让召回审计报告支持环比与 miss 归因（ch03 §3.9.12 / §3.17.4）。
- 改动：
  - `apps/api/src/registry/query.ts`：`registry_frame` filters 白名单校验（未知键拒绝、country ISO2、nace 前缀 2–4 位数字或 `28.13` 形式、规模带枚举、法定形式大小写不敏感、limit 默认 500 上限 2000）→ 参数化 Prisma 查询（固定 `ORDER BY scheme, reg_number`，只查 `withdrawn_at IS NULL` 且 last_snapshot 仍为 PARSED）→ `ProviderCompanyRecord` 映射（externalId `scheme:regNumber`、identifier、员工带中位数、licence/attributes.registry provenance）。
  - `scripts/frames/query-preview.mts`：查询契约的可运行入口（只读，`--database-url`/env），输出 rationale + filters + records。
  - 多 source 帧：新增 `fr_sirene`（INSEE stock 风格 CSV，`;` 分隔、NAF 28.13Z、trancheEffectifs 映射）与 `us_sam`（SAM.gov entityData 嵌套 JSON、UEI 主键、州入 region）两个帧配置与 fixture；`scripts/frames/frames/catalog.json` 登记全部 4 帧（frame-catalog.spec 强制覆盖与装载断言）。`frame-normalize` 的 NACE 校验扩展到国家派生码（`28.13Z`/`2813`）。
  - 召回审计 v2（`recall-audit.ts` + `recall-audit.mjs`）：结果新增 `missedKeys`；`--baseline` 环比（逐层 recall/domain_rate Δpp，|Δ|≥5pp 标 ⚠，缺层提示）；`--verdicts` miss 归因（Top-5 原因 + 未归因计数，防止 Top 原因掩盖裁决缺口）。
- 测试：vitest 100 项（query 契约 16 项 + catalog 装载 6 项 + 既有 78 项全部保持绿）；`node --test scripts/frames/recall-audit.spec.mjs` 7 项（含环比、归因、非法 baseline）；一次性库端到端：4 帧装载 13 实体后，FR/DE/US 的 filters 查询命中与排除行为符合口径，scratch 库已删。
- 未做：`registry_frame` 尚未注册为 discovery provider（T3-09：计划路由 + receipt + materialization 接线）；FR `diffusionCommerciale` 过滤与 NAF→NACE 全表映射（T3-05）；真实注册库接入与发车（不在本波）。
