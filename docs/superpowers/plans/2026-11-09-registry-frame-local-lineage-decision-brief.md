# 决策简报：registry_frame 的 local_query 血缘变体（A 方案）

> 生命周期：`DRAFT`
> 依据：一页决策材料，供产品负责人对 `docs/superpowers/plans/2026-11-09-registry-frame-local-lineage.md`（完整设计）拍板；未获批前不改血缘/物化契约代码。

## 要决定什么

`registry_frame`（本地注册库 frame 枚举，零出网零成本）已完成注册与路由面（#927），但 discovery 执行器恒以 governed-lineage 模式运行，血缘契约要求逐记录 durable 回执（物理调用产物）——本地 SQL 没有物理调用可出回执，因此它今天**恒被路由闸门排除**（计划期 `SOURCE_LINEAGE_UNAVAILABLE`）。要不要给血缘契约增加 `local_query` 变体，让它真正产出候选？

## 选项对比

| | **A：local_query 变体**（推荐） | 现状：保持注册不可执行 | B：绕过回执管线直接投影（已否决） |
|---|---|---|---|
| 效果 | registry_frame 走现有 executeQuery/materialization，成本 0 产出候选；可回放可审计（resultDigest 可从 DB 重算） | T3-09 只剩登记面；注册库召回价值为零 | 与治理方向相悖（回执管线是所有源的一致审计缝），且物化准入仍需每查询回执，B 实际不可行 |
| 影响面 | `PROVIDER_RECEIPT_CONTRACT`/domain-ack producer 集/governed plan key 联合各加一个白名单项；新增 `LocalQueryExecutionReceipt` 类型；普通 7 个 provider 校验**零放宽** | 无 | 大且危险 |
| 工作量 | 3–5 人日（契约 2d + 适配器接线 1d + 真库/回放验证 1–2d） | 0 | — |
| 回滚代价 | `REGISTRY_FRAME_PROVIDER=off` 即回今天行为；契约增量 additive，可按 operationId 精确删回执 | 0 | — |
| 主要风险 | 借道伪造（已闭锁：仅 `registry.query` 可构造 local 回执）；digest 与真实数据不一致（可从 DB 重算 + 抽样复核） | 注册库召回继续为空，P2 的「分母」无法变候选 | — |

## 推荐

**批准 A**，并按 shadow（只算不落）→ on 灰度上线。理由：它是唯一让 P2 已建成的 frame/装载/查询/审计资产产生召回价值、且不腐蚀血缘治理的路径；成本与回滚都有明确边界。

## 不做的后果

- 注册库 frame 永远只是「档案库」：装载的 13M+ 实体（第一批 15 源规划）无法进入 discovery，P2 的召回率指标只能测租户源、测不了注册口径；
- 域名解析（T3-13 校验器已就绪）没有输入；T3-20 Tier A 审计的分母与分子都缺一半；
- 后续 T3-04..08 真实注册库接入的验收（「N 实体入库 → 可查候选」）无法闭环。

## 批准后立即执行

执行面 PR（单独立项）：两表落库（`company_domain_resolution`/`domain_review_task`）+ 产物池导出 + `registryFrameSyncWorkflow`/`domainResolutionWorkflow`/`recallAuditWorkflow` 接线 + shadow→on 灰度与真库回放验证。
