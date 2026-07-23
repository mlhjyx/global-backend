# 文档治理入口

> 文档 ID：`GOV-FE-000`
> 层级：`L1 / Registry index`
> 状态：`CURRENT`
> 事实 Owner：`OWN-DOC-GOV`
> 最后核验：2026-07-23

本目录只维护跨文档的稳定 ID、状态、Owner、冲突和追踪关系。产品边界、架构、ADR、当前状态、前端规则和机器合同仍由各自事实源负责。

## 1. 当前 Registry

| Registry | 回答的问题 | 唯一负责的事实 |
|---|---|---|
| [术语与状态](terminology-and-status.md) | 一个词或状态是什么意思 | 权威层、状态词和责任帽子 |
| [能力登记](capability-register.md) | 产品有哪些能力、各轴做到哪里 | Capability ID、用户结果、多轴状态和能力入口 |
| [核心对象登记](core-object-register.md) | 谁拥有数据，生命周期是什么 | Object ID、SoR、社会属性、生命周期与接缝 |
| [场景目录](scenario-catalog.md) | 用什么场景评审和验收 | Scenario/Fixture ID、前置、恢复和证据状态 |
| [冲突登记](conflict-register.md) | 哪些矛盾已裁决，哪些仍阻塞 | Conflict/Decision ID、状态、Owner 和裁决 |
| [追踪矩阵](traceability-matrix.md) | 用户价值如何追到合同和证据 | Capability→Journey→Page→Object→Contract→Code→Scenario |
| [文档自动校验](docs-verification.md) | 哪些漂移会让 CI 失败 | 受控范围、链接、状态、Registry 和历史标记检查 |

不再维护逐文件登记或阶段工作包；普通文档导航由[项目门户](../README.md)承担，文件历史与审批 provenance 由 Git 和 PR 承担。真实发布所需字段、证据与学习回写要求统一在[分析、测试与发布证据](../frontend/12-analytics-testing-and-release-evidence.md)维护。

## 2. 唯一事实规则

- Registry 只存索引和关系，不复制完整产品论证、实现细节或测试内容。
- `docs/frontend/` 只消费这些 ID，不得另建能力、对象或状态清单。
- 未指派的 SaaS、前端、设计、数据、QA、运营和安全责任继续显示为 `UNASSIGNED`，不得用 Codex 或模糊“团队”代填。
- 阶段审批结论必须收口到当前 Registry/规范；审批过程、作者 dry-run 和临时报告默认留在 PR。
- 删除或替代承重文档前，必须先确认唯一事实已被当前 Owner 承接，并取得用户授权。

## 3. 变更顺序

```text
发现新事实或冲突
→ 定位主题 Owner
→ 更新承重事实或作出 Decision/ADR
→ 更新对应 Registry
→ 更新读者视图
→ 补场景、证据和真实发布记录
```

只能完成部分链路时，状态保持 `PROPOSED / OPEN_CONFLICT / UNKNOWN`，不能从草稿直接跳成 `CURRENT` 或 `AS_BUILT`。

## 4. 当前边界

- `DEC-FE-P4-001..011`、`DEC-FE-P5-001..010`、`DEC-FE-P6-001..012`、`DEC-FE-P7-001..012` 和仍适用的 `DEC-FE-P8-*` 结论保留在[冲突登记](conflict-register.md)。
- [独立站管理 Capability Pack](../frontend/modules/independent-site-management/README.md)是当前唯一详细产品域包。
- 其他非 Site 域只在[能力登记](capability-register.md)和[页面目录](../frontend/04-page-and-capability-catalog.md)保留地图级覆盖，仍为 `MAP_COMPLETE / NOT_DEV_READY`。
- [OSS / 外部能力注册表](../backend/oss-registry.md)保留 31 项当前决定，但不等于依赖、部署或生产许可。
- `BLK-FE-001..007`、`GAP-FE-P6-001..012`、全部 OSS 准入门、独立人工验收和首个真实 Release 前置门继续有效。
