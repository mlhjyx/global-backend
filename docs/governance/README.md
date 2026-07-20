# 文档治理入口

> 文档 ID：`GOV-FE-000`
> 层级：`L1 / Registry index`
> 状态：`CURRENT`
> 事实 Owner：`OWN-DOC-GOV`
> 最后核验：2026-07-20

本目录是跨文档 ID、状态、Owner 和追踪关系的唯一登记入口。它不重写产品边界、架构、ADR、当前状态或机器契约。

## 1. Registry

| Registry | 回答的问题 | 唯一负责的事实 |
|---|---|---|
| [术语与状态](terminology-and-status.md) | 一个词或状态究竟是什么意思 | 权威层、事实/文档/交付/场景状态、责任角色 |
| [文档登记](document-register.md) | 应该读哪份文档，旧稿去哪里 | 文档生命周期、Owner、替代/迁移和来源覆盖 |
| [能力登记](capability-register.md) | 产品到底有哪些能力、做到哪一轴 | Capability ID、用户结果、多轴状态、能力包入口 |
| [核心对象登记](core-object-register.md) | 谁拥有数据，生命周期是什么 | Object ID、SoR、社会属性、生命周期与接缝 |
| [场景目录](scenario-catalog.md) | 用什么可复现场景评审和验收 | Scenario/Fixture ID、前置、失败恢复、证据状态 |
| [冲突登记](conflict-register.md) | 哪些矛盾已裁决，哪些仍阻塞 | Conflict ID、状态、唯一 Owner、裁决/目标 Gate |
| [追踪矩阵](traceability-matrix.md) | 用户价值如何追到页面、合同和证据 | Capability→Journey→Page→Object→Contract→Code→Scenario |

## 2. 唯一事实规则

- Phase 1 是冻结审计证据，Phase 2 是产品/IA 决策 provenance，Phase 3 Registry 承接已批准的稳定 ID 与归属。
- Registry 只存“索引和关系”；完整产品论证、实现细节和测试内容仍留在各自事实源。
- `docs/frontend/` 只消费这些 ID；不能另建一套能力、对象或状态清单。Gate 4 通过前它仍是 `ACTIVE_INPUT / Normative candidate`。
- 当前未指派的 SaaS、前端、设计、数据、QA、运营和安全责任必须继续显示为 `UNASSIGNED`，不得以 Codex 或模糊“团队”代填。
- 历史文件在引用映射、Owner 和用户授权完成前不移动、不归档、不删除。

## 3. 变更顺序

```text
发现新事实/冲突
→ 定位主题 Owner
→ 更新承重事实或作出 Decision/ADR
→ 更新对应 Registry 关系
→ 更新读者视图/指南
→ 补场景、证据和 Release Bundle
```

如果只能完成其中一部分，状态保持 `PROPOSED / OPEN_CONFLICT / UNKNOWN`；禁止从草稿直接跳成 `CURRENT` 或 `AS_BUILT`。

## 4. 当前 Gate

Gate 3 已通过并授权 Phase 4。当前 Registry 固化的产品决定包括：B2B 制造/工贸/传统出口为首批客户，海外增长/外贸运营为默认操作者，六项一级 IA，共享 Company/Offering/Claim/Evidence/Asset 事实底座，以及止于可信开发预览的首个纵切。

[全局前端规范](../frontend/README.md)和[设计资产治理](../design/README.md)已在 Gate 4 获批；[独立站管理 Capability Pack](../frontend/modules/independent-site-management/README.md)已形成 Gate 5 候选。正式 SaaS 前端仓库、设计事实源和相应 Owner 仍未指派，Workspace/allowed actions、Claim review、指标/隐私等合同继续阻塞实施。Phase 6–8 尚未授权。当前审查入口见 [Gate 5 评审包](../roadmap/saas-frontend-phase-5/gate-5-review.md)。
