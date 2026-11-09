# frame 快照适配器（ch01 PR-11 离线部分）

> 状态：`DRAFT`（2026-11-09）。本目录只含端口、fixture 适配器与可复用契约测试套件；
> 真实数据源适配器、`frame_registry`/`frame_snapshot` 落表（PR-12）与 local_query 接线均未实现。

frame 的定义与登记见 `docs/metrics/frames/frame-registry.v1.json`（PR-10）；本目录负责把
「一个已登记的 frame 的一次拉取」变成带哈希与血缘的快照：

```text
FETCHING → PARSING → VALIDATING → READY | QUARANTINED | FAILED
```

- `frame-adapter.ts`：端口类型 + 状态机驱动 `runFrameAdapter`。驱动只做结构校验（frameKey/
  parserVersion 一致、sourceUrl、ISO 时间戳、rowCount、sha256）与异常封装；业务校验在
  `adapter.validate`。
- `fixture-frame-adapter.ts`：内存合成数据的参考实现（无网络/数据库），演示排除规则
  （`status_not_active`）与行数对账。
- `frame-adapter.contract.ts`：可复用契约套件 `defineFrameAdapterContract(...)`。真实适配器接入时
  在自己的 spec 里调用一次，即覆盖：状态机全序、同 asOf 可复现、实体+排除=行数、实体键唯一、
  ISO-2 国家、frame.adapter 血缘、FETCH_FAILED 封装、QUARANTINED 不被误报为 READY/FAILED。
- `fixtures/frame-fixture.v1.json`：纯合成记录（虚构登记号，无个人联系方式）。

## A 方案预留位（只有类型）

2026-11-09 用户拍板 A 方案：`registry_frame` 以 local_query 血缘变体接入 registry，开关默认关。
P2 落地血缘契约后，由 `producer: "registry.query"` 的本地回执接入。本目录只有
`LocalQueryFrameLineageReceipt` 类型占位（`receipt` 故意不透明），**不实现、不 import**
`apps/api/src/discovery/` 的血缘文件（那是 P2 的在飞文件面）。

## 测试

```bash
pnpm --filter @global/api exec vitest run src/measurement/frames
```

契约套件跑在 fixture 适配器上；驱动失败路径（SNAPSHOT_INVALID / PARSE_FAILED /
PARSE_ROW_COUNT_MISMATCH / VALIDATION_ERROR / FETCH_FAILED 含 maxBytes）有独立用例。
