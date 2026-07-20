# 知识与检索候选 Capability Cards

> 文档 ID：`OSS-FE-005`
> 状态：`CURRENT` / `APPROVED_AT_GATE_7`
> 当前基线：PostgreSQL + pgvector + Docling + BGE-M3；共享企业事实不迁入候选图数据库

## `ADP-FE-015` Cognee

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 候选关系型知识组织/检索；不因项目自带 memory 概念扩大 Company/Claim/Knowledge 真值 |
| 当前等价与证据 | 未采用；当前 KB 能完成解析、embedding、chunk 检索，尚无已验证图关系用户问题 |
| 主决策 | `DEFER / CONTROLLED_BAKEOFF` |
| License / 权利 | Phase 1 精确快照 Apache-2.0；模型、图存储后端、数据源和托管服务另审 |
| Adapter / SoR | 仅可作为 `RetrievalGateway` 后端；输入为批准事实/文档引用，输出为带 provenance 的候选，不写回 Claim 真值 |
| Security / 数据 | Workspace 隔离、图中个人数据、删除传播、embedding/LLM 出境、prompt injection、后台存储与日志 |
| Test / Release Gate | 同 corpus/query 与 pgvector 比较 recall/precision/citation/deletion/isolation/latency/cost；必须证明关系问题的增量价值 |
| Owner / Exit | `OWN-KB-BE`；原文/Claim/embedding source 留我方，图可全量重建，失败时切回 pgvector |

## `ADP-FE-016` Graphiti

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 候选时序关系检索；不把推断边当成事实或覆盖事件/Claim 生命周期 |
| 当前等价与证据 | 未采用；已有 Evidence/Signal 时间和 Site snapshot，未证明需要独立时序图引擎 |
| 主决策 | `DEFER / CONTROLLED_BAKEOFF` |
| License / 权利 | Phase 1 精确快照 Apache-2.0；依赖图数据库、模型和云服务另审 |
| Adapter / SoR | `RetrievalGateway` 只返回 node/edge provenance、valid time 和 confidence；原事实/撤销状态仍在我方 DB |
| Security / 数据 | 时序历史可能延长已删除数据寿命；需 tenant partition、删除/撤销传播、模型调用和图查询限额 |
| Test / Release Gate | 时间切片、冲突/撤销、删除、跨租户、citation、错误边、成本/延迟与 pgvector/SQL baseline 对照 |
| Owner / Exit | `OWN-KB-BE`；图为可重建投影，保留导出 schema，停用后清除图副本并回到 SQL/pgvector |

## `ADP-FE-017` LightRAG

| 字段 | 结论 |
|---|---|
| 用户能力 / 非目标 | 候选图增强 RAG；不替代 Claim/Evidence、文档对象、chunk 权限或 source citation |
| 当前等价与证据 | 未采用；当前 KB 路径已存在且仍有产品合同缺口，先补合同而非换引擎 |
| 主决策 | `DEFER / CONTROLLED_BAKEOFF` |
| License / 权利 | Phase 1 精确快照 MIT；模型/embedding/存储/语料权利另审 |
| Adapter / SoR | 只实现 `RetrievalGateway`，统一 query/filter/citation/deletion；不得向 UI 暴露其内部 graph/schema |
| Security / 数据 | ingestion prompt injection、数据污染、tenant filter、删除完整性、模型出境、缓存/日志和资源 DoS |
| Test / Release Gate | 同 corpus/questions、citation faithfulness、unknown/拒答、poisoning、deletion、isolation、延迟/成本和可重建性 |
| Owner / Exit | `OWN-KB-BE`；保留原文/chunk/embedding 真值，索引可丢弃重建，失败回 pgvector |

## Bake-off 触发与胜出门

只有出现经用户/产品确认的关系或时序问题，并且 SQL/pgvector 基线在固定 Fixture 上达不到目标，才允许三者进入同一 Bake-off。不得同时部署多个图/RAG 引擎探索，也不得以 demo 观感替代删除、租户隔离、引用完整性和退出成本。
