# 项目文档门户

> 文档 ID：`PORTAL-FE-001`
> 层级：`L1 / Navigation`
> 状态：`CURRENT`
> 维护 Owner：`OWN-DOC-GOV`
> 最后核验：2026-07-23，`origin/main@76b8c243e7d7b78b25d8f82956667f3133f9286d`

这是 `/global/backend` 的唯一人类文档入口。项目是统一的出海企业 AI 全球客户开发与增长执行 SaaS；本仓当前开发主线是 Site Builder 后端能力。独立站管理属于 SaaS 的一级产品区域，Astro 公开站是它管理的版本化输出，不是另一套 SaaS 前端。

## 1. 先读五份当前真值

按顺序阅读：

1. [产品边界](product-scope.md)：本仓做什么、不做什么，SaaS 与本仓如何分工。
2. [当前状态](status/current.md)：当前真正合入了什么、主线和已知限制。
3. [as-built 架构](architecture/current.md)：代码和运行结构的当前事实。
4. [ADR 注册表](adr/registry.md)：仍然生效的承重决策。
5. [发布路线](roadmap/release-plan.md)：下一施工顺序。

任何“已完成、已接入、已发布、生产可用”声明都必须回到上述事实源、机器合同和相应证据核验。旧 Word、研究稿、原型、历史分支或外部项目不能升级当前状态。

## 2. 按任务下钻

| 任务 | 入口 | 说明 |
|---|---|---|
| 理解整个 SaaS 前端目标 | [统一 SaaS 前端规范](frontend/README.md) | IA、旅程、权限、状态、AI、设计、合同与质量目标；不是前端 as-built |
| 设计/开发独立站管理 | [Capability Pack](frontend/modules/independent-site-management/README.md) | 当前唯一达到详细规格深度的 SaaS 产品域 |
| 实现 Site Builder 后端 | [Site Builder 决策入口](site-builder/00-decisions-and-coordination.md) | PRD、架构、SiteSpec、API、测试与施工顺序 |
| 查询稳定 ID、状态与责任 | [治理入口](governance/README.md) | Capability、Object、Scenario、Conflict 与追踪关系 |
| 查询 OSS/外部能力决定 | [OSS / 外部能力注册表](backend/oss-registry.md) | 31 项采用决定、许可边界、Adapter/SoR、Owner 与退出门 |
| 运行和维护开发环境 | [后端运行文档](backend/compose-project-migration.md) | Compose 迁移、Worktree、CI 及现役后端专题 |
| 核验文档一致性 | [文档自动校验](governance/docs-verification.md) | 运行 `pnpm docs:verify` |

### 产品、设计与前端交接

建议顺序：

1. [统一 SaaS 前端规范](frontend/README.md)
2. [页面与能力目录](frontend/04-page-and-capability-catalog.md)
3. [设计系统与内容规范](frontend/09-design-system-and-content-guidelines.md)
4. [术语与状态](governance/terminology-and-status.md)
5. [前端合同与接入规则](frontend/11-frontend-contracts-and-integration.md)
6. [独立站管理旅程与页面](frontend/modules/independent-site-management/journeys-and-page-spec.md)
7. [独立站管理线框](design/independent-site-management-wireframes.md)
8. [独立站管理实施蓝图](frontend/implementation/independent-site-management-blueprint.md)

正式 SaaS 前端仓库、设计事实源、设计 Token、运行环境和实际 Owner 仍未确定；本地 Mock、截图和导出代码不能证明正式前端已实现。

### Site Builder 后端与契约

- [PRD](site-builder/01-prd.md)
- [架构](site-builder/02-architecture.md)
- [SiteSpec 契约](site-builder/04-sitespec-contract.md)
- [API 合同说明](site-builder/07-api-contract-draft.md)
- [评测与测试](site-builder/08-eval-testing.md)
- [M1 实施设计](site-builder/09-m1-implementation-design.md)
- [R1-min handoff](site-builder/handoffs/r1-min-execution-brief.md)

### QA、运营与恢复

- [场景目录](governance/scenario-catalog.md)
- [追踪矩阵](governance/traceability-matrix.md)
- [响应式、a11y 与性能](frontend/10-responsive-accessibility-and-performance.md)
- [分析、测试与发布证据](frontend/12-analytics-testing-and-release-evidence.md)
- [状态、错误、降级与恢复](frontend/07-state-error-degradation-and-recovery.md)
- [独立站管理运营与验收](frontend/modules/independent-site-management/operations-and-acceptance.md)

## 3. 当前产品深度

| 区域 | 当前深度 | 不应误读为 |
|---|---|---|
| 今日与公共 Shell | 目标产品地图 | 正式 SaaS 前端已存在 |
| 客户开发 | 后端存量维护；新增开发冻结 | 本仓负责 Campaign、触达或商机 |
| 独立站管理 | 当前主线；详细规格和后端纵切最深 | 公网发布、域名、回滚或生产就绪 |
| 增长执行 | 地图级目标 | 已有 SoR、合同或页面 |
| 互动与商机 | 地图级目标 | 本仓负责 Conversation/Opportunity |
| 洞察 | 目标读模型；Site 有局部成本事实 | Mock 图表是指标真值 |

多轴状态只在 [能力登记](governance/capability-register.md)维护。

## 4. 文档分层与生命周期

| 层级 | 用途 | 主要位置 |
|---|---|---|
| Authority | 当前边界、架构、决策、状态和路线 | `product-scope.md`、`architecture/`、`adr/`、`status/`、`roadmap/release-plan.md` |
| Normative / Registry | 当前目标规则、稳定 ID、责任和关系 | `frontend/`、`governance/`、`backend/oss-registry.md` |
| Capability / Guide | 完成具体产品或运行任务 | `frontend/modules/independent-site-management/`、`site-builder/`、`backend/` |
| Evidence / Record | 实现、测试、模型和专题实施证明 | `evidence/`、`implementation-records/`、`roadmap/changelog.md` |
| Research / Historical input | 研究、旧 Word 和 dated proposal | `research/`、`platform/`、明确标记的 Site Builder 历史稿 |

历史输入只能被当前文档引用，不能反向覆盖当前真值。Phase 1–8 工作包已在 2026-07-23 授权的文档瘦身中退出工作树；它们的审计 provenance 仍可由 Git 历史与已关闭的 PR #158 恢复，不再占用日常阅读面。

## 5. 当前承诺与阻塞

独立站管理当前优先纵切为：

```text
资料与信任
→ Build / 取消 / 失败恢复
→ active READY Release 支撑的可信开发预览
```

当前不承诺公网发布、域名/SSL、用户可操作回滚、询盘、站点分析、诊断、任意语言、任意风格或生产就绪。`BLK-FE-001..007`、`GAP-FE-P6-001..012`、OSS 准入门、独立人工验收和首个真实 Release 前置门继续有效，统一在[冲突登记](governance/conflict-register.md)、[能力登记](governance/capability-register.md)和[发布证据规范](frontend/12-analytics-testing-and-release-evidence.md)中维护。

## 6. 维护规则

1. 先修改主题事实源，再更新 Registry、读者视图和证据；不得在多个文档复制同一真值。
2. 一个新文件必须有明确读者、任务、Owner、状态和不可替代性；阶段过程默认留在 PR，不再生成常驻工作包。
3. 历史输入保留醒目标记；新的替代文档建立后，应在同一变更中处理旧入口和链接。
4. 用户发布必须留下真实证据；模板、Mock、截图或空目录不能算 Release。
5. 所有受控文档变更运行 `pnpm docs:verify`。
