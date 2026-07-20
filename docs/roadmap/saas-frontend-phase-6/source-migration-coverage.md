# 历史 Word、原型、竞品与代码来源迁移覆盖

> 文档 ID：`BASE-FE-P6-003`
> 状态：`FROZEN_EVIDENCE / APPROVED_AT_GATE_6`
> Owner：`OWN-DOC-GOV`
> 原则：迁移表示“内容有正式去向”，不表示原文件被采用、替代、移动或删除

## 1. 五份 Word 的产品内容去向

| Source | 主要内容 | 已迁入当前体系 | 仍保留去向/限制 |
|---|---|---|---|
| `SRC-WORD-001` v3 总体 PRD | 用户/JTBD、页面、状态、权限、运营、跨域功能 | Gate 2 全产品地图、Gate 4 全局规范、Gate 5 Site、Phase 6 七个非 Site Pack | OSS/技术选型进 Phase 7；历史范围/导航不复活 |
| `SRC-WORD-002` v3 总纲/手册 | 产品叙事、角色、工作方式、能力使用说明 | 各 Pack 的 Capability/用户/完成定义/FAQ/限制；产品组合图 | 正式 Tutorial/How-to/运营 Guide 需真实 UI/Owner 后补 |
| `SRC-WORD-003` v2 母本 | 早期对象、场景、路线与技术设想 | 只保留历史对象/场景 provenance | `SUPERSEDED`；旧 SAO 北极星、Agent/导航/技术不恢复 |
| `SRC-WORD-004` 顶层架构 v1 | SaaS/能力服务/数据/外部集成分层 | Phase 6 的 SoR、控制面、跨域 Handoff 和部署/Owner 缺口 | Next.js、同仓/同库和具体组件仅方案输入；不覆盖 current architecture |
| `SRC-WORD-005` 文档治理 v1 | Registry、RACI、Gate、DoR/DoD、追踪、OSS Card | Phase 0–6 计划、Registry、Gate 和证据方法 | 自动 lint/banner/archive/Release Bundle 留 Phase 8 |

结论：Word 中完整产品能力已不再只有“未来迁移”占位；Site 由 Phase 5 承接，其余产品域由 Phase 6 承接。Word 的 OSS 清单、具体技术/架构和历史路线仍按权威层级留给 Phase 7 或历史证据，不直接成为当前实现方案。

## 2. 本地 SaaS 原型逐域去向

| 原型路由/来源 | 正式产品归属 | 可学习 | 不可继承 |
|---|---|---|---|
| Layout/Sidebar/TopBar、`/dashboard`、`/anomaly` | Shell/Today Pack | 信息密度、快捷入口、异常/任务/机会场景 | 旧导航层级、Mock 数字、硬编码通知、无 Workspace 权限 |
| `/knowledge`、`/competitors` | Enterprise/Buyer Packs | 信息结构和问题清单 | 数据、完整度、推荐和采集合法性声明 |
| `/accounts` | Buyer Pack | 列表/详情/解释维度参考 | 未接真实 Buyer API 的状态和字段 |
| `/campaigns`、`/content`、`/publish` | Growth Pack | Canvas、资源、内容/日历/回执场景 | Campaign SoR、渠道连接、预算、自动发布和指标 |
| `/engagement`、`/opportunities` | Engagement/Opportunity Pack | Inbox/详情/看板任务结构 | 渠道、Conversation、QGO/SAO/Outcome 状态真值 |
| `/insights` | Insights Pack | 图表类型和下钻问题 | Mock KPI、Attribution 和 AI 建议 |
| `/team`、`/integrations`、`/settings` | Control-plane Pack | 管理任务和信息分组 | 单角色、旧 API、OAuth/vault/entitlement/审计完成声明 |
| `/global/frontend/admin-frontend`、`backend` | Control-plane source audit | 管理用例与冲突清单 | 正式 identity/admin SoR、秘密和安全基线 |

正式 repo 决定后仍须逐页面/组件作 `Learn / Adapt / Discard`；Phase 6 不复制代码、资产或路由。

## 3. GoodJob 方法迁移

| 值得学习的方法 | Phase 6 落点 | 我们增加的治理 |
|---|---|---|
| 用户问题→入口→页面→API/权限→实施→验收/FAQ | 每个 Capability Pack 的固定结构 | stable ID、Owner、多轴状态、证据、Gate |
| 数据的团队/个人社会属性 | Enterprise、Shell、Control、Engagement 权限章节 | Workspace/RLS/用途/个人数据/审计分层 |
| 结果页必须有下一动作 | 跨域 `HOF-FE-*` 接缝 | canonical object、快照、事件、ACK/授权状态分离 |
| 设计/实现/使用/FAQ 面向不同读者 | Pack + 全局规范 + Scenario/Guide 路线 | 单一事实 Owner，避免重复正文 |
| 方案取舍和人工兜底 | 各 Pack 的非目标、恢复和 Handoff | blocker/gap/Decision 和安全默认 |

没有迁入：GoodJob 的平铺文档、无证据“全绿”、自评审核、设计/实现矛盾和功能抄单。竞品功能不改变我们的边界或优先级。

## 4. 本地代码/合同真值去向

| 代码面 | 能证明 | 对应 Pack | 不能证明 |
|---|---|---|---|
| `apps/api/src/company`、`claim`、Site profile/asset/KB | 企业事实、Claim 和 Site 子集合同/实现 | Enterprise + Site | 全平台统一 UX/allowed actions/影响闭环 |
| `apps/api/src/icp/discovery/lead/signals/intent/compliance/events` | Buyer 后端与交付链 | Buyer | SaaS 前端、Opportunity consumer、恢复施工 |
| `apps/api/src/site-builder`、Temporal、renderer、contracts | Site 当前纵切与内部 Release/preview 地基 | Site | 正式 SaaS UI、公网 Publish/Domain/Inquiry |
| `/global/frontend/project-12080666` | 广泛页面/交互原型 | 全部 Pack 的参考列 | 正式 repo、真实数据、测试、部署 |
| `/global/frontend/backend`、admin | 旧 identity/admin 来源 | Control Pack 的冲突证据 | 目标 SaaS identity、权限和安全基线 |
| Word/研究/OSS 索引 | 目标问题、候选方案与 provenance | Phase 6/7 | 当前 as-built 或采用结论 |

## 5. 覆盖仍未完成的内容

- OSS/外部能力的 License、版本、安全、Adapter、测试、Owner 和 Exit Plan：Phase 7。
- 正式用户/管理员/运营 Tutorial/How-to：等待真实 UI、Owner 和可执行场景，不在地图阶段伪写操作步骤。
- 历史文件 banner/archive、自动链接/状态/证据检查、Release Bundle 模板和阅读路线测试：Phase 8。
- 实际前端、设计系统、Fixture、E2E、部署和发布：需单独实现授权，不属于 Phase 6–8 文档授权的自动结果。
