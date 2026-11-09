---
date: 2026-11-09
title: Run the golden replay CLI as a CI smoke gate on every docs:verify pass (PR-09 precursor)
---

- 起因：ch01 PR-09 要求金标回归能在 CI 判红；真正的路径触发与夜间跑批依赖度量 API（PR-04）与真实金标（PR-08），本波先把「零模型 replay 链路」做成每次 CI 必跑的冒烟门。
- 改动：
  - 新增 `scripts/metrics/golden-ci-smoke.test.mjs`：以真实子进程执行 `golden-run.mjs`——demo 集必须退出 0 且 `passed=true`；同集的变异副本（改坏 `is_company`）必须退出 1 且 `G3_is_company` 判红；`--out` 落盘产物必须是合法 `golden-run/v1`。
  - 该测试导入 `scripts/governance-contracts.spec.mjs`，随 `docs:verify` 在每次 PR 的 governance 检查中运行（3 例，约 1 秒）；`evals/golden-discovery/README.md` 增补说明。
- 测试：`node --test scripts/metrics/golden-ci-smoke.test.mjs` 3/3；governance 472/472；`verify-docs` PASS；本地 pre-push 门按既定处理跳过（`GLOBAL_SKIP_PREPUSH=1`，gitleaks 照常）。
- 未做：路径触发（改 prompt/skill/判定代码才跑真实金标）、夜间 live 跑批、真实金标目录接入（待 PR-08 标注与 PR-04 API）；未触碰 `evals/golden-judgments/`。
