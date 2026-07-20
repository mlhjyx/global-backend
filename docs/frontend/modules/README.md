# 全 SaaS 产品域 Capability Pack 入口

> 文档 ID：`FE-MODULES-000`
> 层级：`L2 / Product capability index`
> 生命周期：`CURRENT`
> 评审状态：`APPROVED_AT_GATE_6`
> 事实 Owner：`OWN-PRODUCT`
> 工程核验基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`

本目录把完整 SaaS 产品地图转换为按用户结果组织的能力工作簿。它回答“每个产品域为什么存在、用户从哪里进入、对象如何流转、失败后怎么办、当前究竟做到哪一轴”，不把页面原型、后端 API 或历史 Word 单独冒充为可交付产品。

## 1. 完整产品域入口

| 产品区域 / 横切域 | Capability Pack | Page family | 当前深度 | 施工含义 |
|---|---|---|---|---|
| Workspace Shell 与今日 | [workspace-shell-and-today](workspace-shell-and-today/README.md) | `PAGE-FE-001..010` | `MAP_COMPLETE / NOT_DEV_READY` | 全部纵切的基础；合同和正式前端仍受阻 |
| 企业、产品与信任 | [enterprise-trust-and-knowledge](enterprise-trust-and-knowledge/README.md) | `PAGE-FE-020..026` | `MAP_COMPLETE / PARTIAL_BACKEND` | Company/Claim/Evidence 等共享事实底座，不是 Site 私有数据 |
| 独立站管理 | [independent-site-management](independent-site-management/README.md) | `PAGE-FE-030..057` | 当前纵切 `SPEC_READY_WITH_BLOCKERS`；后置链 `TARGET_NOT_RUNNABLE` | Gate 5 已批准；仍不授权实现 |
| 市场与客户开发 | [buyer-development](buyer-development/README.md) | `PAGE-FE-060..066` | `FROZEN_MAP_ONLY / BACKEND_VERIFIED` | 保留完整用户闭环；不恢复新增施工 |
| 增长执行 | [growth-execution](growth-execution/README.md) | `PAGE-FE-070..079` | `MAP_COMPLETE / TARGET_EXTERNAL` | 归 SaaS；正式 SoR、合同和实现未定位 |
| 互动与商机 | [engagement-and-opportunity](engagement-and-opportunity/README.md) | `PAGE-FE-080..083` | `MAP_COMPLETE / TARGET_EXTERNAL` | 归 SaaS；本仓边界止于合格线索包 |
| 洞察与学习 | [insights-and-learning](insights-and-learning/README.md) | `PAGE-FE-084..086` | `MAP_COMPLETE / TARGET_EXTERNAL` | 聚合读模型不取得业务对象 ownership |
| 团队、集成、设置与运营 | [team-integrations-settings-and-operations](team-integrations-settings-and-operations/README.md) | `PAGE-FE-090..096` | `MAP_COMPLETE / TARGET_EXTERNAL` | 控制面与平台运营分层；旧 Spring/Admin 只作冲突原型 |

页面、Capability 与 Object 的稳定 ID 仍分别由[页面目录](../04-page-and-capability-catalog.md)、[能力登记](../../governance/capability-register.md)和[对象登记](../../governance/core-object-register.md)承重。本目录不复制这些 Registry 的所有字段。

## 2. 统一写法

每个 Pack 都使用同一顺序：

```text
用户与结果
→ 当前/目标/冻结边界
→ 核心旅程与页面
→ 对象、SoR 与社会属性
→ 状态、权限和人工兜底
→ 合同/代码/原型证据
→ 指标与反指标
→ 已知限制、开放输入和下一 Gate
```

这吸收了 GoodJob“把功能讲成完整用户闭环”的优点，同时增加稳定 ID、Owner、多轴状态、证据和替代关系，避免把竞品页面、Word 功能清单或 Mock 状态变成内部承诺。

## 3. 组合阅读路线

- 产品负责人：本页 → [Phase 6 覆盖与优先级](../../roadmap/saas-frontend-phase-6/portfolio-coverage-and-priority.md) → 各 Pack 的范围/非目标/开放输入。
- 设计：对应 Pack 的 Journey/Page/状态 → [全局前端规范](../README.md) → [设计资产治理](../../design/README.md)。
- 前端/后端：对应 Pack 的对象/合同边界 → [跨域接缝](../../roadmap/saas-frontend-phase-6/cross-domain-handoffs-and-gaps.md) → OpenAPI/事件/SoR 真值。
- QA/运营：Pack 的失败恢复/指标 → [场景目录](../../governance/scenario-catalog.md)；`CATALOG_ONLY` 不能当已执行测试。
- 新成员：先读[项目文档门户](../../README.md)，再读本页；不要从 Word、Mock 路由或代码目录反推当前产品状态。

## 4. Phase 6 完成与未完成的边界

Phase 6 的“完整”只指：六项一级 IA、企业事实横切域和管理控制面均有正式归属、用户结果、Page family、对象、接缝、当前状态、恢复原则和开放输入，不再有失踪能力。

它不表示：

- 非 Site 模块已经达到页面级 Dev-Ready；
- 正式 SaaS 前端仓库、设计源、Workspace/权限合同或实际 Owner 已出现；
- Campaign、Publish、Conversation、Opportunity、Attribution、Billing 已有 SoR/API；
- 冻结的客户开发恢复施工；
- Phase 7 的 OSS 候选已经采用；
- 任一模块已有真实用户、E2E、部署或 Release Bundle。
