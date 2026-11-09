---
date: 2026-11-09
title: Add the offline read-only source scorecard with a reject-reason dictionary (PR-06 script side)
---

- 起因：ch01 PR-06 要求源记分卡能回答「每个源产出多少、拒了多少、为什么拒、值不值得留」；`source_scorecard_daily` 表与日任务依赖 PR-02/03，本波先交付只读离线版并把「目录 74% 拒收」拆成原因码。
- 改动：
  - 新增 `scripts/metrics/source-scorecard.mjs`：按 provider 聚合窗口内 raw/接受/拒收/隔离、`disposition_code` 原因拆分（对照字典，未登记码报 `UNKNOWN_DISPOSITION_CODE` 漂移信号）、全量公司归因（公司数/唯一贡献/有域名）、成本与新鲜度，输出 `source-scorecard-daily/v1` 行（含幂等 `contentHash`，供 PR-03 的 `(day, provider_key)` 主键落表）；混合 source_class 显式标记。
  - 新增 `docs/metrics/schemas/reject-reasons.v1.json`：9 个原因码的含义/owner/处置动作（来源 `raw-source-ingestion.ts` 与线上实际值）。
  - 新增 `docs/metrics/source-scorecard.md`（字段口径、用法、PR-06 验收对照）与真实基线证据 `docs/evidence/2026-11-09-source-scorecard.md`：directory 73.8% 被拒/隔离拆为 SCHEMA_INVALID 70.1% / POLICY_MISSING 26.6% / KEY_DRIFT 3.3%；public_web 接受率 91.8% 但隔离 267 条全为 key drift；5 个 provider 全部有读数；cost_per_valid_contact 因 VALID=0 显式不可算。
  - `source-scorecard.test.mjs`（6 例：聚合、原因拆分与 74% 断言、未知码漂移、混合 class、幂等哈希、空 provider）导入 governance-contracts，随 `docs:verify` 进 CI；门户与 metrics README 增补入口。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿；`source-scorecard.mjs --days 30` 只读实跑；`verify-docs` PASS；governance 全绿。
- 未做：`source_scorecard_daily` 写入、看板/告警（PR-02/03）；成本与 provider 的映射（tool_budget_operation）；`precision_sample`（金标）；未触碰 `evals/golden-judgments/`（另一会话在建）。
