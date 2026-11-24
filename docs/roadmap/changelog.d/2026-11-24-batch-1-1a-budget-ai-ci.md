---
date: 2026-11-24
pr: 1087
title: Harden AI gateway, rescue discovery budget quote, and unlock CI callsite ratchet
---

- 起因：深度审计与 Phase 1 琏升科技实测暴露出五类阻塞性问题——(1) 8 处外部网页/搜索入参未做 `<untrusted_web_content>` 注入隔离，结构化修复重试未带入上次失败输出，任务 `timeoutMs` 未接通，新版 Claude 5.5/Fable 因透传 `temperature` 报 400，SSE 响应无上限，Token 结算强制 1¢ 保底多收 10–33×；(2) `POST /query-plans/:planId/execute` 预算报价因 `MAX_DISCOVERY_FIT_COMPANIES=18150` 与虚高 Flash 上限被抬到 \$8,408.88；(3) `discovery_company_job.cost_cents` 未随阶段回执原子写回；(4) `execution-authority-policy.mjs` 对已登记工具的物理调用点数做死整数锁定，高频误伤后续 Batch PR。
- 改动：
  - AI 网关与安全：新增 `untrusted-content.ts` 并在 8 处外部网页/搜索调用点接入隔离与系统护栏；新增 `repair-prompt.ts` 将有界脱敏的失败草稿传入修复重试；新增 `task-timeout.ts` 将 `task-registry.ts` `timeoutMs` 贯通全操作（含 `embed`）；`schema-validate.ts` 编译/序列化异常 fail-closed 并加 256 项 FIFO 缓存；新增 `provider-wire-helpers.ts`（省略 Claude 5.5/Fable 及 thinking 的 `temperature`、4MB SSE 流上限、仅对非结算调用做 429 `Retry-After` 退避）；`model-token-cost.ts` 改用 `microusdFromTokens` 按微美元精度结算并升级测试账本至微美元。
  - 预算与写回：`execution-envelope.ts` 将默认帽 `MAX_DISCOVERY_FIT_COMPANIES` 对齐 Run 2 池上限 500（`DISCOVERY_UNCAPPED=on` 仍保留 726,000 防爆界），下调 4 个非技能绑定 Flash 发现任务的 `maxCostCents`（`extract_company: 3¢`、`extract_list: 5¢`、`web_search_candidates: 5¢`、`classify_trade_role: 3¢`），发现报价由 \$8,408.88 降至 \$552.52（下降 15.2×）；新增 `company-job-cost.ts` 并在 Run 2 四阶段活动写回 `discovery_company_job.cost_cents`。
  - 治理与 CI：重新锚定审阅后的 `router-model-gateway.ts` sha256；`execution-authority-policy.mjs` 保留全量 `EXPECTED_TOOL_IDS` / 动态调用 / 模型边界硬门，解除 `EXPECTED_TOOL_CALLSITES` 固定整数棘轮；删除复杂度已降至 20 以下的 `chatCompletions` G9 基线条目。
- 测试：新增 `untrusted-content.spec.ts`、`repair-prompt.spec.ts`、`schema-validate.spec.ts`、`provider-wire-helpers.spec.ts`、`company-job-cost.spec.ts`，更新对应契约与报价单测；本地通过 `check-file-budgets`、`governance-module-boundaries`、`execution-authority-policy`、`docs:verify`、`governance:verify`（523/523）、`api:build` 及 Vitest 相关套件，CI 全量构建与 DB 测试通过。
- 未做：爬虫限流/解码/Chromium 防风暴（PR 1.1-B）、卖家文档上传与 pgvector 修复（PR 1.1-C）、制裁源/T1/基准脚本（PR 1.1-D）及宿主机 `new-api` `ModelRatio` 同步均按单主干顺序在后续 PR 交付。
