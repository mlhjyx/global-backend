---
date: 2026-11-09
title: P3 J03b — judge 双契约拆分（discovery.quick_judge）与 judge-output/v2 生产接线（JUDGE_CONTRACT_MODE，默认 off）
---

- 起因：ch04 §4.3.3.6（W5）与 §4.3.9 W3。L1 快扫与 L2 深判共用 `discovery.qualify_fit`，一条 task 级 override 会同时改写深判模型；L2 深判仍直接取模型自报 verdict，未经 criterion 级证据校验与确定性聚合。
- 改动：
  - 契约拆分（Part A，行为保持）：新增 `discovery.quick_judge`（flash 档、批量 judgments 协议、provisional 粗筛），`quickJudgeBatch` 的批量路径改用该契约与同名技能键；单家降级路径仍在 `discovery.qualify_fit`。新增内置技能 `growth_motion/discovery-quick-judge`（SKILL.md + 5 例 evals）并重新生成技能目录。
  - v2 判定路径（Part B，默认关）：新增 `apps/api/src/discovery/fit-judge-v2.ts`——`buildJudgePrompt`（fit-v2 rubric/冻结 prompt hash）→ 网关结构化调用（task 仍为 `discovery.qualify_fit`，schema 换 judge-output/v2，非 durable）→ `validateJudgeOutputV2` → `validateEvidence`（域门/快照子串/30 天新鲜度/注入防护）→ `aggregateJudgment`（R0–R4）→ FitJudgment（FIT→match / UNKNOWN→weak / NOT_FIT→mismatch）。
  - `JUDGE_CONTRACT_MODE=off|shadow|enforce`（默认 off，非法值回落 off）：off 走旧路径完全不变；shadow 仍用 v1 产 Lead、额外跑一次 v2 并生成 `judgment_record` 草稿（同 run 每家最多一次、失败只记日志）；enforce 只用 v2 聚合 verdict。`judgment_record` 与 Lead 投影在同一个 `prisma.withWorkspace` 事务内写入（`recordJudgment` + `upsertLeadFit`，设计 §4.3.4.4）。
  - 治理同步：`EXPECTED_MODEL_TASKS` 13→14（quick_judge，schema `quick-judgment/v1`）、`MODEL_RESULT_TASK_IDS`/投影注册、`durable-result-strategies.json` modelTasks、run 级预算包络新增 `discovery.quick_judge`（500 家池 / 8 家每批 = 63 次上限）、技能目录与 evals 清单。
- 测试：`fit-judge-v2.spec.ts`（聚合 verdict→Lead 映射、证据域门/子串/拒答、记录字段与 digest、三模式分派、shadow 成本护栏与失败不影响 Lead、enforce 路径）、`quickJudgeBatch` 契约断言（task/model/skillKey）、记录写入同事务顺序断言；`pnpm skills:validate`、execution-authority policy spec、environment-parity spec、`tsx scripts/validate-judgment-evals.mts` 全绿。
- 上线注意：`JUDGE_CONTRACT_MODE` 默认 off，本 PR 不改变生产判定。worker 重启会 seed 新技能目录。v2 调用暂为非 durable（judge-output/v2 尚无注册的 durable 投影），影子期记录无 durable_receipt。
- 未做：`JUDGE_CONTRACT_MODE=shadow/enforce` 的线上开启与金标回归（J13 模型层评测）、L3 面板与 conformal 弃权（k=1 单采样，sampling 如实记录）、`judgment_record.run_id` 回填真实 run id（当前留空，FK 只接受真实 discovery_run 行）、v2 的 durable 结果投影与 replay 保护。
