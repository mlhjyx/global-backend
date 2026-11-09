---
date: 2026-11-09
title: Add the offline frame snapshot adapter port, fixture adapter and reusable contract suite (ch01 PR-11 offline part)
---

- 起因：ch01 PR-11（frame 适配器）依赖 registry A 方案定形，先交付离线部分：端口、fixture 实现与可复用契约测试套件，不接注册表数据、不落表。
- 改动：
  - 新增 `apps/api/src/measurement/frames/frame-adapter.ts`：`FrameAdapter` 端口（fetchSnapshot/parse/validate）、快照元数据类型（sourceUrl/fetchedAt/rawObjectUri/rowCount/contentHash/parserVersion）、实体与排除口径（entities + exclusions.total = rowCount）、血缘类型，以及状态机驱动 `runFrameAdapter`（FETCHING→PARSING→VALIDATING→READY|QUARANTINED|FAILED；结构校验与 FETCH_FAILED/PARSE_FAILED/PARSE_ROW_COUNT_MISMATCH/VALIDATION_ERROR 封装）。
  - 新增 `apps/api/src/measurement/frames/fixture-frame-adapter.ts` 与合成 fixture：内存记录、稳定序列化哈希、状态排除（status_not_active）、行数对账与校验清单，作为后继真实适配器的参考实现。
  - 新增 `apps/api/src/measurement/frames/frame-adapter.contract.ts`：`defineFrameAdapterContract(...)` 可复用套件，覆盖状态机全序、同 asOf 可复现、实体+排除=行数、实体键唯一、ISO-2 国家、frame.adapter 血缘、FETCH_FAILED 与 QUARANTINED 语义；`frame-adapter.spec.ts` 14 例含驱动失败路径。
  - A 方案预留位：`LocalQueryFrameLineageReceipt`（producer=registry.query）仅类型占位，`receipt` 保持不透明，不实现、不 import `apps/api/src/discovery/` 的血缘文件（P2 在飞面）。
  - `apps/api/src/measurement/frames/README.md` 说明端口语义、契约套件用法与未实现范围。
- 测试：`vitest run src/measurement/frames` 14 例全过；`pnpm --filter @global/api build` 通过。
- 未做：真实数据源适配器、`frame_registry`/`frame_snapshot` 落表（PR-12，需 schema 窗口）、local_query 接线（等 P2 血缘契约）、抽样核验；未发车、未部署。
