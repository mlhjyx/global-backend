# product-scope —— 产品范围、价值与边界（L0/L1 模块层 · why 权威）

> 文档 ID：`DOC-PRODUCT-001`
> 生命周期：`CURRENT`
> 当前事实来源：[当前状态](status/current.md) · [as-built 架构](architecture/current.md) · [路线](roadmap/release-plan.md)
> 2026-07-10 v2（合流定稿）。上游基底：[docs/platform/](platform/) 两份交付包 docx（《顶层产品与系统架构设计 v1.0》=L1、《文档体系重构方案 v1.0》=文档治理，均「待批准评审稿」）；两份 v3.0 Word 已冻结为研究综合稿。产出方法：12 视角全平台设计 × Codex as-built 代码审计 × 交付包（TA-001 至 TA-012 / OD-01 至 OD-06）三方收敛 + 双员对抗审查。
> 本仓 as-built 架构见 [architecture/current.md](architecture/current.md)；决策注册表见 [adr/registry.md](adr/registry.md)；当前状态与待拍板见 [status/current.md](status/current.md)；路线见 [roadmap/release-plan.md](roadmap/release-plan.md)。
> **2026-08-04 补**：本文主体定义**获客后端**产品范围（止于 LeadQualifiedPackage）。获客侧冻结已解除，Site Builder M1 也已完成阶段收口；下一施工任务须重新审计后选择，产品边界不变。Site Builder 范围/边界/决策见本文 §4A、[status/current.md](status/current.md)、「活文档」[site-builder/](site-builder/) 00–14 和 [adr/registry.md](adr/registry.md) **ADR-013~019**。

## 0. 术语表

| 术语                     | 意思                                                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ICP**                  | 理想客户画像——客户告诉系统「我要找什么样的买家」（行业/国家/规模/排除条件/买家委员会角色）                                                                       |
| **Lead / 线索**          | 「某家公司 × 某个 ICP」的候选评估对象，带六维评分与四队列（推荐/待确认/拒绝/禁止）                                                                               |
| **LeadQualifiedPackage** | 本仓最终交付物：一条合格线索的**不可变快照包**（公司是谁+证据+评分+联系人+合规结论+建议动作），以事件发给 SaaS 平台                                              |
| **QGO**                  | 合格增长商机（北极星单位）——SaaS 平台把合格线索确认成的「值得销售跟进的机会」                                                                                    |
| **SAO**                  | 销售接受的商机——销售正式认领 QGO 并开始推进                                                                                                                      |
| **Suppression**          | 全局禁联名单——退订/投诉/删除请求过的对象，任何对外动作前第一道检查                                                                                               |
| **Reachability**         | 可达性——有没有验证过的联系方式；联系不上的公司分再高也不进推荐队列                                                                                               |
| **Evidence / 证据**      | 每个关键字段都记录「从哪来、什么时候、什么许可、多可信」，可回溯可删除                                                                                           |
| **DSR**                  | 数据主体请求——欧盟个人依法要求查看/删除其数据，必须能精确执行                                                                                                    |
| **Budget Grant**         | SaaS Control Plane 对单次 Site Builder BuildRun 签发的一次性、短期、请求绑定费用授权；本仓验签并执行 durable reserve/settle/reconcile，不拥有订阅或 Credits 主账 |

## 1. 产品是什么

面向中国 B2B 出海企业的**海外增长机会操作系统**。主承诺（手册 §2.4 原文）：

> 客户告诉平台自己卖什么，平台主动判断去哪、找谁、为什么值得联系、如何表达、在哪些渠道执行，并把真实互动转成销售可接受的机会。

产品内核不是功能集合（研究+内容+视频+发布+Inbox），而是：

> **把客户模糊的出海目标，转化为有需求证据、身份可信、可联系、合规可用、销售愿意接手的海外客户机会，并用结果反馈持续提高机会质量。**

四问：① 去哪里（哪个市场值得进）② 找谁（哪些企业和角色匹配）③ 为什么现在（需求/意图/时机证据）④ 下一步怎么做（合法可达路径+证明有效）。

## 2. 北极星与指标

- **北极星：每活跃 Workspace 每月新增 QGO**（D-021）；**SAO 作为商业验证层指标**，M3 商业化时升格为 Gate。
- 质量护栏：QGO→SAO 接受率、错误身份率、证据覆盖率、新鲜度、Reachability、7/30/90 天 Outcome 回写率、重复/失效率。
- 效率：首次有效账户时间、首次 QGO 时间、单位 QGO/SAO 成本。
- 风险护栏：退信/投诉率、Suppression 越权数（恒 0）、数据权利违规数（恒 0）。

## 3. 五阶段用户价值旅程与七个 bounded context

产品价值旅程与系统 ownership 是两个不同视图，不能用“层数”代替实现状态。

### 3.1 五阶段用户价值旅程

```text
可信基础
→ 增长目标
→ 发现与资格
→ 商机推进
→ 学习与改进
```

这条旅程描述用户价值，不表示五个阶段已实现或已上线。首发闭环聚焦“可信基础 → 发现与资格 → 人工 QGO 判断”；商机推进和结果学习由 SaaS Program C 持有主状态。

### 3.2 七个 bounded context 与当前证据边界

以下详细状态使用[唯一七轴模型](governance/terminology-and-status.md#6-多轴交付状态)：`PRODUCT / UX / SOURCE / TEST / RUNTIME / RELEASE / PILOT_GA`。`UAT` 是用户验收证据限定词，不是第八轴；所有 `*_EVIDENCE / *_GAP / *_QUALIFIER` 只解释基态，不改变本表的 SoR 或授权真值。

| Bounded context | 唯一 SoR / 产品边界 | 当前七轴基态 + UAT/限定词 |
|---|---|---|
| SaaS Control Plane | SaaS 拥有身份、Organization、Workspace、Membership、Billing/Credits 与 Site Builder Budget Grant 签发 | `PRODUCT=APPROVED; UX=NONE; SOURCE=PARTIAL_AS_BUILT; TEST=NOT_RUN; RUNTIME=NO_TRUSTED_OBSERVATION; RELEASE=UNVERIFIED; PILOT_GA=NOT_AUTHORIZED; UAT=NOT_RUN; UX_GAP=NO_VERIFIED_UX; SOURCE_EVIDENCE=LOCAL_SOURCE_AUTHORITY_FOUND; RELEASE_GAP=REMOTE_CI_RELEASE_UNVERIFIED` |
| Growth Strategy | SaaS 拥有 Goal、GrowthInitiative、OfferingSnapshot、MarketThesis、ICPVersion 与 Pack Snapshot | `PRODUCT=APPROVED; UX=NONE; SOURCE=NOT_IMPLEMENTED; TEST=NOT_IMPLEMENTED; RUNTIME=NO_TRUSTED_OBSERVATION; RELEASE=NOT_IMPLEMENTED; PILOT_GA=NOT_AUTHORIZED; UAT=NOT_RUN; PRODUCT_EVIDENCE=APPROVED_PHASE_0_SPEC; UX_GAP=NOT_IMPLEMENTED` |
| Buyer Intelligence | 本仓拥有采集、Identity/Canonical、Evidence、数据权利、Signal、Reachability 与资格输入 | `PRODUCT=APPROVED; UX=NONE; SOURCE=AS_BUILT; TEST=NOT_RUN; RUNTIME=NO_TRUSTED_OBSERVATION; RELEASE=UNVERIFIED; PILOT_GA=NOT_AUTHORIZED; UAT=NOT_RUN; UX_GAP=NOT_IMPLEMENTED; TEST_QUALIFIER=CURRENT_SCOPE_NOT_RUN` |
| Qualification & Handoff | 本仓止于不可变 `LeadQualifiedPackage + Outbox/ACK`；SaaS Program C 独占服务端 consumer/receipt/snapshot 事务 | `PRODUCT=APPROVED; UX=NONE; SOURCE=PARTIAL_AS_BUILT; TEST=NOT_IMPLEMENTED; RUNTIME=NO_TRUSTED_OBSERVATION; RELEASE=UNVERIFIED; PILOT_GA=NOT_AUTHORIZED; UAT=NOT_RUN; UX_GAP=NOT_IMPLEMENTED; SOURCE_EVIDENCE=BACKEND_PRODUCER_AS_BUILT; SOURCE_GAP=PROGRAM_C_CONSUMER_NOT_IMPLEMENTED; TEST_GAP=PROGRAM_C_NOT_IMPLEMENTED; RELEASE_GAP=BACKEND_UNVERIFIED,PROGRAM_C_NOT_IMPLEMENTED` |
| Opportunity & Sales | SaaS Program C 拥有单一 Opportunity 聚合及 QGO/SAO/CLOSED、SalesAcceptance、CommercialOutcome、Conversation linkage | `PRODUCT=APPROVED; UX=FLOW_ONLY; SOURCE=PARTIAL_AS_BUILT; TEST=NOT_IMPLEMENTED; RUNTIME=NO_TRUSTED_OBSERVATION; RELEASE=NOT_IMPLEMENTED; PILOT_GA=NOT_AUTHORIZED; UAT=NOT_RUN; PRODUCT_EVIDENCE=APPROVED_PHASE_0_SPEC; UX_QUALIFIER=LOCAL_SOURCE_OBSERVED; SOURCE_EVIDENCE=LOCAL_SOURCE_AUTHORITY_FOUND; SOURCE_GAP=CANONICAL_AGGREGATE_NOT_IMPLEMENTED` |
| Growth Execution | SaaS/执行系统拥有 Campaign、ExecutionAuthorization、Content、Outreach、Publish 与 provider loop | `PRODUCT=NOT_OFFERED; UX=FLOW_ONLY; SOURCE=PARTIAL_AS_BUILT; TEST=NOT_IMPLEMENTED; RUNTIME=NO_TRUSTED_OBSERVATION; RELEASE=NOT_IMPLEMENTED; PILOT_GA=NOT_AUTHORIZED; UAT=NOT_RUN; PRODUCT_QUALIFIER=CURRENT_MVP; UX_QUALIFIER=LOCAL_SOURCE_OBSERVED; SOURCE_EVIDENCE=LOCAL_SOURCE_AUTHORITY_FOUND; SOURCE_GAP=CANONICAL_IMPLEMENTATION_NOT_IMPLEMENTED; RELEASE_GAP=REMOTE_CI_RELEASE_UNVERIFIED` |
| Learning & Economics | SaaS 拥有 Touchpoint、Attribution、Feedback、Experiment、ROI 主状态；本仓只接收结构化学习标签并保留域内成本事实 | `PRODUCT=APPROVED; UX=NONE; SOURCE=NOT_IMPLEMENTED; TEST=NOT_IMPLEMENTED; RUNTIME=NO_TRUSTED_OBSERVATION; RELEASE=NOT_IMPLEMENTED; PILOT_GA=NOT_AUTHORIZED; UAT=NOT_RUN; PRODUCT_EVIDENCE=APPROVED_PHASE_0_SPEC; UX_GAP=NOT_IMPLEMENTED` |

横切控制仍包括 Evidence、Data Rights、Policy、Suppression、Budget、Approval、Audit、幂等、Temporal、Outbox、Trace 与 Eval。执行层、商机域、Pack 和前端 IA 的详细设计输入见附录 A；它们不扩大本仓边界。

## 4. 本仓边界（获客情报后端）【已拍板 2026-07-10】

- **本仓 = 买家智能与机会资格引擎**：Understand → Target → Discover → Qualify → **LeadQualifiedPackage 交付**（=交付包 TA-007）。
- 本仓**不建、任何时候也不在本仓新增**：身份/用户/角色、Campaign、发送/触达、Conversation/Inbox、Opportunity/QGO/SAO、归因。SaaS 消费 `LeadQualified` 事件创建 Opportunity（CANDIDATE 态）；成交结果（QgoCreated/SalesAccepted/CommercialOutcomeVerified/LeadOutcomeRejected）**只回流为质量学习标签**，QGO 主状态不复制回本仓。
- **存储侧合规必须留在本仓**（个人数据在摄取/富集时已发生处理）：Data Rights、PII 分类、保留期、Suppression、DSR 删除。发送侧合规、Approval、ExecutionAuthorization 由 SaaS/执行系统负责，但**消费本仓的政策结论**。
- 边界判据一句话：动「人、权、审、发、看」不进本仓；动「挖、并、证、分、存」是本仓。
- **改边界的唯一途径**：修订 ADR-001 并经 A/B/业务负责人三方书面确认——不存在其他「过流程就能加」的后门。
- **身份归属（已拍板）与两条硬规矩**：身份 SoR 维持在 A（独立库），本仓只 JWKS 验签；为拦住交付包 AR-01/AR-02 风险，锁定：① **A 的库永远不存业务对象**——Company/ICP/Lead/Campaign/Opportunity/QGO 唯一主数据在增长库；② **权限执行点在服务端**（B 层 claims→scopes），任何接口不信任前端提交的 role。详见 ADR-011。

## 4A. Site Builder 产品面与当前边界【2026-07-24 真值】

- **本仓负责**：注册建站、建站档案/素材/知识库、SiteSpec、固定 DAG 的 Temporal 构建、封闭组件渲染、预览与后续不可变 Release/发布能力；AI 只能执行有界 Task，不使用自由 Planner。
- **外部 SaaS 负责**：身份、Workspace 控制面、完整产品 UI、运营/商机/成交。Site Builder 不改变 ADR-001 对获客交付边界的定义。
- **费用权威接缝（ADR-024）**：SaaS 是 subscription、Billing 与 Credits 的 SoR，并为正常产品 BuildRun 签发一次性 Budget Grant；本仓只验证 workspace/operation/request/cap（已有 Site 时也验证 site）、原子消费授权、执行持久预算账本并追加结算/对账。Backend 不另设隐藏的产品总金额门，产品 Grant 也不授权 Codex/operator 的 ad-hoc/evaluation 调用。
- **环境语义（ADR-024）**：development、pilot、production 采用同一产品运行路径和不可变制品；凭据、JWKS、endpoint、数据、资源和网络暴露可以独立配置，但不得替换业务实现、验证、持久化、费用、错误或 readiness 语义。测试替身与 fixture 不进入产品 composition root、Release 或用户站点。
- **as-built 审计基线**：M0、R0–R4、M1-c、M1-d、R1-min、DI-0、M1-e-A 与 M1-e-B 均已进入主线。Demo v0 固定 `SiteSpec 1.0` / ReleaseManifest v1；受控精装修链使用 `SiteSpec 1.1` / ReleaseManifest v2，旧版本保持双读兼容且不后台迁移。
- **当前状态**：M1-e-B/M1-f 已完成六个 approved Family、受控组装与确定性质量循环；M1-g 已完成 12 视觉集、确定性发布门和文本候选报告，未过门候选不切路由。获客线可在重新审计、明确 owner/验收后恢复实现；两条线不混改共享 ownership。
- **权威规则**：承重决策只进 ADR-013~020；具体产品/施工真值在 Site Builder 00–14、当前状态和路线。v3.1/v3.2、旧 Word 和研究稿是历史输入，不得直接覆盖活文档或代码。

## 5. 业务层级四层（PDR-002，已收敛=交付包 TA-003，待 A/B 会签）

```
Goal（业务目标：如进入德国市场）
 → GrowthInitiative（围绕目标的持续增长计划，贯穿研究→ICP→发现→资格→Campaign→结果）
   → OfferingSnapshot + MarketThesis + ICPVersion
   → DiscoveryRun / CandidateBatch → Account + ContactRole + Signal + Evidence
   → QualificationDecision → Opportunity（单一聚合；CANDIDATE→QGO→SAO→CLOSED 为状态）
   → CommercialOutcome（追加式结果事实）→ Feedback/Experiment
 → Campaign（Initiative 下游的执行实例，不拥有 Company/Signal/Opportunity）
   → Run/Batch/Job（某次实际执行：技术状态、重试、幂等、成本、回执）
```

对本仓的当下含义：discovery/enrichment/intent 管线不依赖 campaign_id（现状已如此，保持）；本仓事件预留 `initiativeId?` 字段。

## 6. 团队 ownership 与四接缝

| 方                                     | 拥有                                                                                                                         |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A（SaaS 平台）                         | 身份/登录/角色、全部 UI、Campaign/触达/Inbox、Opportunity(QGO/SAO)/归因、Billing/Credits SoR、Site Builder Budget Grant 签发 |
| B（接口层，同库）                      | JWKS 与 Budget Grant 校验、controller/DTO、OpenAPI 契约、事件拉取端点、roles→scopes 映射                                     |
| Codex（本仓当前开发主体；用户 C 拍板） | Company/ICP/Discovery/Identity/Signal/Contact/Lead/Suppression 应用服务 + Temporal 编排 + 存储侧合规                         |

四接缝：① **JWKS**——A 签发登录凭证、我们只验签解出租户；② **Budget Grant**——A 对正常产品 BuildRun 签发短期、一次性、workspace/operation/request 绑定金额授权（已有 Site 时也绑定 site），本仓不签发、不扩额；③ **事件出口**——合格线索以事件包交付，SaaS 拉取并 ACK，Site Builder 费用摘要通过事务性 Outbox 回报；④ **OpenAPI**——契约由代码自动生成、唯一真值，不造 mock；**关键 Schema（LeadQualified 快照、事件信封、统一信封、Budget Grant）在实现前先经 B/A 评审**，code-first 仍是生成事实源。技术细节见 [architecture/current.md](architecture/current.md) §6-§7。

## 7. 首个商业切口

- 经济购买者=外贸老板/出海负责人；操作者=海外增长/外贸销售/数据运营。
- 首发客户：中国 B2B 制造、工贸一体和高客单传统出口企业。首发 Job 固定为发现有真实需求证据的海外进口商/采购商，并把至少一个候选推进到人工 QGO 判断；经销商招募属于后续 Job。
- 交付模式：Managed/Collaborative 起步，逐步 Self-service。
- MVP 假设：「对上述企业，输入官网、产品和目标市场后，平台在可解释成本内持续产出有证据、可联系的海外进口商/采购企业，并在 **30 天内形成至少一个人工确认 QGO**。」北极星保持“每活跃 Workspace 每月新增 QGO”，SAO 只作为后续商业验证。
- 首版不做：4 个发布平台、完整视频、全渠道 Inbox、专家市场、多行业同时商业化、多触点归因。
- 客户 subscription、Billing、Credits、usage 与 pricing 的独立状态为 `PRODUCT=DEFERRED; UX=NONE; SOURCE=NOT_IMPLEMENTED; TEST=NOT_IMPLEMENTED; RUNTIME=NO_TRUSTED_OBSERVATION; RELEASE=NOT_IMPLEMENTED; PILOT_GA=NOT_AUTHORIZED; UAT=NOT_RUN; UX_GAP=NOT_IMPLEMENTED`；`cap_microusd` 只是平台执行安全包络，不是客户余额、quota、价格、Credit 或发票。

## 8. 文档权威关系

1. 两份 v3.0 Word=冻结的研究综合稿（权威链断裂：自称待批准且母本 v2.1 不在仓库）。
2. [docs/platform/](platform/) 交付包=L0/L1 全平台基底（待批准评审稿）；本文件+architecture+adr 是其获客模块层实现。
3. 本仓范围与分工：本文件。当前完成度：[status/current.md](status/current.md) + 代码 + 真实验证（roadmap 已降级为 [roadmap/changelog.md](roadmap/changelog.md)）。
4. API：code-first 导出的 `packages/contracts/openapi/openapi.json` 唯一 REST 真值（旧 openapi.yaml 链路已删除，收口④完成）；SiteSpec 类型真值为 `@global/contracts`（DQ-1/#117）。
5. TED/openFDA spec：以其「审查修正」章节+代码为准，已降级为 [implementation-records/](implementation-records/)。

## 9. 决策记录（2026-07-10）

**已拍板**【用户】：① 边界止于 LeadQualifiedPackage（QGO 归 SaaS）；② 身份归属维持 A（+ADR-011 两条硬规矩）；③ 设计类产出先评审后进仓；④ 收敛方案与交付包合流。
**与交付包裁决对照**：TA-001/002/004/008/009 采纳；TA-003=PDR-002；TA-005 逻辑 Schema=演进方向；TA-006/OD-01/OD-02 按身份拍板修正采纳；TA-007/OD-03=ADR-001；TA-010/011/OD-05=PDR-003；TA-012/OD-06=本次文档迁移；OD-04（Policy 宿主=横向平台模块）方向认可，现阶段以本仓 PolicyPort/DataRightsService 为其获客侧实现。
**本稿裁定**：北极星保 QGO、SAO 作商业验证层；研究域最小版列 R3 可选；Docling/Langfuse 不进封版 Gate。
**当前待办与待拍板**：统一见 [status/current.md](status/current.md)；获客侧冻结已解除且 Site Builder M1 已完成阶段收口。任何事项进入施工序前仍须重新核验当前价值、代码与服务状态、owner、合规、成本、依赖和验收证据，解冻本身不构成实现、费用、部署、发布或合并授权。

---

## 附录 A 全平台设计输入（给 A/B 的上下文地图，实现不在本仓）

> 源自 12 视角设计，浓缩保留。与正文冲突处以正文为准（商机域已按单一 Opportunity 聚合修订）。

1. **执行层**（SaaS/执行系统侧）：Campaign=协调上下文非聚合根（对象独立表+campaignId 外键；Audience=Query Snapshot 消费本仓 lead 队列；11 态状态机；APPROVED 时一次性签发不可变 ExecutionAuthorization）。**OutboundBroker** 镜像本仓 ToolBroker（授权→Suppression 逐条重查→Policy→频控→幂等→审计）。邮件最小版=Gmail/Graph 用户授权发送（零发送基建；SPF/DKIM/DMARC 日检；DSN 轮询→Suppression；List-Unsubscribe；回复经 In-Reply-To 关联）。Build-vs-integrate：图文/邮件文案自建薄层；社交=AiToEarn 三 Provider 契约（失败 Plan B=1-2 个官方 API 直连，绝不浏览器自动化）；聊天=Chatwoot（失败 Plan B=自建三表）。顺序：Campaign 骨架→邮件收发闭环→（并行 Spike）→社交→视频；每阶段收口一条「发出→收回→归因」完整环。
2. **商机域**（SaaS 侧）：Opportunity 单一聚合（CANDIDATE→QGO→SAO→CLOSED），附属记录对象 QualificationSnapshot（证据快照防漂移）、SalesAcceptance（owner/stage/nextStep/dueAt/reason 五字段必填）、CommercialOutcome+Verification（验证来源三分）。结构化拒绝原因码回流本仓 backtest。Touchpoint append-only 单表、归因不物化（First/Last Touch=查询视图）；多触点归因门槛（月 QGO≥30、解析率≥80%、标签≥1 季度、渠道≥3）达标前不上。
3. **Pack 机制**：Pack=版本化 jsonb 文档（5 表：pack/version/dependency/binding/snapshot）+ zod 校验 + 纯函数解析（禁止项单向传播）+ 不可变 ResolvedStrategySnapshot；本仓 taxonomy/crosswalks 即 Data Source Pack 运行时、source_policy 即 Compliance Pack 执行面；Motion=横切默认值（第一刀：六维权重外部化）；M2 前 Studio=git；Marketplace 不设计；三交付模式三机制（actor 双字段/责任矩阵数据化/审批路由读矩阵）尽早长进骨架。
4. **前端 IA**：导航分期点亮（M0-M1 四项：今日/客户/企业/设置；终态含一级「机会」；交付包另提「今日/研究/战役/内容/互动/增长」六项方案，随 A 定夺）；AIEnvelope 类型化产物信封（objects/actions/evidence/cost/risks），对象持久化、聊天只是索引；自动化等级 MVP 收敛 L0/L1/L2 三档；首次价值=「30 分钟拿到第一批可解释推荐线索」（现有端点已全部支撑）；不可裁红线：证据可回溯/L2 审批闸/未确认事实阻断/🔴个人数据遮罩。
5. **市场研究域**（本仓可承接，R3 可选提前）：最小 4 层（全球筛选/贸易/买家地图/风险），90% 复用已建件；MarketScorecard 9 维确定性聚合；Trade Intelligence 起步=Comtrade/Census/Eurostat 国家级免费统计；研究→ICP 一键草案+溯源+改版事件。
