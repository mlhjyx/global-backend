# Phase 9 对象拆分与最终页面族评审

> 文档 ID：`BASE-FE-P9-003`
> 状态：`DRAFT`
> 生命周期：`DRAFT`
> Owner：`OWN-PRODUCT`
> 对象协作责任帽子：`OWN-SAAS-PLATFORM`、`OWN-TRUTH-BE`、`OWN-SITE-BE`、`OWN-BUYER-BE`、`OWN-DATA-PRIVACY`、`OWN-SEC-COMMERCIAL`、`OWN-OPS`
> 体验与交付责任帽子：`OWN-DESIGN`、`OWN-SAAS-FE`、`OWN-QA-EVIDENCE`
> 边界：本文件评审候选对象和页面族；不直接新增或改写正式 `OBJ-FE-*`、`PAGE-FE-*`、`CAP-*`

## 1. 评审目标

本文件承接 [Feature Coverage Ledger](feature-coverage-ledger.md)，对新增能力做两次约束：

1. 判断它是否真的需要独立对象，还是既有对象的子实体、值对象、关系、读模型、工作流或外部投影；
2. 判断它是否真的需要新页面族，还是能作为现有 canonical page 的 Tab、Inspector、Drawer、流程步骤或深链。

现有 27 个正式对象继续由 [Core Object Registry](../../governance/core-object-register.md)承重。下表中的 `CAND-P9-OBJ-*` 只是设计候选，不能进入 Schema、API、导航或正式 Figma 命名，直到相应 Owner 批准 SoR、生命周期、社会属性和机器合同。

## 2. 对象分类决策规则

| 分类 | 成立条件 | 页面规则 |
|---|---|---|
| `AGGREGATE_CANDIDATE` | 有稳定 identity、独立生命周期、权限、并发边界和不可由现有聚合安全承载的命令 | 可有 canonical detail；聚合页只投影 |
| `CHILD_ENTITY` | 有 identity/历史，但生命周期依附一个既有聚合 | 在父对象页面中管理；除非任务复杂，不建一级页面 |
| `VALUE_OBJECT` | 无独立 identity，随父对象版本化 | 作为规格表/字段组，不建路由 |
| `RELATION_DECISION` | 表达两个对象间有审计意义的关联/匹配决定 | 用 Evidence/影响面板；不复制两端主状态 |
| `READ_MODEL` | 可从多个 SoR 重算，只服务决策/聚合 | 展示 watermark/口径/来源；不得写回业务真值 |
| `WORKFLOW_LEDGER` | 长任务、外部执行或补偿需要稳定 ID、步骤和回执 | 任务中心可投影，canonical 详情保留幂等/恢复语义 |
| `CONTROL_PLANE_OBJECT` | 表达连接、scope、allowed action、secret 引用或系统配置 | 仅控制面可写；普通用户只见必要摘要 |
| `EXTERNAL_PROJECTION` | 真值属于外部 SaaS/Provider，我方只保存稳定映射与回执 | 不双写外部主状态；必须支持回补、去重和退出 |
| `REGISTRY_METADATA` | 设计、指标、文档或 Provider 能力的版本化定义 | 由治理 Registry 管，不成为业务菜单对象 |
| `PARK` | 应集成、后置或缺乏已验证用户结果 | 不画成可执行产品，不预建空 Schema |

以下迹象单独出现时，不足以新增对象或页面：需要一张表、竞品有独立菜单、后端有一个 Controller、AI 能生成结果、页面字段很多、第三方 API 返回一种资源。

## 3. 候选对象分类决策

### 3.1 身份、导入与企业真相

| Candidate | 候选名称 | 决策 | SoR / Owner | 生命周期与页面承载 | 不得混淆 |
|---|---|---|---|---|---|
| `CAND-P9-OBJ-001` | Account、PersonalProfile、Session | `EXTERNAL_PROJECTION`；不新增本仓聚合 | SaaS Identity / `OWN-SAAS-PLATFORM` | Auth/个人设置页面消费会话与安全摘要；本仓只验 token | Account identity ≠ Workspace Membership ≠ person/contact |
| `CAND-P9-OBJ-002` | ImportRun | `WORKFLOW_LEDGER` 候选 | SaaS import service / `OWN-SAAS-PLATFORM` | mapping→validating→ready→running→partial/succeeded/failed/cancelled；进入 Import Center 和长任务中心 | 导入成功 ≠ 每条对象写入成功；重跑必须幂等 |
| `CAND-P9-OBJ-003` | MigrationIssue | `CHILD_ENTITY`，依附 ImportRun | 同 ImportRun / `OWN-SAAS-PLATFORM` | 行/字段/对象级错误、修复建议和保留结果；不单独进导航 | 校验警告 ≠ 写入失败 ≠ 对象冲突 |
| `CAND-P9-OBJ-004` | FactorySite / Plant | `PARK`；当前不新增对象 | current CompanyProfile/Offering/Claim/Evidence；未来由 `OWN-TRUTH-BE` 评审 | 现阶段只在客户确有需要时通过引导字段、资料和声明表达；多工厂稳定 identity、权限和生命周期未有 current 合同 | 法人 Company ≠ 自述工厂资料 ≠ 已验证工厂对象 |
| `CAND-P9-OBJ-005` | ProductFamily、ProductModel | `REJECT_AS_SEPARATE_CURRENT_OBJECT` | 复用 `OBJ-FE-004` Offering 及其 attributes / `OWN-TRUTH-BE` | 产品分类、型号或参数只在行业引导、KB 抽取和 Offering 页面中按需出现；不预建全行业层级 | 示例里的产品族/型号 ≠ 已实现对象 ≠ PLM item |
| `CAND-P9-OBJ-006` | ConfigurableKeyParameter | `VALUE_OBJECT_PROPOSAL`，仅作为 Offering attributes/表单元数据 | Offering / `OWN-TRUTH-BE` | 字段 schema 由行业/目标配置决定；可包含名称、值、单位、来源和适用范围，但没有 current 独立合同 | Offering JSON 可承载扩展 ≠ 已实现通用规格库；抽取值 ≠ 已审核 Claim |
| `CAND-P9-OBJ-007` | Certification | `FOLD_INTO_EXISTING` Claim/Evidence/Asset | Claim/Evidence/Asset / `OWN-TRUTH-BE` | 上传文件、提取字段和审核结论分别落在现有通用对象；只有未来证明独立生命周期才重新评审 | 上传证书 ≠ 证书有效 ≠ 获准公开 |
| `CAND-P9-OBJ-008` | CapacityProfile | `REJECT_AS_SEPARATE_CURRENT_OBJECT` | CompanyProfile/Offering attributes + Claim/Evidence / `OWN-TRUTH-BE` | 产能、MOQ、交期、OEM/ODM 只在相关行业/目标的动态问题中出现；复杂排产留 ERP/MES | 客户填写 ≠ 经审核能力 ≠ 实时可承诺产能 |
| `CAND-P9-OBJ-009` | ReadinessAssessment | `REJECT_AS_AGGREGATE`；仅保留派生 gaps/progress projection | current KB/Profile/Build read models / `OWN-SITE-BE` | 在 Onboarding、资料与知识或 Today 中显示缺失、解析、待复核和下一动作；不建独立工作台、不写回企业事实、不输出伪精确总分 | `KbStatus.gaps` ≠ 独立 Assessment ≠ 业务批准 |
| `CAND-P9-OBJ-010` | RightsRecord | `RELATION_DECISION`，绑定 Asset/Content/Evidence | SaaS rights policy + Asset SoR / `OWN-DATA-PRIVACY` | 显示来源、许可、地域、渠道、期限、撤回和影响；在 Asset/Content 详情管理 | 文件存在 ≠ 有权发布/训练/再分发 |

### 3.2 Provider、内容、发布与互动

| Candidate | 候选名称 | 决策 | SoR / Owner | 生命周期与页面承载 | 不得混淆 |
|---|---|---|---|---|---|
| `CAND-P9-OBJ-011` | ProviderConnection | `CONTROL_PLANE_OBJECT` 候选 | SaaS integration control plane / `OWN-SAAS-PLATFORM` | disconnected→authorizing→active→degraded/reauth-required/revoked→removing；canonical Integration Detail | 一个 OAuth account ≠ 一个渠道全部能力 |
| `CAND-P9-OBJ-012` | CapabilityBinding | `CHILD_ENTITY`，依附 ProviderConnection | 同上 / `OWN-SAAS-PLATFORM` | 分别绑定 publish、public interaction、private message、analytics、hosting 等 scope、Workspace 和用途 | connection active ≠ 某能力可用/已授权 |
| `CAND-P9-OBJ-013` | CredentialRef | 复用 `OBJ-FE-024`，不新增对象 | Secret store / `OWN-SAAS-PLATFORM` | UI 只见 masked metadata、scope、到期、轮换状态；永不读回明文 | CredentialRef ≠ ProviderConnection ≠ business account |
| `CAND-P9-OBJ-014` | SyncRun、WebhookDelivery | `WORKFLOW_LEDGER` 候选 | Integration runtime / `OWN-SAAS-PLATFORM` | received/verified/deduped/applied/failed/quarantined；支持回补/redrive/水位 | webhook 2xx ≠ 业务对象已应用；ACK ≠ delivered |
| `CAND-P9-OBJ-015` | MasterContent、LocaleVariant、ChannelVariant | `AGGREGATE_CANDIDATE + CHILD_ENTITY` | SaaS content domain / `OWN-SAAS-PLATFORM` | MasterContent 为候选聚合；语言/渠道变体是有 provenance 的子实体 | 内容变体 ≠ PublishJob；批准内容 ≠ 允许发布 |
| `CAND-P9-OBJ-016` | MediaJob、MediaVariant | `WORKFLOW_LEDGER + CHILD_ENTITY` | SaaS media provider layer / `OWN-SAAS-PLATFORM` | queued/running/partial/succeeded/failed/cancelled；产物成为 Asset/variant 并带 rights | Job 成功 ≠ 素材获批或可公开 |
| `CAND-P9-OBJ-017` | PublishJob | 细分既有 `OBJ-FE-019`；暂不新增正式对象 | SaaS execution domain / `OWN-SAAS-PLATFORM` | draft/authorized/queued/running/partial/succeeded/failed/unknown/cancelled | provider accepted ≠ published/delivered |
| `CAND-P9-OBJ-018` | DeliveryReceipt | `WORKFLOW_LEDGER` 下的 append-only 事实 | SaaS execution domain / `OWN-SAAS-PLATFORM` | 按 target/channel 记录 requested/accepted/delivered/failed/unknown 和 provider key | Campaign 绿色状态不能覆盖局部失败 |
| `CAND-P9-OBJ-019` | PublicInteraction | `AGGREGATE_CANDIDATE` | SaaS public-engagement domain / `OWN-SAAS-PLATFORM` | new/triaged/assigned/replied/hidden/escalated/resolved，保留原平台引用 | 公开评论/提及 ≠ 私密 Conversation |
| `CAND-P9-OBJ-020` | OutboundSequence、OutboundJob | `AGGREGATE_CANDIDATE + WORKFLOW_LEDGER` | SaaS outbound domain / `OWN-SAAS-PLATFORM` | draft/dry-run/authorized/running/paused/completed；逐收件人 suppression/receipt | 一对一触达 ≠ 社交发布；Sequence ≠ Campaign SoR |
| `CAND-P9-OBJ-021` | ConversationProjection | `EXTERNAL_PROJECTION`，不替代 `OBJ-FE-020` | SaaS conversation SoR / `OWN-SAAS-PLATFORM` | Chatwoot/渠道只作 Provider；我方保存稳定映射、同步水位和必要回执 | Provider conversation id ≠ 我方 canonical conversation id |
| `CAND-P9-OBJ-022` | IdentityMatch | `RELATION_DECISION` 候选 | SaaS identity resolution / `OWN-SAAS-PLATFORM` | proposed/confirmed/rejected/split/superseded，记录 Evidence、actor 和影响 | AI 相似度 ≠ 已确认 Company/Contact 归属 |

### 3.3 制造业商机、Site 发布、洞察与退出

| Candidate | 候选名称 | 决策 | SoR / Owner | 生命周期与页面承载 | 不得混淆 |
|---|---|---|---|---|---|
| `CAND-P9-OBJ-023` | RFQ Lite | `REJECT_FOR_CURRENT_SCOPE`；不新增聚合 | 未定位的 SaaS Conversation/Opportunity SoR / `OWN-SAAS-PLATFORM` | Inbox 只消费原始消息/附件、分派、AI 草稿、企业/Offering 上下文和可追踪外部交接；结构化询盘对象须另做研究和合同评审 | 收到询盘 ≠ RFQ 对象 ≠ 工程可行 ≠ Opportunity |
| `CAND-P9-OBJ-024` | TechnicalReview | `PARK + EXTERNAL_PROJECTION` | 客户 PIM/PLM/QMS；平台只存稳定引用/状态 / `OWN-SAAS-PLATFORM` | 规格差异、加工可行性、公差/CAD 签核和工程批准在外部系统完成；本平台显示状态、阻塞和 deep link | AI 提取/摘要 ≠ 工程判断或批准 |
| `CAND-P9-OBJ-025` | SampleRequest | `PARK + EXTERNAL_PROJECTION` | 客户 ERP/PLM/CRM；平台只存引用/状态 / `OWN-SAAS-PLATFORM` | 样品申请、生产、物流、验收深流程留外部系统；只有未来批准的 Conversation/Opportunity 接缝可显示摘要 | 状态投影 ≠ 样品执行 SoR ≠ 买方接受 |
| `CAND-P9-OBJ-026` | QuotationRevision | `PARK + EXTERNAL_PROJECTION` | 客户 CPQ/ERP；平台只存引用/状态 / `OWN-SAAS-PLATFORM` | 定价、成本、审批、税费、条款和报价版本留 CPQ/ERP；平台只显示可见状态/有效期/deep link | 外部报价状态 ≠ Opportunity stage；本轮不建定价引擎 |
| `CAND-P9-OBJ-027` | FactoryAudit / SupplierAssessment | `PARK + EXTERNAL_PROJECTION` | 客户 QMS/PLM/ERP；企业真相只存经批准 Evidence / `OWN-SAAS-PLATFORM` | 深度审核计划、finding、整改和签核留外部系统；平台只显示状态/摘要/关联 Evidence | 外部 assessment ≠ Company/Claim 自动批准 |
| `CAND-P9-OBJ-028` | SiteImportRun | 复用 `CAND-P9-OBJ-002` ImportRun subtype | Site Builder / `OWN-SITE-BE` | crawl/parse/map/review/import；导入结果进入 SiteVersion/Asset/KB | 抓到旧站 ≠ 获得内容/素材权利 |
| `CAND-P9-OBJ-029` | HostingTarget | `CONTROL_PLANE_OBJECT` 候选 | SaaS/Site deployment control / `OWN-SITE-BE` | pending-verification/ready/degraded/disabled/removed；只保存最小连接引用 | BaoTa/1Panel/Coolify 是 Provider，不是 Site/Release SoR |
| `CAND-P9-OBJ-030` | Deployment | `WORKFLOW_LEDGER` 候选 | Site deployment service / `OWN-SITE-BE` | queued/running/succeeded/failed/unknown/rolled-back；固定 Release digest 和 target | Build success ≠ deployment success ≠ public health |
| `CAND-P9-OBJ-031` | DomainBinding、CertificateHealth | `CONTROL_PLANE_OBJECT + READ_MODEL` | Site/control plane / `OWN-SITE-BE` | ownership-pending→verified→provisioning→active/degraded/expired/removing；证书健康可重算 | DNS verified ≠ TLS issued ≠ site content published |
| `CAND-P9-OBJ-032` | MetricDefinition | `REGISTRY_METADATA` | analytics governance / `OWN-QA-EVIDENCE` | version、口径、维度、watermark、质量、隐私、retention 和 Owner | 图表可渲染 ≠ 指标可信 |
| `CAND-P9-OBJ-033` | SavedView、AudienceSegment | `READ_MODEL`；Audience snapshot 需不可变版本 | SaaS domain read models / `OWN-SAAS-PLATFORM` | query/version/owner/scope/refresh state；执行前固定 snapshot | 保存筛选 ≠ 拷贝名单 ≠ Campaign audience authorization |
| `CAND-P9-OBJ-034` | DataExportJob | `WORKFLOW_LEDGER` 候选 | SaaS data-rights/control plane / `OWN-DATA-PRIVACY` | requested/authorized/preparing/ready/expired/failed/cancelled；下载有时限和审计 | 导出生成 ≠ 删除完成；导出副本不再由平台控制 |
| `CAND-P9-OBJ-035` | GuideManifest | `REGISTRY_METADATA` | Docs governance / `OWN-DOC-GOV` | Tutorial/How-to/Reference/Explanation、版本、产品状态、对象/页面/Scenario 关联 | Help article ≠ 产品合同或运行真值 |

### 3.4 停车而不建对象

| Candidate | 决策 | 理由 |
|---|---|---|
| `CAND-P9-OBJ-PARK-001` | 不建通用 `AutomationWorkflow` 聚合 | Temporal/Outbox/Policy 已有清晰边界；自由 Planner 会绕过授权、预算和业务对象 |
| `CAND-P9-OBJ-PARK-002` | 不建 `RFQ Lite`、完整 `Order/Invoice/Inventory/Shipment/AfterSales`，也不建 RFQ 工程评审/CAD 公差签核/样品/报价深流程 | 优先通过 PIM/PLM/QMS/CRM/ERP/MES/CPQ Adapter 关联；本轮只在 Conversation/Opportunity 的未来接缝中保留必要引用、状态投影和 deep link |
| `CAND-P9-OBJ-PARK-003` | 不建 `Creator/Expert/TemplateMarketplace` | 未形成制造业首个价值闭环，且会引入结算、评价、许可和供给侧新产品面 |
| `CAND-P9-OBJ-PARK-004` | 不建前端 `ModelCredential/ModelRoute` 业务对象 | new-api 继续 backend-only；普通用户只消费任务档位，高级别名也由服务端允许列表控制 |

## 4. 关键候选生命周期与不变量

### 4.1 Import

```text
uploaded → mapping → validating → ready
       └→ blocked-needs-input
ready → running → partial | succeeded | failed | cancelled
```

- 每个目标对象使用稳定 source key 和幂等写入；重新映射不能重复创建已成功对象。
- `partial` 必须保留成功行、失败原因和可下载问题清单。
- ImportRun 只能调用 canonical object command；不能成为 Company/Offering/Site 第二 SoR。

### 4.2 Provider connection 与能力绑定

```text
ProviderConnection:
disconnected → authorizing → active → degraded | reauth-required | revoked
                                      └────────→ removing → removed

CapabilityBinding:
unavailable | pending-scope → enabled → suspended | disabled
```

- 连接成功后仍要逐能力验证 scope、Workspace、用途、套餐和 Provider 支持。
- 删除连接先展示受影响的 Campaign、PublishJob、PublicInteraction、Conversation、HostingTarget 和待对账回执。
- Secret 只存 Secret store；UI、Figma fixture、日志和导出均不得包含明文。

### 4.3 社交发布、公开互动与私密会话

```text
Content approved → ExecutionAuthorization → PublishJob
PublishJob accepted → DeliveryReceipt delivered | failed | unknown
Delivered post → PublicInteraction → public reply | hide | escalate-to-private
Private message → Conversation → assignment/SLA → reply receipt
```

四条状态链各有独立 identity、权限和失败恢复。供应商 API 即使把它们放在同一账号下，页面和对象也不得合并。

### 4.4 私密询盘与外部系统接缝

```text
Inbound inquiry/message
→ Conversation projection（保留原文和附件引用）
→ assignment / private reply / internal note
→ optional AI draft or extracted context（人工确认，不覆盖原文）
→ optional Company/Offering context link
→ controlled handoff to customer CRM/PIM/PLM/QMS/ERP/CPQ
→ handoff receipt + external deep link
```

- 当前不创建 RFQ 聚合。Conversation SoR、消息、附件、Owner、SLA、内部备注和外部映射仍需 SaaS 合同；翻译、摘要和 AI 草稿不能覆盖原文。
- 规格差异、加工可行性、公差/CAD 签核、工程批准、样品生产/流转、成本定价和报价版本由客户 PIM/PLM/QMS/ERP/CPQ 拥有；本平台只显示受权状态、阻塞、更新时间和 deep link。
- 附件按最小权限、恶意文件检查、下载审计、保留和外发控制处理；显示外部状态不等于复制工程文件或商业报价。
- Opportunity/QGO/SAO/Outcome 均属于待定位的 SaaS 商机域；不得由 Inbox 或外部系统状态自动推进。

### 4.5 Site 发布、托管与域名

```text
SiteVersion → BuildRun → READY SiteRelease → PublishReview/Authorization
→ Deployment(target, releaseDigest) → public service health
→ DomainBinding verified → Certificate active → traffic switched
```

- 默认发布主路为 immutable Release → object storage/CDN → Caddy/ACME。
- BaoTa、1Panel、Coolify 只作为 Hosting Adapter；其 UI、站点表和证书表不成为我方 SoR。
- Deployment ACK unknown 时按稳定 id/provider key 对账；不得重发已成功发布或错误切流。

## 5. 最终页面族清单（Phase 9 提案）

`PFAM-P9-*` 是 Phase 9 设计分组，不是正式 Page ID。表中每个现有 Page ID 只有一个**主归属**；其他域只能以卡片、Inspector、Drawer 或 deep link 消费。候选子页面在 Gate 前不进入正式导航。

| Page family | 主归属与稳定 Page | 处置 / 产品状态 | canonical 对象/投影 | 新候选子表面 | Figma 占位 |
|---|---|---|---|---|---|
| `PFAM-P9-001` Public Marketing & Trust | 无现有 Page；Shell 外 | `New / PROPOSED` | public Content/Claim projections | 首页、制造业方案、价格、案例、信任中心、联系/注册转化 | `CAND-P9-FIG-PF-001` |
| `PFAM-P9-002` Identity & Account Access | `PAGE-FE-001` | `Split + Deepen / TARGET_EXTERNAL` | Account/Session projection | 注册、验证、找回、MFA、邀请接受、锁定/恢复 | `CAND-P9-FIG-PF-002` |
| `PFAM-P9-003` Workspace & Product Onboarding | `PAGE-FE-002` | `Split + New / TARGET_EXTERNAL` | Workspace/Membership + onboarding progress | 创建 Workspace、目标选择、安全 Demo、Import Center | `CAND-P9-FIG-PF-003` |
| `PFAM-P9-004` Today & Coordination | `PAGE-FE-003..009` | `Keep + Deepen / TARGET_EXTERNAL` | Search/Task/Approval/Notification/Incident/Run projections | 对象工作队列、Saved View、批量指派、恢复面板 | `CAND-P9-FIG-PF-004` |
| `PFAM-P9-005` Help, Docs & Support | `PAGE-FE-010` | `Split + New / PROPOSED` | GuideManifest/Status projection | Tutorial、How-to、Reference、Explanation、Changelog、Status、支持诊断 | `CAND-P9-FIG-PF-005` |
| `PFAM-P9-006` Enterprise Truth, Offerings & Knowledge | `PAGE-FE-020..026` | `Keep + Deepen / AS_BUILT_SUBSET` | Company/Profile/Offering/Claim/Evidence/KnowledgeSource/Asset | 通用企业与产品资料、文件和事实审核；行业字段通过动态引导、KB 抽取和 Offering attributes 出现，不建固定规格库或独立准备度页 | `CAND-P9-FIG-PF-006` |
| `PFAM-P9-007` Site Portfolio, Intake & Trust | `PAGE-FE-030..039` | `Keep + Deepen + New / SPEC_READY_WITH_BLOCKERS` | Site/Profile/Asset/KB/Claim | Site Import、迁移问题、引用/删除影响 | `CAND-P9-FIG-PF-007` |
| `PFAM-P9-008` Site Build, Design & Preview | `PAGE-FE-040..047` | `Keep + Deepen + Split / current + approved-not-built` | BuildRun/SiteVersion/Release/Copy/Design | 局部重建、设计智能、QA、结构/内容/主题工作台 | `CAND-P9-FIG-PF-008` |
| `PFAM-P9-009` Site Release, Hosting & Domain | `PAGE-FE-048..052` | `Split + Deepen / TARGET_NOT_RUNNABLE` | SiteRelease/Deployment/HostingTarget/DomainBinding | PublishReview、发布/回滚、托管目标、域名/TLS、切流 | `CAND-P9-FIG-PF-009` |
| `PFAM-P9-010` Site Inquiry, Analytics & Maintenance | `PAGE-FE-053..056` | `Keep + Deepen / DEFERRED` | Inquiry target、Metric projection、DiagnosisRun | 表单路由/隐私、投递回执、站点分析、诊断/维护 | `CAND-P9-FIG-PF-010` |
| `PFAM-P9-011` Generated Manufacturing Site | `PAGE-FE-057` | `Keep + Deepen / PARTIAL_AS_BUILT_TARGET_SPECIFIED` | approved public Release | 使用经审核资料生成企业/产品/能力/信任内容和有同意的通用询盘入口；不使用 SaaS Shell，不承诺在线工程签核/报价 | `CAND-P9-FIG-PF-011` |
| `PFAM-P9-012` Market & Buyer Development | `PAGE-FE-060..066` | `Keep + Deepen + Split / FROZEN_MAP_ONLY` | ICP/Company/Lead/Package/Suppression | identity、signals、contacts、reachability、sanctions、Package/ACK、rights | `CAND-P9-FIG-PF-012` |
| `PFAM-P9-013` Goal, Campaign & Audience | `PAGE-FE-070..074` | `Keep + Deepen / TARGET_EXTERNAL` | Goal/Campaign/Audience/Approval/Authorization | Campaign Canvas、快照、Dry Run、差异批准 | `CAND-P9-FIG-PF-013` |
| `PFAM-P9-014` Content & Media Studio | `PAGE-FE-075..076` | `Split + New / PROPOSED` | MasterContent/variants/MediaJob/Asset/Rights | 多语言、渠道变体、图片/媒体 Job、事实/权利审核 | `CAND-P9-FIG-PF-014` |
| `PFAM-P9-015` Social Distribution | `PAGE-FE-077..079` | `Split + Deepen / TARGET_EXTERNAL` | PublishJob/DeliveryReceipt/connection projection | 日历、发布详情、逐渠道回执、任务上下文账号 | `CAND-P9-FIG-PF-015` |
| `PFAM-P9-016` Public Engagement | 无现有 Page | `New / PROPOSED` | PublicInteraction | 评论/提及队列、公开回复、审核、升级私聊 | `CAND-P9-FIG-PF-016` |
| `PFAM-P9-017` Direct Outbound | 无现有 Page | `New / PROPOSED` | OutboundSequence/Job、recipient receipt | 序列、逐收件人 Dry Run、抑制、暂停/恢复和对账 | `CAND-P9-FIG-PF-017` |
| `PFAM-P9-018` Private Inbox & Conversation | `PAGE-FE-080..081` | `Keep + Deepen / TARGET_EXTERNAL` | Conversation/Message/IdentityMatch projection | 队列、分派/SLA、翻译、内部备注、AI 草稿、回复回执和企业/Offering 上下文；不新增 RFQ 聚合 | `CAND-P9-FIG-PF-018` |
| `PFAM-P9-019` Opportunity | `PAGE-FE-082..083` | `Keep / TARGET_EXTERNAL + CONTRACT_BLOCKED` | Opportunity projection | Owner、阶段、下一动作和来源会话引用；对象/状态/API 未定位前不补 RFQ 或工程生命周期 | `CAND-P9-FIG-PF-019` |
| `PFAM-P9-020` Insight, Attribution & Cost | `PAGE-FE-084..086` | `Keep + Deepen / TARGET_EXTERNAL` | MetricDefinition/read models + Site spend facts | 指标字典、水位/质量、对象下钻、成本来源 | `CAND-P9-FIG-PF-020` |
| `PFAM-P9-021` Team, Delegation & Personal Settings | `PAGE-FE-090/091/093` | `Keep + Deepen + New / TARGET_EXTERNAL` | Membership/Role/Entitlement/PersonalProfile | 邀请、委派、数据范围、个人通知/语言/会话设置 | `CAND-P9-FIG-PF-021` |
| `PFAM-P9-022` Integrations, Providers & Developer | `PAGE-FE-092` | `Split + New / PROPOSED + TARGET_EXTERNAL` | ProviderConnection/CapabilityBinding/CredentialRef/SyncRun | Catalog、连接详情、scope、健康、Webhook/API Key、同步、导出/退出 | `CAND-P9-FIG-PF-022` |
| `PFAM-P9-023` Security, Billing & Data Exit | `PAGE-FE-094..095` | `Keep + New / TARGET_EXTERNAL` | Audit/Entitlement/Billing/DataExportJob | 会话/MFA/审计、套餐/额度/账单、导出、账户关闭 | `CAND-P9-FIG-PF-023` |
| `PFAM-P9-024` Platform Operations | `PAGE-FE-096` | `Keep + Deepen / TARGET_EXTERNAL + BACKEND_ONLY` | Provider/model/source/event/incident projections | model policy、Provider/source policy、Webhook/ACK、redrive、清理和事故 | `CAND-P9-FIG-PF-024` |

稳定 Page ID 覆盖核对：

```text
001 + 002 + 003..009 + 010
+ 020..026
+ 030..039 + 040..047 + 048..052 + 053..056 + 057
+ 060..066
+ 070..074 + 075..076 + 077..079
+ 080..081 + 082..083
+ 084..086
+ 090/091/093 + 092 + 094..095 + 096
= 76 / 76
```

## 6. 页面所有权、路由与 UI 形态规则

### 6.1 一级 IA 不因新增页面族膨胀

Phase 9 完整管理员侧栏已按 `DEC-FE-P9-020` 有条件批准为 8 个一级/38 个二级：今日、企业资料、客户开发、独立站、增长执行、互动与商机、洞察七个业务域，以及独立的“管理与设置”入口。任务、审批、通知、长任务、事故、帮助和对象 Inspector 是横向能力；个人设置、平台运营和公共产品表面仍不混入业务导航。精确二级和对象 Tab 以 `AUD-FE-P9-006` 为准；候选二级页仍受各自合同门约束，不因 IA 批准而变成可用能力。

- Public Marketing、Identity、Help/Developer public docs 和 Generated Manufacturing Site 位于 SaaS Shell 外。
- Public Engagement 与 Direct Outbound 进入“增长执行”或“互动与商机”的任务上下文，不新增供应商/渠道命名的一级导航。
- Provider、new-api、Aitoearn、Chatwoot、BaoTa、Postiz、1Panel、Coolify 等名称只在连接/运营详情中出现，不成为产品域。

### 6.2 canonical page 与投影

| 对象/投影 | canonical 页面族 | 其他页面如何消费 |
|---|---|---|
| Company/Profile/Offering/Claim/Evidence/Asset/Knowledge | `PFAM-P9-006` | Site、Campaign 和 Inbox 只读 snapshot、Evidence Drawer 和深链；行业深层数据回客户 PIM/PLM/ERP |
| Site/Version/Build/Release | `PFAM-P9-007..009` | Today/Insight/Incident 展示摘要并深链 |
| ICP/Lead/Package | `PFAM-P9-012` | Campaign Audience、Opportunity 只引用稳定 identity/package |
| Campaign/Audience | `PFAM-P9-013` | Content/Publish/Insight 展示上下文 |
| MasterContent/Media | `PFAM-P9-014` | Campaign/Publish 选择版本，不能内联复制主稿 |
| PublishJob/Receipt | `PFAM-P9-015` | Campaign、Public Engagement、Insight 投影 |
| PublicInteraction | `PFAM-P9-016` | Conversation 只接收显式升级后的关联 |
| Conversation/Message | `PFAM-P9-018` | Opportunity 只展示原始消息引用和经确认摘要 |
| Opportunity | `PFAM-P9-019` | Inbox/Buyer/Insight 只投影状态、Owner 和下一动作；工程/样品/报价仅在未来批准的外部映射中显示 deep link |
| ProviderConnection/Binding | `PFAM-P9-022` | 渠道账号、Site hosting、Inbox 只显示 capability health 和深链 |
| MetricDefinition | `PFAM-P9-020` 或受控 registry | 任何图表显示定义、水位、质量和下钻链接 |

### 6.3 页面、面板和 Drawer 的选择

- 有独立生命周期、稳定 deep link、跨会话恢复或复杂权限的对象使用页面/子路由。
- Evidence、对象摘要、Provider 健康、使用影响和快速批准可用 Inspector/Drawer，但必须能复制 canonical deep link。
- 三步以内、无独立身份且不能跨会话恢复的动作使用对话框；导入、连接、发布和多附件处理不得压成一次 Modal；工程技术评审在外部系统完成。
- Today、Search、Inbox 和 Ops 可使用 master-detail，但详情仍指向 canonical object，刷新和新标签页不能丢失上下文。
- 移动端优先审批、分派、监控和快捷回复；产品关键参数编辑、Site editor、批量映射提供明确桌面接力；复杂工程评审跳转客户 PIM/PLM/QMS/ERP/CPQ。

## 7. Page Manifest 2.0 候选合同

每个 `PFAM-P9-*` 进入正式设计前，至少为每个 distinct page/route 补以下字段：

| 字段 | 要求 |
|---|---|
| `candidate_page_key` | 继续使用 `CAND-P9-*`，批准前不得占 `PAGE-FE-*` |
| `family/area/shell_mode` | 页面族、七个一级业务域/management/utility/public、full shell/management/compact/no shell；二级与对象 Tab 见 `AUD-FE-P9-006` |
| `primary_actor/job/outcome` | 首要角色、任务和完成结果；不是功能列表 |
| `canonical_object/sor/social_class` | 对象、唯一 SoR、数据社会属性和敏感字段 |
| `route/deep_link/object_context` | 稳定 ID、Workspace、返回上下文和跨域链接 |
| `entry/exit/primary_action` | 从哪里进入、主动作、完成/取消/失败后去哪 |
| `allowed_actions/entitlement` | 服务端来源、禁用与拒绝原因、升级/请求路径 |
| `business/task/sync/evidence/freshness` | 五条状态轴分开；不能一个 badge 概括 |
| `contracts/events/idempotency` | operationId/event/schema、ACK、回执、去重、补偿或 `NONE/BLOCKED` |
| `states/recovery` | normal/empty/loading/waiting/partial/degraded/stale/conflict/denied/offline/unknown/cancel/late result |
| `scenario/fixture/metric/guide` | 验收、压力数据、指标/反指标和 Diátaxis 指南 |
| `figma_node/variant/responsive/a11y` | 受控 Node、状态/密度/长文本、断点、键盘和 WCAG 证据 |
| `owner/product_status/last_verified` | 只使用已登记 `OWN-*`；多轴状态和核验日期 |

## 8. 进入正式 Registry 的 Gate

候选对象或页面族只有同时满足下列条件，才可申请正式 ID：

1. 证明现有对象/Page 不能安全承载，且不存在同义对象；
2. 产品 Owner 批准用户结果、范围、非目标和路线优先级；
3. Object Owner 批准 SoR、identity、生命周期、并发、删除/退出和社会属性；
4. SaaS Platform/数据/安全批准 allowed actions、隐私、Secret、审计和 Provider 退出；
5. 合同有机器 schema/operation/event，或明确标记 `NONE/BLOCKED`；
6. Scenario、压力 Fixture、Metric/反指标、Guide 和 Figma Node 可追踪；
7. 正式前端 repo、设计事实源、实现/QA/Ops Owner 和发布证据门已定位；
8. 对至少一个真实制造业目标角色完成任务验证；竞品可用性不替代用户证据。

本评审的当前结论为：

- 35 个候选对象中，只有 PublicInteraction、OutboundSequence、MasterContent、ProviderConnection 等少数具备“未来聚合根候选”理由；`ProductFamily/ProductModel/Certification/CapacityProfile/ReadinessAssessment/RFQ Lite` 均不作为 current 独立对象。制造业差异通过通用 Profile、Offering attributes、Asset/KB、Claim/Evidence 和动态表单元数据承载。
- Import、Media、Publish、Deployment、DataExport、Sync/Webhook 属 workflow/ledger，不应污染业务对象状态。
- Aitoearn、Chatwoot、BaoTa 及其替代项始终经 ProviderConnection/CapabilityBinding 进入，不取得业务 SoR。
- 完整 RFQ 工程技术评审、公差/CAD 签核、工程批准、样品和报价深流程保持 `PARK / INTEGRATION_FIRST`，优先对接客户 PIM/PLM/QMS/ERP/CPQ；Inbox 只设计通用私密会话和受控外部交接。
- 24 个 `PFAM-P9-*` 已覆盖现有 76/76 Page ID，并补出公共站、公开互动和直接触达三个确实缺失的页面族；Opportunity 保留原页面族但为 `TARGET_EXTERNAL/CONTRACT_BLOCKED`，不补造 RFQ 对象。
- 本文件仍为 `DRAFT`。正式对象、Page ID、路由、Schema 和前端任务必须在后续 Gate 独立批准。
