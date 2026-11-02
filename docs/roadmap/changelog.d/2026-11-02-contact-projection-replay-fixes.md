---
date: 2026-11-02
title: Survive anti-bot statuses and retry replays in the contact stage
---

- 起因：第九班验收 run `4fe3e874` 在联系人阶段 FAILED（stage=contacts, control），第八班上 GainOS run `3649e39a` 同源。两层缺陷叠加：
  - ① `social.fetch` 抓 LinkedIn 时上游返回 **HTTP 999**（本机同 UA 实测稳定复现），而 `social-fetch/v1` 投影契约的 status 上界是 ≤599 → 投影拒绝 → ToolBroker 把已付费操作留在 RESERVED 并抛 `BudgetOperationReplayError(origin='live')` → 被当 control 错误，整条 `discoverRunContacts` 失败，重试后同样再犯。
  - ② 重试 attempt 2 时，#728 的 attempt 隔离键让 model 操作产生新回执（APPLIED），而工具操作按同 key 重放旧回执（REPLAYED），同一公司持久化批次混合 → `DOMAIN_ACK_MIXED_REPLAY_STATE`（control）→ run FAILED。
- 改动：
  - `social-fetch/v1` 的 status 上界放宽到 999（状态码只是事实记录；LinkedIn 999 是已知的非标准反爬码）。
  - ToolBroker 投影拒绝路径改为**按实付结算、无 durable result**，并抛非控制错误 `TOOL_DURABLE_RESULT_PROJECTION_REJECTED`（适配器按源跳过；后续同 key 重放读回已结算的无结果行，按 remnant 吸收）——任何投影契约外的上游行为不再以 fail-closed 形式打死整条活动。
  - 撤销联系人阶段 model 操作的 attempt 隔离键（保留 #728 的 remnant 吸收）：重试一律**重放**已结算操作，不重跑、不重复计费。
  - 联系人持久化改为**按适配器分批确认回执**（对齐 signals 阶段的 ack-split 先例）：部分重试时「已确认的适配器（REPLAYED）」与「首次成功的适配器（APPLIED）」不再进同一批次，`DOMAIN_ACK_MIXED_REPLAY_STATE` 不再由跨适配器混合触发。同一适配器在一次重试里多出全新回执的极端混合仍按失败关闭处理（与 signals 阶段现状一致，记为后续）。
  - 查询阶段把 `TOOL_DURABLE_RESULT_PROJECTION_REJECTED` 与「不可重放操作」同等吸收：该 provider 以零回执收口（governed/legacy 两种模式都计入），不再以 lineage 回执不匹配的 control 错误打死整条 run。
  - 防同类再犯：`social.fetch` 的页面文本按 durable 契约整形（去 NUL、孤立代理项→U+FFFD、NFC、按码点边界截断）——原始 HTML 的 NUL/NFD/代理对切口此前同样会让投影拒绝；ToolBroker 在任何出网与预留之前拒绝**未注册的 typed projection schema**（部署缺陷 fail-closed，不再「付了钱但结果永远投影不了」）。
- 测试：`social.fetch` 999 投影、ToolBroker 结算+拒绝路径、旧「no-second-wire」用例改为新契约；联系人 stage、回执消费者与工具全组单测见 PR。
- 部署：无迁移；随下一班车上线后重跑联系人验收。
- 说明：撤销 attempt 隔离键后，重试改为重放已结算操作、通常不再新增花费；每次 attempt 仍各有一份基线，run 账户剩余额与两次基线的和仍构成绝对上界（#733 片段已同步更正）。工具侧投影契约外的上游结果在联系人、查询与富集阶段都以「按源跳过/零回执」收口；**model 侧**投影拒绝（router-model-gateway 的 projection catch）仍是 fail-closed，未在本次范围内（记为后续）。代价是重试可能吸收残留而少跑某个适配器的结果（best-effort，与 #728 的吸收纪律一致）。
- 未做：没有回填第八班 GainOS run `3649e39a` 的失败统计（其 stats.failure 已由 Docker 会话取证）；撤销 attempt 隔离键后重试可能吸收残留而少跑某个适配器的结果，属已知取舍；model 侧投影拒绝（router-model-gateway）的同类 fail-closed 路径未改——且撤销 attempt 键后，重试会把该次 model 调用按 remnant 永久跳过。
