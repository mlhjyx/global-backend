---
date: 2026-10-19
title: Rewrite a stale sanctions hit as clear when the company no longer matches
---

- 起因：qualify 以前只在有命中时写 `sanctions_screening_result`。公司的命中全部消失后（名单移除了实体，或匹配规则修正了误报，如 #660），库里仍留着旧的 `potential_match`。accept 与周报导出按库里的记录硬拦（复审 #1 的跨进程兜底），于是这家公司在队列里已经不是 sanctions_hold，却永远无法 accept 或导出，只能人工清。
- 改动：
  - qualify 先对整批公司算完筛查，再一次读出其中「索引生效、这次无命中」的公司在库里的 `potential_match` 记录：未复核或已人工清白的，改写为这次的 `clear` 结果（matches 清空，记下名单版本与时间，复核态不动）；人工确认的真命中保留，lead 继续进 sanctions_hold，与 accept 的硬拦一致。改写的条件写在 where 里，读出之后若有人刚确认了真命中，这里不会覆盖。
  - 索引没生效（`not_screened`：无启用源、索引为空或构建失败）时不读也不改，绝不因为索引坏了就清掉命中。
  - 复核端点 `POST /leads/:leadId/sanctions-review` 遇到已是 `clear` 的记录返回 409 `SANCTIONS_NOTHING_TO_REVIEW`：clear 记录上记复核态不起作用，拒绝而不是假装生效。
- 测试：`qualify.activities.spec.ts` 新增 6 例（改写 open、改写已清白且不动复核态、确认的真命中保留并 hold、not_screened 不读不改、无旧命中不写、有命中照旧 upsert）；新增 `lead.service.sanctions-review.spec.ts` 3 例；qualify / lead / sanctions / report 相关 316 例通过。真实数据：xin 上 8 条记录（都是上次人工清白的误报）用新匹配器对真实名单（12268 个实体）重筛仍全部命中，所以这次部署不会改写现有记录，作用在以后的名单更新与匹配修正。
- 未做：`not_screened` 时 qualify 仍不 hold（设计决策④），而 accept 按库里的命中硬拦，这一不对称维持原样；也没有为从未命中的公司补写 clear 记录。
