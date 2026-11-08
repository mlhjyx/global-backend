---
date: 2026-11-09
title: P3 J10 — 确定性聚合器 R0–R4 与证据校验（judge-aggregate/v1、evidence-validate/v1）
---

- 起因：ch04 §4.3.3.4（D4-4）——模型自报总分不可复现；最终 verdict 必须由确定性代码聚合，模型输出只保留 `verdict_proposed` 作诊断。
- 改动：
  - `apps/api/src/discovery/judgment/aggregate-judgment.ts`：纯函数 `aggregateJudgment`，按设计顺序执行 R0 反注入（证据命中页面内嵌指令 → 该 criterion 强制 unclear）、R1 硬失败（C1/C2 ≤2 且证据有效 → NOT_FIT，不被加权分救回）、R2 证据门（任何 applicable criterion unclear/无有效证据 → UNKNOWN）、R3 加权分（仅 applicable 项按权重重新归一）、R4 判定（≥7.0 且每项 ≥5 → FIT；≤3.5 → NOT_FIT；其余 UNKNOWN）。阈值来自 rubric 常量（`aggregationRulesSnapshot` 供单测对账），reason 为闭集 `JUDGMENT_REASON_CODES`。结构错误（重复/缺失 criterion、缺证据报告）直接抛错。
  - `evidence-validate.ts`：证据校验 `validateEvidence`（设计 §4.3.3.5）——URL 必须通过注入的域白名单/source_policy 门；span 必须去空白后逐字出现在本次输入快照；website/impressum 证据超过 30 天记 `EVIDENCE_STALE`；抓取时间非法 fail-closed；命中注入模式记 `PROMPT_INJECTION_DETECTED`。注册库/目录证据不参与新鲜度判定。
- 测试：`aggregate-judgment.spec.ts` 15 例 + `evidence-validate.spec.ts` 10 例——设计原文三个边界（C2=0 竞品 vs 其余 9 分、C1 unclear vs 其余 9 分、全 6–7 borderline）逐条落测；另覆盖硬失败需证据、注入、权重归一、score 缺失、全不适用、确定性、结构错误 fail-closed。
- 未做：conformal（R5，L4 工件）、门引擎（J05）与 `judgment_record` 写入（J06）、任务注册表接线（J03）。
