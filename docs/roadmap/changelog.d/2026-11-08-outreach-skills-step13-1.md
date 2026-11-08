---
date: 2026-11-08
title: Add the S2 outreach skill packs (grounded sequence draft + reply classification)
---

- 起因：M2 步 13（设计 `docs/superpowers/plans/2026-11-08-outreach-skills-l2-m2-step13.md`，APPROVED）要求交付「写好这封信 + 看懂回信」的两个 S2 技能；本 PR 为 13-1（技能包与评测），不触碰发送通道/审批实现（步 11 在飞）。
- 改动：
  - 两个 AI task 契约：`outreach.sequence_draft`（subject/body/language/groundedOn/jurisdictionFooter，files-only，humanGate）与 `engage.reply_classify`（7 枚举意图 + 置信度，flash 档）。
  - 两个确定性守卫（`apps/api/src/skills/guardrails/`）：起草的接地/页脚/长度/语言/夸大与引用审批校验（`GROUNDING_REQUIRED` 短路，不接地不产稿；`steps[]` 预留字段必须与顶层稿面一致）；分类的闭集校验、自动回复文本上的 POSITIVE/UNSUBSCRIBE 冲突升级（`AUTO_REPLY_CONFLICT`，防止 OOO 套话触发自动退订）与低置信（<0.6）升级 NEEDS_HUMAN。
  - 两个 SKILL.md 技能包（tenant-default enabled）+ 生成目录；各 12 条 Golden Set（8 条模型层 + 4 条确定性层，含设计 §7 负向 1/2/4/5 具名用例；负向用例的 tier 被测试钉死）；零模型层进 CI，模型层由 `scripts/run-skill-model-evals.mts` ops 实跑并写 `eval_receipt`（成本上限 + 契约 maxTokens + 接地预检先于付费调用）。评测执行器位于 `apps/api/src/skills/eval/`（构建排除，不进 OCI 制品）；`tier` 进入评测清单词汇校验。
- 测试：守卫单测（正向 + 负向码表，含自动回复×UNSUBSCRIBE 对抗）；两技能确定性层逐条执行断言；模型层执行器零网络测试（假 callModel 验证守卫参与断言、接地预检不调用模型、成本上限、prompt 不泄露 guards 数据）；`skills:validate` / `skills:evals:validate` / 生成目录同步门。
- 未做：草稿存储/审批界面（13-2，gain-saas）、逐封发送 L2 门与审计包（13-3）、端到端联调（13-4）。技能未接入任何在飞 workflow。
