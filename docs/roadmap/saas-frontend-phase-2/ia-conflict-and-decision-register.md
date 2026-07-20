# IA 冲突与决策登记

> 文档 ID：`BASE-FE-P2-007`
> 状态：`READY_FOR_GATE_2_REVIEW`
> 事实基线：`origin/main@676c6cdc175326927ec341a2d585168aa0a1a374`
> 规则：冲突不静默综合；推荐不等于批准

## 1. Phase 2 冲突

| Conflict ID | 主题 | 来源/现状 A | 来源/现状 B | 用户/工程影响 | 本包推荐 | 是否需拍板 |
|---|---|---|---|---|---|---|
| `CON-FE-P2-001` | 一级导航数量与命名 | Word：今日/研究/战役/内容/互动/增长 | 原型：7 primary + 6 secondary；`product-scope` 附录另有 M0-M1 四项 | 入口漂移、页面归属不清、无法定义权限/深链 | 采用六项混合 IA：今日/客户开发/独立站管理/增长执行/互动与商机/洞察 | 是，Gate 2 |
| `CON-FE-P2-002` | 独立站管理层级 | 产品负责人和 Site PRD：一级区域 | 原型 Sidebar 把它放 secondary | 当前主线被降为工具；用户无法形成持续管理心智 | 保持一级；公开站是输出 | 已固定，确认回写 |
| `CON-FE-P2-003` | 独立站内部结构 | 原型单页 8 个同级 Tab | 实际能力分为 Profile/Asset/KB/Claim/Build/Version/Release/Publish 等不同对象和成熟度 | Mock 和真能力混写，状态/权限无法扩展 | 按概览、资料与信任、设计与内容、生成任务、版本与发布、询盘与表现、设置分区 | 是，Gate 2 |
| `CON-FE-P2-004` | 企业知识入口 | Word/原型把企业知识作为次级独立菜单 | Claim/Evidence/Asset 是 Site/Content/Campaign 共用事实底座 | 独立菜单容易复制业务字段和事实 | 建立 canonical 企业事实入口，同时在 Workspace 和对象上下文深链 | 是，Gate 2 |
| `CON-FE-P2-005` | Site 首次承诺终点 | PRD/原型写“15 分钟可发布”“发布/域名/回滚” | 当前 OpenAPI 没有 release/publish/domain/rollback；仅内部 R1-min Release/preview | 错误销售承诺和无法验收的前端 | 首个纵切止于可信开发预览；公开发布另立能力 Gate | 是，Gate 2 |
| `CON-FE-P2-006` | SiteRelease 是否等于发布 | `main` 已有 immutable SiteRelease 和 active preview pointer | 无公共 Release 管理、PublishReview、域名或生产部署证据 | 工程地基可能被 UI/文案冒充用户发布能力 | 分开 Build/Version/Release/Preview/Publish/Domain 五层 | 需确认术语 |
| `CON-FE-P2-007` | Site 状态 | Prisma 注释 `draft/building/ready/published` | DTO 另声明 `setup_failed`；Build/Release 还有独立状态 | 一个 badge 无法表达旧版在线+新 Build 失败等状态 | 四层状态分离；具体状态词典 Phase 4/5 truth-sync | 是，原则 Gate 2 |
| `CON-FE-P2-008` | 风格和语言承诺 | 原型展示四种风格和更宽泛语言能力 | OpenAPI 只允许两 style、`en/de-DE`；`ar` 只是 renderer smoke | 用户选项会 422 或产出残缺 | UI 只消费服务端 capability manifest；目标选项不混进当前选择器 | 是，承诺范围 |
| `CON-FE-P2-009` | Claim 审批位置 | Claim/Evidence/bridge/snapshot 已深入实现 | Site OpenAPI 无完整 Claim 审核入口；原型缺事实门 | Build 可有可信事实地基，但用户无法完成批准任务 | 首个纵切保留 Claim Gate；合同未落时显式阻塞/运营兜底，不自动批准 | 是，Gate 2 |
| `CON-FE-P2-010` | 首批目标用户 | Word 同时列制造、SaaS、服务商、代理商 | 当前 Site 和买家智能事实更贴近制造/工贸企业 | IA 若面向所有人会变成通用工具箱 | B2B 制造/工贸/传统出口为 primary；其他只保留扩展 | 是，Gate 2 |
| `CON-FE-P2-011` | 日常主操作者 | Word 有老板、增长、市场、销售、数据、审核、专家、管理员、代理商 | 无一手研究证明谁最高频 | 首页和导航不能按每个 persona 同时优化 | 以海外增长/外贸运营为默认，按责任帽子协作；用户研究验证 | 是，Gate 2 |
| `CON-FE-P2-012` | Today 的 ownership | 原型把各种 Mock 卡放 Dashboard | Today 应聚合 Task/Approval/Incident/Opportunity 读模型 | 容易变成不可解释的推荐广告页 | Today 不拥有对象，所有卡深链到 canonical object | 是，原则 Gate 2 |
| `CON-FE-P2-013` | 全局 AI 的角色 | 原型有常驻 AI Panel | 权威原则要求结构化对象、证据、Approval 和有界任务 | Chat 可能绕过对象/权限/审计 | AI 用于表达、解释和草拟；结构化对象才是结果 | 是，Gate 2 |
| `CON-FE-P2-014` | Workspace 权限 | 后端有 workspace RLS | SaaS 无统一 Role/Object/Data Scope 合同 | 看得见不等于有权；无法验收审批、发布、导出 | 服务端授权 + 对象社会属性；前端不自建角色表 | 需 Owner，Gate 2/4 |
| `CON-FE-P2-015` | 管理员可见性 | 原型/Word 偏简单 RBAC | 企业中个人草稿/待办/具名联系人有不同社会属性 | 可能破坏组织信任或隐私 | 管理员不默认无限读个人工作数据；例外需政策和审计 | 是，Gate 4 原则可先批 |
| `CON-FE-P2-016` | Buyer Intelligence 可见性 | 后端能力真实但冻结 | 完整 SaaS 必须保留客户开发产品面 | 隐藏会让产品地图失真，点亮又像恢复施工 | 完整 IA 保留；当前租户入口由 capability/entitlement 决定 | 是，Gate 2 |
| `CON-FE-P2-017` | Campaign/Conversation/Opportunity SoR | 权威边界明确归 SaaS | 本地 Spring/React 原型存在页面和旧 API | 可能把原型当正式后端，形成双 SoR | 明确正式 SaaS repo/Owner；旧 Spring 不作为默认目标 | 是，Gate 2 |
| `CON-FE-P2-018` | Inquiry ownership | Site 是表单来源 | Conversation/Opportunity 归 SaaS | 可能在 Site 内再造 CRM/Inbox | Site 接收/consent/outbox，SaaS 匹配/会话/商机；另立 ADR | 是，M2 前 |
| `CON-FE-P2-019` | 成功定义 | PRD 含 Demo 快、发布、询盘；原型以页面/数字表现“完成” | 当前只能真实观测到开发预览链的一部分 | 指标提前承诺或被活动量替代 | 领先指标与未来结果分层；反指标入 Gate | 是，Gate 2 |
| `CON-FE-P2-020` | 前端正式仓库 | `/global/frontend` 有广泛原型但无 Git provenance | 本仓声明 SaaS UI 外部拥有 | 后续设计/实现无法落 owner、CI、release | Gate 2 指定 repo/Owner；未定前只写接缝和规范 | 是，Gate 2 |
| `CON-FE-P2-021` | 设计事实源 | 原型代码和 Readdy/模板存在 | 无 Figma/Token/Storybook/正式设计 Owner | 视觉代码可能被当规范，权利也未清 | Phase 3/4 建设计资产 ID/Owner/版本；工具另决策 | 是，Owner Gate 2/3 |
| `CON-FE-P2-022` | 冻结能力和未购买能力如何展示 | 原型全部显示为可进入 | 实际存在 frozen/deferred/not built/entitlement 等多态 | 用户会遇到空页面、假按钮或销售误导 | AVAILABLE / UNAVAILABLE_WITH_REASON / NOT_OFFERED 三态，由服务端 manifest 驱动 | 是，Gate 2 |

## 2. Gate 2 决策卡

### `DEC-FE-P2-001` 首批目标客户

- 选项 A：B2B 制造、工贸一体、传统出口。
- 选项 B：同时覆盖制造、SaaS、专业服务。
- 选项 C：代理商多 Workspace 优先。
- 推荐：A。它与 Site Builder 当前主线、企业信任素材和历史买家智能能力最吻合；B/C 会立即引入不同对象、权限和服务模式。

### `DEC-FE-P2-002` 默认日常操作者

- 选项 A：老板/出海负责人。
- 选项 B：海外增长/外贸运营。
- 选项 C：市场内容运营。
- 推荐：B；老板是经济购买和高风险批准者，市场/品牌与销售是协作角色。

### `DEC-FE-P2-003` 一级 IA

- 选项 A：旧六项 + 独立站。
- 选项 B：对象中心七项。
- 选项 C：任务/对象混合六项。
- 推荐：C，详见 [导航方案](navigation-and-workspace-shell-options.md)。

### `DEC-FE-P2-004` 首个纵切

- 选项 A：一次做到公开发布和域名。
- 选项 B：资料/素材/事实 → Build/取消/恢复 → 可信开发预览。
- 选项 C：先迁移全部原型页面框架。
- 推荐：B。A 缺公开合同和生产基础；C 会再次形成横铺 Mock。

### `DEC-FE-P2-005` Claim 人工 Gate

- 选项 A：首个纵切前补公开审核合同和页面。
- 选项 B：由受控运营完成，前端显示阻塞/状态/证据，后续自助化。
- 选项 C：自动批准。
- 推荐：A；若排期不允许则 B。C 违反事实安全边界。

### `DEC-FE-P2-006` 核心对象 ownership

- 保持：Company/Offering/Claim/Evidence/Buyer/Site/Release 在本仓相应域；Workspace/Campaign/Conversation/Opportunity/Outcome 在 SaaS。
- 需补：正式 SaaS repo 和各域 Owner、Inquiry 接缝、Approval 信封。
- 推荐：批准保持项，不用旧 Spring 原型改变边界。

### `DEC-FE-P2-007` 用户可见承诺

建议首批只承诺：

- 独立站管理一级入口；
- 最少 intake 后安全 Demo；
- 分步资料保存、素材/文档上传与处理状态；
- 支持合同允许的整站/局部 Build；
- 步骤、成本、degraded、取消和恢复语义；
- active READY Release 支撑的可信开发预览。

明确不承诺：公开发布、域名/SSL、用户可操作版本回滚、询盘、站点分析、诊断、任意语言、任意风格或“生产就绪”。

### `DEC-FE-P2-008` 成功指标

- 批准当前纵切候选 `MET-SITE-001`–`014`；目标值在基线后设。
- Publish/Inquiry 指标只在能力发布后启用。
- 指定产品数据、隐私和事件合同 Owner。

### `DEC-FE-P2-009` 正式前端与设计 Owner

- 指定正式 SaaS 前端仓库/remote/CI/deploy Owner。
- 指定设计 Owner 和设计事实源策略。
- 未决定时 `/global/frontend` 与 Readdy 资产继续 `PROTOTYPE/VISUAL_REFERENCE_ONLY`。

## 3. 建议决策组合

推荐一次性批准以下组合，内部约束相互一致：

```text
SEG-FE-001 B2B 制造/工贸优先
+ ACT-FE-002 海外增长/外贸运营为默认操作者
+ IA 选项 C 六项混合导航
+ DOM-FE-002 统一企业事实底座
+ JRN-FE-002 / PAGE-030–043 首个纵切
+ 首批承诺止于可信开发预览
+ Claim 审批 fail-closed
+ MET-SITE-001–014 + 反指标
+ 明确 SaaS repo/Owner，不继承旧 Spring SoR
```

如果只批准其中一部分，未批准项继续保留 `OPEN_DECISION`；不得由 Phase 3 文档施工补猜。

## 4. 决议回写位置

| 决策 | Gate 2 后的唯一回写位置（Phase 3/4） |
|---|---|
| 目标用户/任务 | `docs/frontend/03-users-roles-and-journeys.md` + capability register |
| 产品域/对象 ownership | core object register + ADR/PDR（承重边界变更时） |
| IA/Shell | `docs/frontend/02-information-architecture.md`、`05-navigation-and-workspace-shell.md` |
| 用户承诺/首个纵切 | Site Capability Pack manifest + module PRD/UX |
| 指标 | capability register + analytics contract |
| 前端/设计 Owner | document/design register + CONTRIBUTING/仓库治理（另行授权） |

本 Phase 2 登记在正式真值迁移完成前保留为决策 provenance，不直接成为生产 UI 文案。
