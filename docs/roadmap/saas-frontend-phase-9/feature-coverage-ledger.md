# Phase 9 全产品功能覆盖总账

> 文档 ID：`BASE-FE-P9-002`
> 状态：`DRAFT`
> 生命周期：`DRAFT`
> Owner：`OWN-PRODUCT`
> 协作责任帽子：`OWN-DESIGN`、`OWN-SAAS-PLATFORM`、`OWN-SAAS-FE`、`OWN-QA-EVIDENCE`、`OWN-DATA-PRIVACY`、`OWN-SEC-COMMERCIAL`、`OWN-OPS`
> 工程核验基线：`8dcbbcb8254a561f33abc59c49da4cb6a3de30b1`，2026-07-22
> 最新增量对账：`e0e51075df8ee8bb14dc5141f83365c6a2a4dec1`，2026-07-23（OpenAPI 仍为 56 paths / 64 operations）
> 边界：本文件只做功能完整性、对象/页面候选与设计追踪；不恢复 Buyer Intelligence 新增开发，不创建正式 `CAP-*`、`OBJ-FE-*` 或 `PAGE-FE-*` 登记

## 1. 目的、来源与读法

本总账把现有 76 个稳定 Page ID 当作**下限**，而不是完成证明或未来页面上限。它回答三个问题：

1. 现有页面和能力应该保留、加深还是拆开；
2. 制造业全产品体验中还有哪些缺失能力；
3. 每项能力由谁拥有真值、能否消费当前 API、处于什么产品状态，以及后续如何进入 Scenario、Metric、Guide 和 Figma。

主要来源为：

- [全产品页面与能力目录](../../frontend/04-page-and-capability-catalog.md)与 [Capability Registry](../../governance/capability-register.md)；
- [核心对象、SoR 与生命周期登记](../../governance/core-object-register.md)与 [跨域接缝和缺口](../saas-frontend-phase-6/cross-domain-handoffs-and-gaps.md)；
- [当前产品边界](../../product-scope.md)、[as-built 架构](../../architecture/current.md)、[当前状态](../../status/current.md)与 [Release Plan](../release-plan.md)；
- 机器导出的 [OpenAPI](../../../packages/contracts/openapi/openapi.json)；
- Phase 1–8 审计、模块 Capability Pack、本轮批准的全产品设计计划和 Phase 9 Source & Truth Ledger。

外部产品、OSS、历史 Word、Mock、截图和 Figma 只可证明“需要研究”或“可能缺失”，不能把能力升级为已实现、已采用或可售卖。

## 2. 处置与状态词典

### 2.1 功能处置

| 处置 | 判断标准 | 本阶段动作 |
|---|---|---|
| `Keep` | 现有页面/对象边界正确，仍需保留 | 保持 canonical 归属，补状态和追踪，不复制 SoR |
| `Deepen` | 现有页面族可承载，但制造业字段、权限、恢复或证据深度不足 | 扩充 Page Manifest、交互、对象切片和失败状态 |
| `Split` | 一个现有页面混合了不同对象、生命周期或权限 | 先定义候选页面族/子路由；不立即占正式 Page ID |
| `New` | 现有 76 页无法安全承载，且有独立用户结果、对象/投影、生命周期和退出路径 | 建 `CAND-P9-*` / `PFAM-P9-*` 候选，过 Gate 后再登记 |
| `Park` | 有业务相关性但不是首版产品核心，或应先集成而非重建 | 进入战略停车区，写进入触发器和非目标 |
| `Reject` | 会破坏安全、SoR、许可或产品边界 | 明确禁止，不进入 Figma 可执行流或产品 backlog |

处置不是实现状态。`Keep` 可以仍为 `TARGET_EXTERNAL`，`New` 也只可能是 `PROPOSED`。

### 2.2 产品状态

| 状态 | 含义 |
|---|---|
| `AS_BUILT_SUBSET` | 当前后端或内部地基存在；不自动代表前端/生产可用 |
| `SPEC_READY_WITH_BLOCKERS` | 规格足够深入，但仍有 Owner、合同、设计源或部署硬门 |
| `FROZEN_MAP_ONLY` | 地图和后端维护保留；未获明确指令不得恢复新增施工 |
| `TARGET_EXTERNAL` | 应由 SaaS/其他 SoR 建设；本仓不拥有主状态 |
| `PROPOSED` | 由完整性审计提出，尚未成为正式 Capability/Object/Page |
| `DEFERRED` | 已知后置，未到产品 Gate |
| `BACKEND_ONLY` | 面向内部消费者、运营或系统对账，不是普通用户页面动作 |
| `REJECTED` | 与许可、安全或产品边界冲突 |

## 3. 76 个稳定 Page ID 基线与处置

| 现有 Page family | 数量 | 本轮处置 | Phase 9 结论 |
|---|---:|---|---|
| `PAGE-FE-001..010` Shell/今日 | 10 | `Keep + Deepen + Split` | 登录页拆出完整身份/恢复族；Today、Search、通知、任务、审批、异常、长任务和帮助保持横向投影，不拥有业务对象 |
| `PAGE-FE-020..026` 企业事实、资料与信任 | 7 | `Keep + Deepen` | 保留 Company/Profile、Offering、Claim/Evidence、Asset/Knowledge 等通用对象；行业资料通过动态引导、上传/导入、KB 抽取和 Offering attributes 按需出现，不固化全行业规格库或独立准备度页面 |
| `PAGE-FE-030..057` Site | 28 | `Keep + Deepen + Split + New` | 保留当前 Site 纵切；补站点导入、设计智能、局部重建、QA、发布、Hosting Target、域名/TLS、维护和公开输出边界 |
| `PAGE-FE-060..066` Buyer Intelligence | 7 | `Keep + Deepen + Split` | 身份、信号、联系人、可达性、制裁、资格包和数据权利需要独立面板/子路由；整体继续 `FROZEN_MAP_ONLY` |
| `PAGE-FE-070..079` 增长执行 | 10 | `Keep + Deepen + Split + New` | Campaign、内容、媒体、社交发布、直接触达、渠道能力绑定和公开互动不得混成一个“发布”生命周期 |
| `PAGE-FE-080..083` 互动与商机 | 4 | `Keep + Deepen` | 私密 Inbox 与公开互动分离；Inbox 覆盖队列、会话、分派、上下文、AI 草稿和回复回执。Opportunity 保持 `TARGET_EXTERNAL/CONTRACT_BLOCKED`，不新增 RFQ 聚合或工程生命周期 |
| `PAGE-FE-084..086` 洞察 | 3 | `Keep + Deepen` | 指标定义、水位、质量、成本来源和对象级下钻必须可见；不把未知补成 0 |
| `PAGE-FE-090..096` 管理与运营 | 7 | `Keep + Deepen + Split + New` | 集成中心扩成 Provider/连接/能力绑定/同步/退出；补个人设置、开发者、数据导出/关停和受控平台运营表面 |
| **合计** | **76** | 稳定下限 | 缺号继续保留；本文件不直接分配任何新正式 Page ID |

## 4. Feature Coverage Ledger

表中 `S/M/G/F` 依次为 Scenario、Metric、Guide、Figma 占位。它们都是 Phase 9 候选，不是正式 Registry ID。API 写 operation group 或 `NONE`；详细 operation 逐项映射见 §5。

### 4.1 公共站、身份、Onboarding 与 Shell

| Candidate | 处置 | 能力与用户问题 | 来源 / 当前 Page | 对象与 SoR | API / 产品状态 | S/M/G/F 占位 |
|---|---|---|---|---|---|---|
| `CAND-P9-FEAT-001` | `New` | 产品官网、制造业方案、价格、案例、信任中心：访客在注册前能判断适配性、证据和风险 | 本轮批准计划；现有 76 页无公共转化族 | 公开内容由 SaaS Marketing/Content SoR；不复制 Company/Claim | `NONE` / `PROPOSED` | `CAND-P9-SCN-001` / `CAND-P9-MET-001` / `CAND-P9-GUIDE-001` / `CAND-P9-FIG-001` |
| `CAND-P9-FEAT-002` | `Split + Deepen` | 注册、登录、邮箱验证、找回、MFA、会话和受邀加入 | `CAP-ID-001`；`PAGE-FE-001` | Account/Session 外部 SaaS 身份 SoR；本仓只验 JWKS | `WhoamiController_whoami_v1` 仅会话投影 / `TARGET_EXTERNAL` | `CAND-P9-SCN-002` / `CAND-P9-MET-002` / `CAND-P9-GUIDE-002` / `CAND-P9-FIG-002` |
| `CAND-P9-FEAT-003` | `Split + New` | Workspace 创建/选择、角色邀请、企业草案、目标选择、安全 Demo 和首次价值 | `CAP-ONB-001`；`PAGE-FE-002/032/033` | Workspace/Membership 外部 SaaS SoR；Company/Site 由各自 SoR | whoami + intake/company 子集 / `PROPOSED + AS_BUILT_SUBSET` | `CAND-P9-SCN-003` / `CAND-P9-MET-003` / `CAND-P9-GUIDE-003` / `CAND-P9-FIG-003` |
| `CAND-P9-FEAT-004` | `New` | CSV/表格/旧站/文档导入、字段映射、校验、恢复、迁移问题和重跑 | Phase 6 `GAP-FE-P6-003/004`；无现有 Page | ImportRun 为 SaaS workflow；写入仍回 canonical object SoR | `NONE` / `PROPOSED` | `CAND-P9-SCN-004` / `CAND-P9-MET-004` / `CAND-P9-GUIDE-004` / `CAND-P9-FIG-004` |
| `CAND-P9-FEAT-005` | `Keep + Deepen` | Today、全局搜索、通知：在正确 Workspace 找到最高价值行动并回到 canonical object | `PAGE-FE-003..005` | Task/Notification/Search 只读投影，SaaS control plane SoR | `NONE` / `TARGET_EXTERNAL` | `CAND-P9-SCN-005` / `CAND-P9-MET-005` / `CAND-P9-GUIDE-005` / `CAND-P9-FIG-005` |
| `CAND-P9-FEAT-006` | `Keep + Deepen` | 任务、审批、异常、长任务和支持：理解影响、保留结果、安全恢复 | `PAGE-FE-006..010`；Site Build/Asset 已有局部事实 | 聚合读模型不拥有 Approval/Run/Incident；决定写回域对象 | Build/Asset 子集；统一 API `NONE` / `TARGET_EXTERNAL` | `CAND-P9-SCN-006` / `CAND-P9-MET-006` / `CAND-P9-GUIDE-006` / `CAND-P9-FIG-006` |

### 4.2 制造业企业真相与 Buyer Intelligence

| Candidate | 处置 | 能力与用户问题 | 来源 / 当前 Page | 对象与 SoR | API / 产品状态 | S/M/G/F 占位 |
|---|---|---|---|---|---|---|
| `CAND-P9-FEAT-007` | `Keep + Deepen` | 企业基础资料按最少必填开始，并可通过引导、上传或导入补充；法人、品牌、联系资料和行业自述不混成一个字段组 | `PAGE-FE-020/034`；current Profile 五组 | Company/Profile 为通用事实 SoR；多工厂对象没有 current 合同，仅可作为动态资料候选 | Company create/list/get/completeness/confirm + Site Profile get/patch / `AS_BUILT_SUBSET` | `CAND-P9-SCN-007` / `CAND-P9-MET-007` / `CAND-P9-GUIDE-007` / `CAND-P9-FIG-007` |
| `CAND-P9-FEAT-008` | `Keep + Deepen` | 客户按自身行业填写或上传产品/服务资料，系统从 KB 提取候选字段并由人确认；没有的字段可跳过 | `PAGE-FE-021/035..037`；`OBJ-FE-004` | Offering + attributes、Asset/KB、Claim/Evidence 承载通用事实；不新建固定 ProductFamily/Variant/TechnicalSpecification | listOfferings 只读子集 + Asset/KB / `AS_BUILT_SUBSET`，无通用规格 CRUD/版本证据 | `CAND-P9-SCN-008` / `CAND-P9-MET-008` / `CAND-P9-GUIDE-008` / `CAND-P9-FIG-008` |
| `CAND-P9-FEAT-009` | `Keep + Deepen` | Claim、Evidence、冲突、认证、资料与权利：知道哪些事实可用、为什么、何时失效 | `PAGE-FE-022..024/026`；`OBJ-FE-005..008` | 企业事实/Asset SoR 保持不变；Certification 不绕过 Claim/Evidence | Claim/conflict + Site Asset/KB API / `AS_BUILT_SUBSET` | `CAND-P9-SCN-009` / `CAND-P9-MET-009` / `CAND-P9-GUIDE-009` / `CAND-P9-FIG-009` |
| `CAND-P9-FEAT-010` | `Reject standalone + Fold` | 将 completeness、KB gaps、解析状态和待审核事实转成可执行的补充任务，不建立独立 Export Readiness 工作台或汇总分数 | `PAGE-FE-025` 旧地图输入；current completeness/KB status | 派生 progress/gaps 只读投影到 Today、Onboarding 和资料页；不新增 ReadinessAssessment SoR | completeness + KB status 子集 / `AS_BUILT_SUBSET` | `CAND-P9-SCN-010` / `CAND-P9-MET-010` / `CAND-P9-GUIDE-010` / `CAND-P9-FIG-010` |
| `CAND-P9-FEAT-011` | `Keep` | 市场研究、ICP、规则、购买委员会和回测 | `PAGE-FE-060..062`；Buyer Pack | ICP/Company/Lead 由 Buyer Intelligence SoR | ICP/rule/backtest/query-plan API / `FROZEN_MAP_ONLY` | `CAND-P9-SCN-011` / `CAND-P9-MET-011` / `CAND-P9-GUIDE-011` / `CAND-P9-FIG-011` |
| `CAND-P9-FEAT-012` | `Deepen + Split` | Lead identity、Evidence、Intent、联系人、可达性、资格、制裁和不可变 Package 分层查看 | `PAGE-FE-063/064` | CanonicalCompany、Lead、Package 保持不同对象；联系人属受限个人数据 | company/lead/contact/qualification/sanctions API / `FROZEN_MAP_ONLY` | `CAND-P9-SCN-012` / `CAND-P9-MET-012` / `CAND-P9-GUIDE-012` / `CAND-P9-FIG-012` |
| `CAND-P9-FEAT-013` | `Deepen` | Discovery/Provider 运行、部分失败、来源关闭、预算、ACK 与安全恢复 | `PAGE-FE-065` | DiscoveryRun/Provider 投影由 Buyer/运营拥有 | query-plan execute/run/providers / `FROZEN_MAP_ONLY` | `CAND-P9-SCN-013` / `CAND-P9-MET-013` / `CAND-P9-GUIDE-013` / `CAND-P9-FIG-013` |
| `CAND-P9-FEAT-014` | `Deepen` | Suppression、删除请求、用途、保留和处理回执 | `PAGE-FE-066/094` | suppression/deletion SoR 为数据权利后端；UI 不留导出副本 | suppression/deletion API / `AS_BUILT_SUBSET + FROZEN_MAP_ONLY` | `CAND-P9-SCN-014` / `CAND-P9-MET-014` / `CAND-P9-GUIDE-014` / `CAND-P9-FIG-014` |

### 4.3 Site Builder、发布与公开输出

| Candidate | 处置 | 能力与用户问题 | 来源 / 当前 Page | 对象与 SoR | API / 产品状态 | S/M/G/F 占位 |
|---|---|---|---|---|---|---|
| `CAND-P9-FEAT-015` | `Keep + New` | Site 列表、首次 Intake、安全 Demo 与既有站导入 | `PAGE-FE-030..033`；Site Pack | Site/SiteVersion 由 Site Builder SoR；Site Import 为 workflow 候选 | intake/sites / `AS_BUILT_SUBSET`; import `PROPOSED` | `CAND-P9-SCN-015` / `CAND-P9-MET-015` / `CAND-P9-GUIDE-015` / `CAND-P9-FIG-015` |
| `CAND-P9-FEAT-016` | `Keep + Deepen` | 资料与知识：通用五组引导填写、批量上传文件/图片、网站/店铺导入、KB 解析、动态缺口、人工复核和引用删除影响；可跳过并稍后继续 | `PAGE-FE-034..039` | Company/Profile、Offering、Claim/Evidence、Asset/KB 各自保留 SoR；行业问卷是元数据，Site 只消费 snapshot | profile/assets/kb + claim API / `SPEC_READY_WITH_BLOCKERS` | `CAND-P9-SCN-016` / `CAND-P9-MET-016` / `CAND-P9-GUIDE-016` / `CAND-P9-FIG-016` |
| `CAND-P9-FEAT-017` | `Keep + Deepen` | Build scope、步骤、成本、取消、ACK unknown、迟到结果、失败恢复和可信预览 | `PAGE-FE-040..044` | BuildRun/Step/Spend/Release 由 Site Builder SoR | builds create/get/cancel / `SPEC_READY_WITH_BLOCKERS` | `CAND-P9-SCN-017` / `CAND-P9-MET-017` / `CAND-P9-GUIDE-017` / `CAND-P9-FIG-017` |
| `CAND-P9-FEAT-018` | `Split + Deepen` | 结构、内容/多语言、设计 Family/Variant、局部重建和设计 QA 是不同编辑任务 | `PAGE-FE-045..047` | SiteVersion draft、CopyBundle、DesignBrief/Family 各守合同；不反写 Company/Claim | public write API `NONE` / `APPROVED_NOT_BUILT` | `CAND-P9-SCN-018` / `CAND-P9-MET-018` / `CAND-P9-GUIDE-018` / `CAND-P9-FIG-018` |
| `CAND-P9-FEAT-019` | `Split + Deepen` | Version/Release/Publish/Deployment/HostingTarget/Domain/TLS/Rollback 分层 | `PAGE-FE-048..052` | Release 仍由 Site SoR；发布/部署、HostingTarget、DomainBinding 为候选控制对象 | public API `NONE` / `TARGET_NOT_RUNNABLE` | `CAND-P9-SCN-019` / `CAND-P9-MET-019` / `CAND-P9-GUIDE-019` / `CAND-P9-FIG-019` |
| `CAND-P9-FEAT-020` | `Keep + Deepen` | 表单设置、询盘投递、站点分析、诊断和维护 | `PAGE-FE-053..056` | Inquiry 接收边界待 ADR；指标是读模型；诊断是 Finding/Run | `NONE` / `DEFERRED + OPEN_DECISION` | `CAND-P9-SCN-020` / `CAND-P9-MET-020` / `CAND-P9-GUIDE-020` / `CAND-P9-FIG-020` |
| `CAND-P9-FEAT-021` | `Keep + Deepen` | 面向海外买家的高性能、可访问、多语言制造业公开站与有效询盘 | `PAGE-FE-057` | 公开输出消费 approved Release；不拥有管理态或 Inquiry SoR | renderer/internal preview substrate / `PARTIAL_AS_BUILT_TARGET_SPECIFIED` | `CAND-P9-SCN-021` / `CAND-P9-MET-021` / `CAND-P9-GUIDE-021` / `CAND-P9-FIG-021` |

### 4.4 内容、媒体、分发、触达与互动

| Candidate | 处置 | 能力与用户问题 | 来源 / 当前 Page | 对象与 SoR | API / 产品状态 | S/M/G/F 占位 |
|---|---|---|---|---|---|---|
| `CAND-P9-FEAT-022` | `Keep + Deepen` | Goal、Initiative、Campaign、Audience snapshot、Dry Run、Approval 和 ExecutionAuthorization | `PAGE-FE-070..074`；Growth Pack | SaaS Campaign SoR；批准与外部授权严格分离 | `NONE` / `TARGET_EXTERNAL` | `CAND-P9-SCN-022` / `CAND-P9-MET-022` / `CAND-P9-GUIDE-022` / `CAND-P9-FIG-022` |
| `CAND-P9-FEAT-023` | `Split + New` | Master Content、语言版本、渠道变体、图片和受控媒体 Job；每份素材有权利记录 | `PAGE-FE-075/076` | ContentAsset/MediaJob 为 SaaS SoR；RightsRecord 关联 Asset/Evidence | `NONE` / `PROPOSED` | `CAND-P9-SCN-023` / `CAND-P9-MET-023` / `CAND-P9-GUIDE-023` / `CAND-P9-FIG-023` |
| `CAND-P9-FEAT-024` | `Split + Deepen` | 社交排程、发布、逐渠道 DeliveryReceipt 和安全重试 | `PAGE-FE-077/078` | PublishJob 与内容分离；外部 Provider 只返回回执 | `NONE` / `TARGET_EXTERNAL` | `CAND-P9-SCN-024` / `CAND-P9-MET-024` / `CAND-P9-GUIDE-024` / `CAND-P9-FIG-024` |
| `CAND-P9-FEAT-025` | `New` | 公开帖子评论、提及、审核、公开回复和升级私聊 | 当前 76 页缺失；Aitoearn/渠道研究输入 | PublicInteraction 由 SaaS public-engagement SoR；不等于 Conversation | `NONE` / `PROPOSED` | `CAND-P9-SCN-025` / `CAND-P9-MET-025` / `CAND-P9-GUIDE-025` / `CAND-P9-FIG-025` |
| `CAND-P9-FEAT-026` | `Split + New` | 一对一销售触达、序列、抑制、逐收件人回执和暂停；不能复用社交发布状态机 | `PAGE-FE-073/074/078` 只可提供输入 | OutboundSequence/Job 属 SaaS 执行域；联系人/rights 仍由源对象拥有 | `NONE` / `PROPOSED` | `CAND-P9-SCN-026` / `CAND-P9-MET-026` / `CAND-P9-GUIDE-026` / `CAND-P9-FIG-026` |
| `CAND-P9-FEAT-027` | `Split + Deepen` | 渠道连接按 publish/public interaction/private message/analytics 能力授权、健康、轮换和退出 | `PAGE-FE-079/092` | ProviderConnection + CapabilityBinding；CredentialRef 留 Secret store | `NONE` / `TARGET_EXTERNAL` | `CAND-P9-SCN-027` / `CAND-P9-MET-027` / `CAND-P9-GUIDE-027` / `CAND-P9-FIG-027` |
| `CAND-P9-FEAT-028` | `Keep + Deepen` | 网站聊天、邮件、WhatsApp 等私密入站、分派、SLA、翻译、内部备注和回复回执 | `PAGE-FE-080/081`；Engagement Pack | Conversation/Message 为 SaaS SoR；Chatwoot 仅可作 Provider/执行引擎 | `NONE` / `TARGET_EXTERNAL` | `CAND-P9-SCN-028` / `CAND-P9-MET-028` / `CAND-P9-GUIDE-028` / `CAND-P9-FIG-028` |
| `CAND-P9-FEAT-029` | `Reject` | 不新增 RFQ Lite 聚合。若入站消息包含询价信息，只在 Conversation 中保留原文/附件、分派、企业/Offering 上下文、AI 草稿和外部交接回执 | `PAGE-FE-080..083` 仅提供未来入口 | Conversation/Opportunity SaaS SoR 尚未定位；工程规格、CAD、公差、样品和报价继续留 PIM/PLM/ERP/CPQ | `NONE` / `REJECTED_FOR_CURRENT_SCOPE + TARGET_EXTERNAL` | `CAND-P9-SCN-029` / `CAND-P9-MET-029` / `CAND-P9-GUIDE-029` / `CAND-P9-FIG-029` |
| `CAND-P9-FEAT-030` | `Keep + Deepen` | QGO、SAO、Owner、下一步、截止时间和 verified Outcome | `PAGE-FE-082/083`；`OBJ-FE-021/022` | SaaS Opportunity/Outcome SoR；Buyer 只消费学习标签 | `NONE` / `TARGET_EXTERNAL` | `CAND-P9-SCN-030` / `CAND-P9-MET-030` / `CAND-P9-GUIDE-030` / `CAND-P9-FIG-030` |

### 4.5 洞察、设置、开发者、数据退出、Ops 与帮助

| Candidate | 处置 | 能力与用户问题 | 来源 / 当前 Page | 对象与 SoR | API / 产品状态 | S/M/G/F 占位 |
|---|---|---|---|---|---|---|
| `CAND-P9-FEAT-031` | `Keep + Deepen` | 经营/漏斗、归因/实验、成本/用量：显示定义、水位、质量、权限和对象级下钻 | `PAGE-FE-084..086` | MetricDefinition + analytics projection；业务对象 SoR 不变 | Site cost 子集；统一 API `NONE` / `TARGET_EXTERNAL` | `CAND-P9-SCN-031` / `CAND-P9-MET-031` / `CAND-P9-GUIDE-031` / `CAND-P9-FIG-031` |
| `CAND-P9-FEAT-032` | `Keep + Deepen + New` | 成员、角色、委派、个人设置、会话安全和跨 Workspace 代理交付 | `PAGE-FE-090/091/093/094` | Membership/Role/Entitlement/PersonalProfile 由 SaaS Identity/control plane SoR | whoami only / `TARGET_EXTERNAL` | `CAND-P9-SCN-032` / `CAND-P9-MET-032` / `CAND-P9-GUIDE-032` / `CAND-P9-FIG-032` |
| `CAND-P9-FEAT-033` | `Split + New` | Provider Catalog、连接向导、能力绑定、健康、同步、Webhook、API Key 和退出 | `PAGE-FE-092` | Integration/ProviderConnection/CapabilityBinding 由 SaaS control plane SoR | `NONE` / `PROPOSED + TARGET_EXTERNAL` | `CAND-P9-SCN-033` / `CAND-P9-MET-033` / `CAND-P9-GUIDE-033` / `CAND-P9-FIG-033` |
| `CAND-P9-FEAT-034` | `Keep + New` | 套餐、额度、账单、数据导出、账户关闭和迁移回执 | `PAGE-FE-095`; 当前无退出页面族 | Billing/Entitlement/DataExportJob 由 SaaS control plane SoR | `NONE` / `TARGET_EXTERNAL + PROPOSED` | `CAND-P9-SCN-034` / `CAND-P9-MET-034` / `CAND-P9-GUIDE-034` / `CAND-P9-FIG-034` |
| `CAND-P9-FEAT-035` | `Keep + Deepen` | 平台运营查看 Provider、model route、source policy、Webhook、事件 ACK、清理、redrive 和事故 | `PAGE-FE-096` | 运营投影/控制命令归 SaaS/各技术 Owner；不穿透 secret/原始 trace | health/events + internal controls / `BACKEND_ONLY + TARGET_EXTERNAL` | `CAND-P9-SCN-035` / `CAND-P9-MET-035` / `CAND-P9-GUIDE-035` / `CAND-P9-FIG-035` |
| `CAND-P9-FEAT-036` | `Split + New` | Tutorial、How-to、Reference、Explanation、Developer API、Changelog、Status、诊断与支持 | `PAGE-FE-010` 过于聚合；Diátaxis 已登记 | GuideManifest/Doc catalog 由文档治理；Status 为运行投影 | health/OpenAPI 可作来源 / `PROPOSED` | `CAND-P9-SCN-036` / `CAND-P9-MET-036` / `CAND-P9-GUIDE-036` / `CAND-P9-FIG-036` |

### 4.6 战略停车与明确拒绝

| Candidate | 处置 | 范围 | 进入条件或拒绝理由 | 产品状态 |
|---|---|---|---|---|
| `CAND-P9-PARK-001` | `Park` | 完整 CRM、ERP、MES、CPQ、订单、支付、库存、物流、售后，以及 RFQ 工程规格差异、加工可行性、公差/CAD 签核、工程批准、样品/报价深流程 | 优先通过客户 PIM/PLM/ERP/CPQ 的稳定对象引用、状态投影和 Adapter 对接；只有验证自建显著优于集成并获独立产品批准才重开 | `DEFERRED / INTEGRATION_FIRST` |
| `CAND-P9-PARK-002` | `Park` | 创作者/专家市场、通用自动化市场 | 不属于制造业首个增长闭环；不得因 OSS 已存在就加入 IA | `DEFERRED` |
| `CAND-P9-PARK-003` | `Park` | 完整视频工作室 | 首版只保留 MediaJob/外部 Provider 停车位；需版权、成本和用户验证后重开 | `DEFERRED` |
| `CAND-P9-PARK-004` | `Park` | 完整多触点归因、GEO/AEO | 先形成可信事件/MetricDefinition、水位和用户决策闭环 | `DEFERRED` |
| `CAND-P9-REJECT-001` | `Reject` | 无约束浏览器自动化、私有 API 逆向 | 违反安全、许可、稳定性和退出要求 | `REJECTED` |
| `CAND-P9-REJECT-002` | `Reject` | iframe 嵌入供应商后台或照搬其导航/术语 | 破坏产品信息架构、权限和可替换 Adapter 边界 | `REJECTED` |
| `CAND-P9-REJECT-003` | `Reject` | 在前端保存 Provider/new-api 密钥或建立第二业务 SoR | 明文 secret、双写和状态漂移不可接受 | `REJECTED` |
| `CAND-P9-REJECT-004` | `Reject` | 用 AI 自动签发 Claim Approval、ExecutionAuthorization、QGO/SAO 或 verified Outcome | AI 可建议/草拟，不能取代授权和业务决定 | `REJECTED` |

## 5. 当前 64 个 OpenAPI operation 的界面归属

本节保证每个当前 operation 都进入用户动作、运营动作或 backend-only 三类之一。分类只描述前端消费意图，不升级产品状态。

| Operation group | operationId（逐项） | 界面归属 | 页面/候选面 |
|---|---|---|---|
| 健康与会话 | `HealthController_check_v1`、`HealthController_db_v1` | `BACKEND_ONLY / OPS`；普通用户只看脱敏 Status 摘要 | `PAGE-FE-096`、`CAND-P9-FEAT-035/036` |
| 健康与会话 | `WhoamiController_whoami_v1` | 用户可见会话/Workspace 上下文；不能补造 role | `PAGE-FE-001/002/093`、`CAND-P9-FEAT-002/003/032` |
| Company | `CompanyController_create_v1`、`CompanyController_list_v1`、`CompanyController_get_v1`、`CompanyController_completeness_v1`、`CompanyController_confirm_v1`、`CompanyController_listOfferings_v1` | 用户动作 | `PAGE-FE-020/021/025`、Onboarding/Import 候选 |
| Claim/Conflict | `ClaimController_list_v1`、`ClaimController_createManual_v1`、`ClaimController_approve_v1`、`ClaimController_reject_v1`、`ClaimController_revoke_v1`、`ClaimController_listConflicts_v1`、`ClaimController_resolveConflict_v1` | 用户/审批动作；批准与撤销需 allowed actions 和影响提示 | `PAGE-FE-022/023/038` |
| ICP/规则 | `IcpController_generate_v1`、`IcpController_list_v1`、`IcpController_get_v1`、`IcpController_update_v1`、`IcpController_activate_v1`、`IcpController_addRule_v1`、`IcpController_updateRule_v1`、`IcpController_deleteRule_v1` | 用户动作；地图保留但新增前端冻结 | `PAGE-FE-062` |
| Backtest/Query Plan | `IcpController_runBacktest_v1`、`IcpController_listBacktests_v1`、`IcpController_generateQueryPlan_v1`、`IcpController_listQueryPlans_v1`、`IcpController_confirmQueryPlan_v1` | 用户审阅/确认动作；不得把生成计划当已执行 | `PAGE-FE-061/062/065` |
| Discovery/Company | `DiscoveryController_execute_v1`、`DiscoveryController_getRun_v1`、`DiscoveryController_listCompanies_v1`、`DiscoveryController_getCompany_v1`、`DiscoveryController_listProviders_v1` | 用户动作 + Provider 健康摘要；来源内部诊断仅 Ops | `PAGE-FE-063..065/096` |
| Contact | `DiscoveryController_discoverContacts_v1`、`DiscoveryController_verify_v1`、`DiscoveryController_guessEmails_v1` | 用户受限动作；用途、预算、个人数据和结果置信度必须可见 | `PAGE-FE-064` |
| Suppression | `DiscoveryController_addSuppression_v1`、`DiscoveryController_listSuppressions_v1`、`DiscoveryController_removeSuppression_v1` | 用户/隐私运营动作；移除 suppression 需要更高授权 | `PAGE-FE-066/094` |
| Lead | `LeadController_qualify_v1`、`LeadController_list_v1`、`LeadController_queues_v1`、`LeadController_get_v1`、`LeadController_accept_v1`、`LeadController_reject_v1`、`LeadController_sanctionsReview_v1` | 用户/合规复核动作；Package/Opportunity 状态不得混写 | `PAGE-FE-063/064` |
| 事件交付 | `EventsController_list_v1`、`EventsController_ack_v1` | `BACKEND_ONLY / OPS`：供可信 SaaS consumer/对账，不给普通用户手工伪造 ACK | `PAGE-FE-096`、`CAND-P9-FEAT-035` |
| 删除请求 | `DeletionController_create_v1`、`DeletionController_get_v1` | 用户/数据隐私运营动作 | `PAGE-FE-066/094`、Data Exit 候选 |
| Site/Intake/Profile | `IntakeController_create_v1`、`SitesController_list_v1`、`SitesController_get_v1`、`SitesController_getProfile_v1`、`SitesController_patchProfile_v1` | 用户动作；Patch 必须处理 ETag/并发与 ACK unknown | `PAGE-FE-030..034` |
| Asset/KB | `AssetsController_presign_v1`、`AssetsController_commit_v1`、`AssetsController_list_v1`、`AssetsController_remove_v1`、`KbController_status_v1` | 用户动作；presign/PUT/commit/processing/ready/删除是不同状态 | `PAGE-FE-035..039` |
| Build | `BuildsController_create_v1`、`BuildsController_get_v1`、`BuildsController_cancel_v1` | 用户动作；取消确认前不得显示 cancelled，失败不得覆盖旧预览 | `PAGE-FE-040..044` |

核对结果：64/64 operation 已归属。Campaign、Content、Publish、PublicInteraction、Conversation、Opportunity、Hosting、Billing、Developer API 和统一 Metrics 当前均为 `NONE`；当前也没有 RFQ 对象或接口。设计稿必须显示 `PROPOSED/TARGET_EXTERNAL/BLOCKED`，不能用上述 operation 拼出假闭环。

## 6. 横向完整性门

每项 `Keep/Deepen/Split/New` 在进入正式 Capability/Page Registry 前必须补齐：

1. 一个可验证的用户问题、primary actor 和完成结果；
2. canonical object、SoR、社会属性、生命周期和 allowed actions；
3. 首屏、主动作、入口、退出、深链和非目标；
4. normal、empty、loading、partial、degraded、stale、conflict、denied、offline、ACK unknown、cancel-confirming 和 late-result 中适用状态；
5. 机器合同或显式 `NONE/BLOCKED`，以及幂等、回执、补偿和人工兜底；
6. Scenario、Fixture、Metric/反指标、Guide 和受控 Figma Node；
7. Owner、License/security/privacy/data/exit 和真实用户验证。

以下等式继续是阻塞式评审规则：

```text
Identity authn != Workspace authz
Claim approval != execution authorization
Content approved != publish allowed
Publish accepted != delivered
Public interaction != private conversation
Reply received != Opportunity qualified
Inquiry received != private reply delivered != Opportunity qualified
Outcome reported != outcome verified
Build succeeded != Release active != Preview != Published != Domain healthy
Metric rendered != metric trustworthy
```

若设计把任一组左右状态压成一个按钮、Badge 或成功页，该设计不得进入高保真或实现 Gate。

## 7. 本轮结论与下一步

- 76 个现有 Page ID 全部保留为稳定下限；没有因缺号或竞品页面直接新增正式 ID。
- 全产品新增缺口集中在公共转化、完整身份/Onboarding、资料与知识引导、Site Import/Hosting、媒体、公开互动、直接触达、私密会话、个人设置、开发者和数据退出；RFQ 聚合及完整工程流程不进入 current 设计，转入未来研究或 PIM/PLM/ERP/CPQ 集成停车区。
- Buyer Intelligence 的 `Deepen/Split` 是设计覆盖，不解除 `FROZEN_MAP_ONLY`。
- 当前 64 个 OpenAPI operation 已全部映射；目标 SaaS 域仍缺的 API 被明确写为 `NONE`。
- 候选对象的聚合根/子对象/投影/工作流/停车判断和最终页面族见 [对象与页面族评审](object-page-family-review.md)。
- 本文件达到 `DRAFT / COVERAGE_AUDITED`；只有 Source & Truth Ledger 冲突关闭、对象评审通过和 Owner 签发后，候选项才可迁入正式 Registry。
