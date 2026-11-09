---
date: 2026-11-09
title: Add the weekly and monthly report generator on top of metric observations (PR-15 template side)
---

- 起因：ch01 PR-15 要求周/月报按固定模板从指标实现生成；度量 API（PR-03/04）与源记分卡（PR-06）尚未接线，本波先交付只读模板侧，避免手写数字。
- 改动：
  - 新增 `scripts/metrics/report.mjs`：读取 `metrics-snapshot.mjs` 产出的 `metric-observation/v1`（支持多个 `--snapshot` 合并），按 ch01 §3.6.7 固定模板渲染周报/月报（北极星 → 覆盖 → 可触达 → 质量门 → 源 → 风险），月报额外含召回/金标与成本对账章节；未接线（recall/golden/PSI/cost）、不可测（T2-002/003/004/009 的 SKIPPED 原因）与缺失观测三种状态显式分列，n<30 自动加「样本不足」标记；输出 markdown + JSON（`--out` / `--out-json`）。
  - 新增 `docs/metrics/reporting.md`（节奏、命令、模板、写作纪律、与 PR-03/04/06 的接线关系）与真实快照生成的样例 `docs/metrics/report-samples/2026-11-09-weekly-sample.md`（VRIC=0、email 覆盖 18.1%、phone 1.0%、contacts/account 0.93；VALID 率与 catch-all 按设计显示不可测）。
  - `scripts/governance-contracts.spec.mjs` 导入 `report.test.mjs`（7 例：ISO 周标签、ALL 行选择、模板渲染、小样本标记、月报独有章节、缺失即缺失、确定性输出），使模板随 `docs:verify` 进 CI。
  - `docs/metrics/README.md` 门户与 `scripts/metrics/README.md` 增补入口。
- 测试：`node --test 'scripts/metrics/**/*.test.mjs'` 全绿（新增 report 7 例）；真实快照+渲染端到端实跑；`node scripts/verify-docs.mjs` PASS；governance 全绿。
- 未做：未改引擎 `report/weekly-report.service.ts`（依赖度量 API PR-03/04，且 CSV 外部形态保持不变的要求待接线时验证）；未做连续两周与一期月报的运营节奏（快照可用了，节奏由产品负责人启动）；未接 PSI/金标/成本。
