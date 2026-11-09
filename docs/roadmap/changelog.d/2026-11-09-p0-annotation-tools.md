---
date: 2026-11-09
title: Add offline annotation worksheet and import pre-check tooling for the golden set (ch01 PR-08 tooling)
---

- 起因：ch01 PR-08 的人工标注（J13）需要一个不依赖引擎的前置工具：从金标候选生成双人工作表，导入时做结构与 Cohen's κ 预检。
- 改动：
  - 新增 `scripts/metrics/annotation-worksheet.mjs`：读 `golden-sampling.mjs` 的样本 CSV（`ref,layer,stratum`，ref 为盲化键，无 PII），按 `seed+dataset+annotator` 确定性打乱，为 A/B 各生成一份 CSV/JSON 工作表（字段与词表来自 `rubric-v1.md`），并写 worksheet manifest（样本哈希 + 各自行序哈希）；已存在文件默认拒绝覆盖。
  - 新增 `scripts/metrics/annotation-import.mjs`：导入两份已填工作表，校验列结构/未知列/重复或不成对 ref/词表外取值，逐字段计算 raw agreement 与 Cohen's κ（复用 `golden-run.mjs` 实现），输出分歧裁决队列 CSV；退出码 0 通过 / 1 结构错误 / 2 κ<0.6 或双标不足 100。
  - 新增 `evals/golden-discovery/annotation-workflow.md`（工作流、词表、退出码、与 golden-label/v1 的关系）并更新 README §2 第 4 步；`scripts/metrics/annotation-tools.test.mjs`（9 例，含两个 CLI 真实子进程冒烟）接入 governance-contracts。
- 测试：`node --test scripts/metrics/annotation-tools.test.mjs` 全过；generator 重跑拒绝覆盖已填表。
- 未做：工具不产出 `golden-label/v1`（裁决是人的决定，落盘与评测由 J11/golden-run 线负责）；不接数据库、不调用模型；未发车、未部署。
