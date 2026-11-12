---
date: 2026-11-12
title: Add warn-only compatibility validators for run/scored events
---

- 起因：`DiscoveryRunCompleted` 与 `LeadsScored` 的历史 payload 与完整 v1 形状不完全一致（可缺 `taskRef`/`stats`/`cost`，`LeadsScored` 从无 `status`），在回放观察前直接 fail-closed 会阻断旧事件。
- 改动：
  - `event-registry` 增加按事件类型的宽松兼容校验，以及只记 warning 的 `validateIntegrationEventWarnOnly` 入口；`DiscoveryRunCompleted` 只强制 `status`，`LeadsScored` 只要求 `scored` + `queues`，不要求 `status`。
  - relay 在信封硬门之后记录 `payload_contract_mismatch` 警告，不 park、不改变消费者行为。
  - 新增两份 v1 JSON schema（`discovery-run-completed` / `leads-scored`）供集成方参考。
- 测试：`event-registry.spec.ts`、`outbox-routing.spec.ts`、`outbox-dev-fast-lane.spec.ts` 共 66 tests passed；全量 13243 passed；build 与 lint 通过。
- 未做：未升级为 fail-closed；是否升级留待一轮真实回放观察后单独决策。
