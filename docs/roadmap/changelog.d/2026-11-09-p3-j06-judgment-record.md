---
date: 2026-11-09
title: P3 J06（第一批）— 判定记录唯一写入入口与 replay 幂等
---

- 起因：ch04 §4.3.4.4 —— 判定记录必须一次尝试一行、append-only、可复算；写入语义（replay key、同输入重试不翻行、冲突显式报错）必须有唯一实现，否则每个调用点都会各写一份。
- 改动：
  - `apps/api/src/discovery/judgment/judgment-record.ts`：`recordJudgment(tx, input)` 唯一写入入口——闭集校验（verdict/judgeLevel/label/数域/64 位 hex 摘要）、失败码经 `failure-codes.ts` 派生 `stage/cause/outcome/retryable`、`createMany(skipDuplicates)` 依赖迁移中的 replay 唯一键实现 INSERT…ON CONFLICT DO NOTHING；同输入不同 verdict → `JUDGMENT_RECORD_REPLAY_CONFLICT`（绝不静默覆盖）。配套纯函数：`judgmentInputDigest`/`judgmentOutputDigest`/`collectEvidenceRefs`/`buildRecordedCriteria`。
  - `packages/db/test/judgment-record.rls.spec.mjs`（db-tests service 组）：真库验证「新写入→同 attempt 重试不翻行→冲突 verdict 抛错→新 attempt 追加」与失败码派生列。
- 测试：`judgment-record.spec.ts` 8 例纯函数/校验/replay 单测；库上 spec 2 例；`gctl check --fast` 全绿。
- 未做：`fit-judge.ts` 的 shadow 接线（等 J03b 双契约拆分后，把 judge-output/v2 + 聚合器 + 本写入器 + `upsertLeadFit` 串成一个事务）；模型层金标跑分（J13/J19）。
