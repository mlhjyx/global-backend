---
date: 2026-11-11
title: 补齐 #1008 漏提交的 TS 治理层 + 公司站点兜底对 model_web_search 开放（迁移 20261110170000）
---

- 起因：#1008 合入 DB writer 迁移与 changelog，但 TS 侧三处补丁在提交时遗漏（补丁脚本落在根 checkout 而提交发生在 worktree），运行镜像仍以 `UNGOVERNED_PROVIDER_PAYLOAD` 拒收 model_web_search 记录（run 6b146843：记录已产出、2 条被拒）。补齐后进一步发现公司站点兜底治理（`public_web:company_site`）在 TS `governingPolicy` 与 DB `raw_source_policy_binding_v3` 中都只认 public_web——model_web_search 的证据页同样在记录自身域名上，需要同口径开放。
- 改动：
  - `raw-source-provider-schema.ts`：`GOVERNED_PROVIDERS` 增加 `model_web_search`；新增 `validModelWebSearchAttributes`（仅 `{discoveredBy, evidenceUrls(1–3 稳定 https), searchExecutor(deepseek|searxng), searchQuery?}`，禁 identifier；license 可缺省）；dispatcher 接线。
  - `raw-source-provider-normalizer.ts`：`PROVIDER_KEYS` 与属性归一分支（投影逻辑抽 `normalizeModelWebSearchAttributes` 保持分发复杂度只 +1）。
  - `raw-source-ingestion.ts`：`governingPolicy` 的公司站点兜底扩展到 `model_web_search`，并按源主机 == 记录域名的**子域**匹配（`www.` 前缀与 `shop.x.com` 等）。
  - `model-web-search.provider.ts`：证据仅取稳定 https URL（无 query/fragment/凭据）；新增 `[model_web_search] explore/landing` 逐阶段计数日志。
  - 迁移 `20261110170000_model_web_search_company_site_policy`：`raw_source_policy_binding_v3` 的 company-site 分支 provider 白名单加 `model_web_search`（其余逐字保留）。
  - `raw-source-ingestion.spec.ts`：新增回归用例（合法记录 ACCEPTED；非白名单 executor / 带 identifier / 带 query 的证据 URL 均 REJECTED）。
- 测试：真库事务内（BEGIN→应用迁移→断言→ROLLBACK）——payload 闸门正/负例与 TED 回归；policy binding 对 `model_web_search` 与 `public_web` 均返回 `source_policy`。本地 5 个 spec 149 用例全绿；G9 门槛（3 处基线按规则上调并写明理由）。
- 未做：registry_frame 的同类白名单缺口仍在（其 provider 目前不产记录）。
