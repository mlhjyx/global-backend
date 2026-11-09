---
date: 2026-11-09
title: P3 J12 — borderline 三模型判定面板（JUDGE_PANEL_MODE，默认 off）
---

- 起因：ch04 §4.3.3.6 L3 与 §4.3.9 J12。L2 深判在 borderline 带（加权分 3.5–7.0）只能给 UNKNOWN；设计要求对这批「模型不确定」的候选跑 3 个不同家族模型的面板，多数票（2/3）定音、不一致回 UNKNOWN，且逐模型写 `judgment_record`、逐模型记账。
- 改动：
  - 新增 `apps/api/src/discovery/judgment/panel.ts`：`JUDGE_PANEL_MODELS`（deepseek-v4-pro / gemini-4-argon-high / gpt-5.6-sol，全部经 `JUDGE_MODEL_ALLOWLIST` 校验，fail-closed）；`judgeFitPanel` 对同一输入依次调用三家（复用抽出的 `judgment/judge-run.ts` 单模型执行器：同一 prompt / judge-output/v2 / 证据校验 / 确定性聚合）；多数票 ≥2/3 定 verdict，无多数（含 1/1/1、UNKNOWN 混杂）→ UNKNOWN；拒答票记 UNKNOWN 且计入；非控制面调用失败记 UNKNOWN 票并继续，预算/控制面错误显性上抛。
  - 记录：每模型一行 `judgment_record`（judge_level=3、model_requested 为该模型、`model_resolved/model_reported` 如实、sampling.k=1、成本逐模型记 `cost_micros`），面板结论再写一行汇总（judge_level=3、`model_requested='panel'`、verdict=多数票、sampling.votes 记录票型、成本不重复记账）。replay key 不含 model 列，`attempt` 承载面板槽位语义：1..3 = 三模型槽位、4 = 汇总行，同一输入重放幂等命中同一槽位。
  - 接线：`judgeFitV2` 在聚合为 borderline UNKNOWN（scoreWeighted ∈ (3.5, 7.0) 且非证据门/注入/拒答）时按 `JUDGE_PANEL_MODE=off|shadow|enforce`（默认 off，非法值回落 off）触发——shadow 只写记录、不改 verdict/Lead；enforce 用面板多数票替代该情形的 v2 verdict。面板仅在 v2 路径（`JUDGE_CONTRACT_MODE=shadow/enforce`）内生效，contract=off 时任何面板取值都不触发；同 run+company 进程内单次护栏与 shadow v2 同款。`persistJudgmentRecordInTransaction` 扩展为按「主记录 → 逐模型槽位 → 汇总行」顺序写入，panel=shadow 的记录写入失败只记日志、不回滚 Lead。
  - 治理：`JUDGE_PANEL_MODE` 是运行期灰度、不分支 app environment，不产生 ENVIRONMENT_BRANCH finding，也不登记 configuration_allowlist；`judgment/judge-run.ts` 复用既有 `getTask('discovery.qualify_fit')` 契约锚点，无新增模型任务、无迁移。
- 测试：`panel.spec.ts`——多数票（2/3、3/3、1/1/1→UNKNOWN、拒答计票、双拒答→UNKNOWN）、逐模型记录行（level=3、model 列、cost_micros、占位 criteria 不伪造判定）、预算分账（基础判定 + 三个面板模型各一次、模型序列断言）、开关矩阵（off/off 与旧路径逐字一致；contract shadow 下面板不改 Lead；enforce+shadow 不改 Lead；borderline 之外/证据门/拒答不触发）、控制面错误上抛与 shadow 吞错语义、进程内护栏幂等、多条记录写入顺序与 tolerant 语义；`fit-judge-v2.spec.ts` 既有断言不回归。
- 未做：`JUDGE_PANEL_MODE=shadow/enforce` 的线上开启（默认 off，本 PR 不改变生产判定）；面板模型的金标校准与模型层评测（J13/J19）——当前白名单沿用 JUDGE_MODEL_ALLOWLIST；面板记录的 `run_id` 回填（与 v2 主记录一致当前留空）；面板并发化（当前依次调用，预算错误可尽早停止）。
