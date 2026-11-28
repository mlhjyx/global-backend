# 项目文档门户

> 文档 ID：`PORTAL-FE-001`
> 层级：`L1 / Navigation`
> 状态：`CURRENT`
> 维护 Owner：`OWN-DOC-GOV`
> 最后核验：2026-11-28（以 `backend@a5ef77f6` 与 `gain-saas@ff45fa4` 核对产品总设计、现役 SaaS 与 ADR 入口可达性）。

这是后端仓库的文档导航。按下面的入口定位工作；实际实现、运行采用和验收记录见[当前状态](status/current.md)。整个产品的目标模块与对象关系见[Global 产品总设计](product.md)。现役租户应用的页面、钱包源码与运行读回由 [gain-saas 文档入口](https://github.com/mlhjyx/gain-saas/blob/main/docs/README.md)、[gain-saas 现役产品说明](https://github.com/mlhjyx/gain-saas/blob/main/apps/web/PRODUCT.md) 与 [gain-saas 当前状态](https://github.com/mlhjyx/gain-saas/blob/main/docs/status/current.md) 维护。

## 1. 先读五份当前真值

按顺序阅读：

1. [产品边界](product-scope.md)：本仓做什么、不做什么，SaaS 与本仓如何分工。
2. [当前状态](status/current.md)：当前真正合入了什么、主线和已知限制。
3. [as-built 架构](architecture/current.md)：代码和运行结构的当前事实。
4. [ADR 注册表](adr/registry.md)：仍然生效的承重决策。
5. [发布路线](status/release-plan.md)：下一施工顺序。

需要从全产品视角理解九个模块目标分工、核心业务对象和待决产品问题时，查阅[Global 产品总设计](product.md)（目标设计入口，不替代上述五份当前权威真值与实现/验收状态）。

任何“已完成、已接入、已发布、生产可用”声明都必须回到上述事实源、机器合同和相应证据核验。旧 Word、研究稿、原型、历史分支或外部项目不能升级当前状态。

### 1.1 历史与冻结文档的定位（2026-11-02 标注；2026-11-28 补充现役边界）

- [`archive/research/platform-top-level-design-v1.md`](archive/research/platform-top-level-design-v1.md)：**SUPERSEDED**——顶层设计 v1，已被 [产品边界](product-scope.md) + [as-built 架构](architecture/current.md) + [ADR 注册表](adr/registry.md) 取代，其中「QGO 归本仓」等表述已被 ADR-001 改判，已归档，不得再当现行设计引用。
- `docs/frontend/` 系列（19 份）：**目标规范 / 设计基线（`ACTIVE_INPUT`），不是 as-built**；现役 SaaS 前端位于 [gain-saas](https://github.com/mlhjyx/gain-saas/blob/main/apps/web/PRODUCT.md)（`apps/web`，Vue 3 / Vben 5 / Ant Design Vue），原 GrowthOS 已于 2026-10-31 退役，未来框架选择（如 Next.js/React）仍按[冲突登记](governance/conflict-register.md) `CON-FE-006` 待定。
- `docs/site-builder/` 保留独立站任务合同与历史设计；先读 [源码与运行边界](architecture/current.md#运行模式与开关)，再判断本次任务适用的章节（现役 SaaS 租户端无建站入口，正式冻结待 `PRD4-D1`）。
- `docs/archive/`：只读历史，正文不改写，链接问题按历史结构告警处理。

## 2. 模块设计文档（docs/modules/）

按 [文档目录与维护规则](documentation-rules.md) 建立的模块产品与技术方案，承接[Global 产品总设计](product.md)；当前为 `DRAFT`，实现状态见 [实现状态矩阵](status/implementation-matrix.md)。

| 模块 | 产品说明 | 技术方案 |
| --- | --- | --- |
| 账户与工作空间 | [product](modules/account-workspace/product.md) | [technical](modules/account-workspace/technical.md) |
| 卖家知识中心 | [product](modules/seller-knowledge/product.md) | [technical](modules/seller-knowledge/technical.md) |
| 买家知识网络 | [product](modules/buyer-knowledge/product.md) | [technical](modules/buyer-knowledge/technical.md) |
| 买家发现与资格判断 | [product](modules/discovery-qualification/product.md) | [technical](modules/discovery-qualification/technical.md) |
| AI 基础能力 | [product](modules/ai-foundation/product.md) | [technical](modules/ai-foundation/technical.md) |
| 独立站建设 | [product](modules/site-builder/product.md) | [technical](modules/site-builder/technical.md) |

开发与实施流程见 [development-process.md](shared/development-process.md)。

## 3. 按任务下钻

| 任务 | 入口 | 说明 |
|---|---|---|
| 理解整个产品的目标与九模块分工 | [Global 产品总设计](product.md) | 九模块目标、核心对象归属与待决项；不替代仓边界与实现状态 |
| 了解现役 SaaS 产品、路由与运行现状 | [gain-saas 现役产品说明](https://github.com/mlhjyx/gain-saas/blob/main/apps/web/PRODUCT.md) · [gain-saas 当前状态](https://github.com/mlhjyx/gain-saas/blob/main/docs/status/current.md) | 现役 Vue 3 / Vben 5 / Ant Design Vue 租户产品、现役 QGO、触达与钱包源码（代码默认关闭，实际开关与商业采用待定） |
| 理解整个 SaaS 前端目标 | [统一 SaaS 前端规范](frontend/README.md) | IA、旅程、权限、状态、AI、设计、合同与质量目标；不是前端 as-built |
| 设计/开发独立站管理 | [Capability Pack](frontend/modules/independent-site-management/README.md) | 当前唯一达到详细规格深度的 SaaS 产品域 |
| 实现 Site Builder 后端 | [Site Builder 决策入口](site-builder/00-decisions-and-coordination.md) | PRD、架构、SiteSpec、API、测试与施工顺序 |
| 查询稳定 ID、状态与责任 | [治理入口](governance/README.md) | Capability、Object、Scenario、Conflict 与追踪关系 |
| 查代码位置 | [代码地图](governance/code-map.md) | 能力 → API 入口 → 关键代码 → 测试锚点 |
| 查询 Provider 当前合同 | [生成 Provider Registry](backend/provider-registry.md) | key、SourceClass、许可、个人数据、默认 enablement、调用门与测试；不代表 runtime 健康 |
| 查询 OSS/外部能力决定 | [OSS / 外部能力注册表](backend/oss-registry.md) | 32 项采用决定、许可边界、Adapter/SoR、Owner 与退出门 |
| 运行和维护开发环境 | [后端运行文档](backend/compose-project-migration.md) | Compose 迁移、Worktree、CI 及现役后端专题 |
| 用自然语言需求与 AI 代理协作开发 | [AI 辅助开发协作入口](ai-development/README.md) | 运行模式、需求验收、升级规则与记忆/检索边界（开发主体为 Claude Code，Codex 仅受派） |
| 核验文档一致性 | [文档自动校验](governance/docs-verification.md) | 运行 `pnpm docs:verify`，涉及跨仓入口时可按需运行只读漂移检查 |
| 改获客主链（发现 / 评分 / 联系人） | [AGENTS.md](../AGENTS.md) → [当前状态](status/current.md) → [模块技术方案](modules/discovery-qualification/technical.md) | 先读 no-go 与不变量；入口、文件与测试锚点见[代码地图](governance/code-map.md) |
| 做验收、交付或回填 | [当前状态](status/current.md) → [待验证台账](status/pending-verification.md) → [证据索引](evidence/README.md) | 四态、RuntimeEvidence 与 Release Bundle 口径，不把「跑通」当「验收」 |
| 查「为什么这样决定」 | [ADR registry](adr/registry.md) → [冲突与开放决策登记](governance/conflict-register.md) | 决策与冲突分开，不按更新时间判断 |
| 平台调度或 Temporal 迁移 | [平台授权模式](runbooks/platform-authority-internal-db-and-slimming.md) · [客户 Temporal](backend/postgres-temporal-customer-migration.md) | 切换前核对运行模式、队列与回退材料 |
| 日常运维与排障 | 工作区 `local-config/RUNBOOK.md` → [后端专题](backend/) | 按 RUNBOOK 顺序，不裸跑 `docker compose` |

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

正式 SaaS 前端位于 **gain-saas 仓库**（`apps/web`，Vue 3 / Vben 5 / Ant Design Vue SPA；2026-10-31 P8 起与 SaaS 身份/平台权威同仓，取代已退役的 GrowthOS），其运行状态与设计事实以 [gain-saas 文档入口](https://github.com/mlhjyx/gain-saas/blob/main/docs/README.md) 与 [gain-saas 现役产品说明](https://github.com/mlhjyx/gain-saas/blob/main/apps/web/PRODUCT.md) 为准。本目录的 `docs/frontend/` 仍是目标规范与设计基线，不是 as-built；本地 Mock、截图和导出代码不能证明正式前端已实现。

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
- [AI 可观测性开发 profile](backend/ai-observability.md)
- [响应式、a11y 与性能](frontend/10-responsive-accessibility-and-performance.md)
- [分析、测试与发布证据](frontend/12-analytics-testing-and-release-evidence.md)
- [状态、错误、降级与恢复](frontend/07-state-error-degradation-and-recovery.md)
- [独立站管理运营与验收](frontend/modules/independent-site-management/operations-and-acceptance.md)

## 4. 当前产品深度

实现与验证从[实现状态](status/implementation-matrix.md)进入，发布门和下一步看[路线](status/release-plan.md)，稳定 ID 与产品承诺见[能力登记](governance/capability-register.md)。

## 5. 文档分层与生命周期

| 层级 | 用途 | 主要位置 |
|---|---|---|
| Authority | 当前边界、架构、决策、状态和路线 | `product-scope.md`、`architecture/`、`adr/`、`status/`、`status/release-plan.md` |
| Normative / Registry | 当前目标规则、稳定 ID、责任和关系 | `product.md`、`frontend/`、`governance/`、`backend/oss-registry.md` |
| Capability / Guide | 完成具体产品或运行任务 | `frontend/modules/independent-site-management/`、`site-builder/`、`backend/`、`ai-development/` |
| Evidence / Record | 实现、测试、模型和专题实施证明 | `evidence/`、`implementation-records/`、`roadmap/changelog.md` |
| Research / Historical input | 研究、旧 Word 和 dated proposal | `research/`、`platform/`、明确标记的 Site Builder 历史稿 |

历史输入只能被当前文档引用，不能反向覆盖当前真值。Phase 1–8 工作包已在 2026-07-23 授权的文档瘦身中退出工作树；它们的审计 provenance 仍可由 Git 历史与已关闭的 PR #158 恢复，不再占用日常阅读面。

角色→路径→Owner→机器校验的完整对照见 [文档目录与维护规则](documentation-rules.md) 第 8 节。

## 6. 当前承诺与阻塞

独立站管理当前优先纵切为：

```text
资料与信任
→ Build / 取消 / 失败恢复
→ active READY Release 支撑的可信开发预览
```

当前不承诺公网发布、域名/SSL、用户可操作回滚、询盘、站点分析、诊断、任意语言、任意风格或生产就绪。`BLK-FE-001..007`、`GAP-FE-P6-001..012`、OSS 准入门、独立人工验收和首个真实 Release 前置门继续有效，统一在[冲突登记](governance/conflict-register.md)、[能力登记](governance/capability-register.md)和[发布证据规范](frontend/12-analytics-testing-and-release-evidence.md)中维护。

## 7. 维护规则

1. 先修改主题事实源，再更新 Registry、读者视图和证据；不得在多个文档复制同一真值。
2. 一个新文件必须有明确读者、任务、Owner、状态和不可替代性；阶段过程默认留在 PR，不再生成常驻工作包。
3. 历史输入保留醒目标记；新的替代文档建立后，应在同一变更中处理旧入口和链接。
4. 用户发布必须留下真实证据；模板、Mock、截图或空目录不能算 Release。
5. 所有受控文档变更运行 `pnpm docs:verify`。
