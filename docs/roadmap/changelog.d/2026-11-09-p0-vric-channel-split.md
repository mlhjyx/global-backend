---
date: 2026-11-09
title: Emit the VRIC PLUS channel split (email_only/phone_only/both) from the T0-002 rollup query (PR-03 remainder)
---

- 起因：指标字典 §1.3.1 要求 VRIC_PLUS 必须同时报告 email_only / phone_only / both 通道拆分，而 PR-03 的 T0-002 查询只出总数行——口径已登记、实现未跟上。
- 改动：`metric-queries.ts` 的 T0-002 查询按人（dedupe_key）聚合 has_email/has_phone 标记，除原有总数行外，再为每个 workspace 与平台 ALL 各输出三行 `channel` 分层（email_only / phone_only / both，分母仍为 match 账户数）；总数口径与人级去重逻辑保持不变。
- 文档：`docs/metrics/rollup-workflow.md` 指标表注明通道拆分；`docs/metrics/metrics-api.md` §5 更新（/metrics/vric 会以 strict=null + plus.value 的同桶附加项呈现通道行，不合并不推断）。
- 测试：`run.spec.ts` 新增 T0-002 通道 stratum 映射用例（4 行 → 4 个观测、stratumKey 含 channel）；`vitest run src/measurement` 全过。
- 未做：STRICT（T0-001）无通道概念、不改；历史观测不重写（append-only，重跑该日即得新行）；未发车、未部署。
