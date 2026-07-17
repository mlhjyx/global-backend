# product-scope —— 产品范围、价值与边界（L0/L1 模块层 · why 权威）

> 2026-07-10 v2（合流定稿）。上游基底：[docs/platform/](platform/) 两份交付包 docx（《顶层产品与系统架构设计 v1.0》=L1、《文档体系重构方案 v1.0》=文档治理，均「待批准评审稿」）；两份 v3.0 Word 已冻结为研究综合稿。产出方法：12 视角全平台设计 × Codex as-built 代码审计 × 交付包（TA-001~012/OD-01~06）三方收敛 + 双员对抗审查。
> 本仓 as-built 架构见 [architecture/current.md](architecture/current.md)；决策注册表见 [adr/registry.md](adr/registry.md)；当前状态与待拍板见 [status/current.md](status/current.md)；路线见 [roadmap/release-plan.md](roadmap/release-plan.md)。
> **2026-07-16 补**：本文主体定义**获客后端**产品范围（止于 LeadQualifiedPackage）。自 2026-07-13 起当前主线为**独立站建设（Site Builder）**——为出海企业一键生成/精装修独立站的第二产品面；其范围/边界/决策见本文 §4A、[status/current.md](status/current.md)、「活文档」[site-builder/](site-builder/) 00–14 和 [adr/registry.md](adr/registry.md) **ADR-013~019**。获客侧暂停开发、边界不变。

## 0. 术语表

| 术语 | 意思 |
|---|---|
| **ICP** | 理想客户画像——客户告诉系统「我要找什么样的买家」（行业/国家/规模/排除条件/买家委员会角色） |
| **Lead / 线索** | 「某家公司 × 某个 ICP」的候选评估对象，带六维评分与四队列（推荐/待确认/拒绝/禁止） |
| **LeadQualifiedPackage** | 本仓最终交付物：一条合格线索的**不可变快照包**（公司是谁+证据+评分+联系人+合规结论+建议动作），以事件发给 SaaS 平台 |
| **QGO** | 合格增长商机（北极星单位）——SaaS 平台把合格线索确认成的「值得销售跟进的机会」 |
| **SAO** | 销售接受的商机——销售正式认领 QGO 并开始推进 |
| **Suppression** | 全局禁联名单——退订/投诉/删除请求过的对象，任何对外动作前第一道检查 |
| **Reachability** | 可达性——有没有验证过的联系方式；联系不上的公司分再高也不进推荐队列 |
| **Evidence / 证据** | 每个关键字段都记录「从哪来、什么时候、什么许可、多可信」，可回溯可删除 |
| **DSR** | 数据主体请求——欧盟个人依法要求查看/删除其数据，必须能精确执行 |

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

## 3. 完整产品上下文地图（五层，本仓只实现 ★ 两层）

```
SaaS Control Plane（A 拥有）：身份 / Organization / Workspace / Membership / Billing
        ↓ JWKS token
Growth Strategy（产品脊柱，见 §5）：Goal / GrowthInitiative / OfferingSnapshot / MarketThesis / ICPVersion / Pack Snapshot
        ↓
★ Buyer Intelligence（本仓核心）：多源采集 / 公司身份解析 / Evidence / 数据权利 / Signal / 联系人可达性
        ↓
★ Qualification & Handoff（本仓核心，止于此）：确定性硬门 / QualificationDecision / LeadQualifiedPackage ══►（事件交付）
        ↓
Opportunity & Sales（SaaS 侧）：Opportunity 单一聚合：CANDIDATE → QGO → SAO → CLOSED（状态，不建三套实体）
        ↓
Growth Execution（SaaS/执行系统侧，后建）：Campaign / ExecutionAuthorization / Content / Outreach / Publish / Conversation
        ↓
Learning & Economics：Touchpoint / Attribution / Feedback / Experiment / Cost / ROI
横切：Evidence·Data Rights·Policy·Suppression ｜ Budget·Approval·Audit·幂等 ｜ Temporal·Outbox·Trace·Eval
```

执行层/商机域/Pack/前端 IA 的详细设计输入见本文附录 A（给 A/B 的参照，实现不在本仓）。

## 4. 本仓边界（获客情报后端）【已拍板 2026-07-10】

- **本仓 = 买家智能与机会资格引擎**：Understand → Target → Discover → Qualify → **LeadQualifiedPackage 交付**（=交付包 TA-007）。
- 本仓**不建、任何时候也不在本仓新增**：身份/用户/角色、Campaign、发送/触达、Conversation/Inbox、Opportunity/QGO/SAO、归因。SaaS 消费 `LeadQualified` 事件创建 Opportunity（CANDIDATE 态）；成交结果（QgoCreated/SalesAccepted/CommercialOutcomeVerified/LeadOutcomeRejected）**只回流为质量学习标签**，QGO 主状态不复制回本仓。
- **存储侧合规必须留在本仓**（个人数据在摄取/富集时已发生处理）：Data Rights、PII 分类、保留期、Suppression、DSR 删除。发送侧合规、Approval、ExecutionAuthorization 由 SaaS/执行系统负责，但**消费本仓的政策结论**。
- 边界判据一句话：动「人、权、审、发、看」不进本仓；动「挖、并、证、分、存」是本仓。
- **改边界的唯一途径**：修订 ADR-001 并经 A/B/业务负责人三方书面确认——不存在其他「过流程就能加」的后门。
- **身份归属（已拍板）与两条硬规矩**：身份 SoR 维持在 A（独立库），本仓只 JWKS 验签；为拦住交付包 AR-01/AR-02 风险，锁定：① **A 的库永远不存业务对象**——Company/ICP/Lead/Campaign/Opportunity/QGO 唯一主数据在增长库；② **权限执行点在服务端**（B 层 claims→scopes），任何接口不信任前端提交的 role。详见 ADR-011。

## 4A. Site Builder 产品面与当前边界【2026-07-17 真值】

- **本仓负责**：注册建站、建站档案/素材/知识库、SiteSpec、固定 DAG 的 Temporal 构建、封闭组件渲染、预览与后续不可变 Release/发布能力；AI 只能执行有界 Task，不使用自由 Planner。
- **外部 SaaS 负责**：身份、Workspace 控制面、完整产品 UI、运营/商机/成交。Site Builder 不改变 ADR-001 对获客交付边界的定义。
- **as-built 审计基线（R4-A1 交付分支基于 `main@24decd10`）**：M0 快路径、Astro 渲染器、DQ-1 SiteSpec 1.0.0、素材/KB/构建端点，以及 R0、R1-safety、R2-A1–A4、MF0-A/B、M1-c、R3-A/B1/B2 均已落地。R3-B2 已提供本地 durable artifact + 原子 symlink pointer，但生产对象存储不可变 Release、跨节点恢复/回收与 unknown component 门仍属 R1-min。
- **当前施工**：R4-A1 已冻结 intake/KB/storefront/research 来源并落 EvidenceRef v2 的精确 source/hash/quote/provenance 基础；它不改变公开 API，也不等于公共 Claim 已 APPROVED 或事实已可发布。关键路径下一步为 R4-A2 truth bridge → R4-B-min → M1-d；R4-A2 才负责 value/quote 语义对齐、snippet 发布降级与认证 Asset/人工 verified 门。
- **权威规则**：承重决策只进 ADR-013~019；具体产品/施工真值在 Site Builder 00–14。v3.1/v3.2、旧 Word 和研究稿是历史输入，不得直接覆盖活文档或代码。

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

## 6. 团队 ownership 与三接缝

| 方 | 拥有 |
|---|---|
| A（SaaS 平台） | 身份/登录/角色、全部 UI、Campaign/触达/Inbox、Opportunity(QGO/SAO)/归因、Billing |
| B（接口层，同库） | JWKS 校验、controller/DTO、OpenAPI 契约、事件拉取端点、roles→scopes 映射 |
| Codex（本仓当前开发主体；用户 C 拍板） | Company/ICP/Discovery/Identity/Signal/Contact/Lead/Suppression 应用服务 + Temporal 编排 + 存储侧合规 |

三接缝：① **JWKS**——A 签发登录凭证、我们只验签解出租户；② **事件出口**——合格线索以事件包交付，SaaS 拉取并 ACK；③ **OpenAPI**——契约由代码自动生成、唯一真值，不造 mock；**关键 Schema（LeadQualified 快照、事件信封、统一信封）在实现前先经 B/A 评审**，code-first 仍是生成事实源。技术细节见 [architecture/current.md](architecture/current.md) §6-§7。

## 7. 首个商业切口

- 经济购买者=外贸老板/出海负责人；操作者=海外增长/外贸销售/数据运营。
- 首发客户：B2B 制造、工贸一体、高客单传统出口企业。首发 Job 二选一（待拍板，见 [status/current.md](status/current.md)）：进口商/采购商发现 vs 经销商招募（建议前者）。
- 交付模式：Managed/Collaborative 起步，逐步 Self-service。
- MVP 假设：「对 B2B 制造/工贸企业，输入官网、产品和目标市场后，平台在可解释成本内持续产出有证据、可联系的目标采购企业，并在 **30 天内形成至少一个人工确认 QGO**（SAO 为 M3 商业验证目标）。」
- 首版不做：4 个发布平台、完整视频、全渠道 Inbox、专家市场、多行业同时商业化、多触点归因。
- 定价方向：Workspace 订阅 + Buyer Intelligence/QGO Credits + 超额统一 Credit + Managed 服务包单独收费。

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
**当前待办与待拍板**：统一见 [status/current.md](status/current.md)；获客侧事项在冻结期不进入当前施工序。

---

## 附录 A 全平台设计输入（给 A/B 的上下文地图，实现不在本仓）

> 源自 12 视角设计，浓缩保留。与正文冲突处以正文为准（商机域已按单一 Opportunity 聚合修订）。

1. **执行层**（SaaS/执行系统侧）：Campaign=协调上下文非聚合根（对象独立表+campaignId 外键；Audience=Query Snapshot 消费本仓 lead 队列；11 态状态机；APPROVED 时一次性签发不可变 ExecutionAuthorization）。**OutboundBroker** 镜像本仓 ToolBroker（授权→Suppression 逐条重查→Policy→频控→幂等→审计）。邮件最小版=Gmail/Graph 用户授权发送（零发送基建；SPF/DKIM/DMARC 日检；DSN 轮询→Suppression；List-Unsubscribe；回复经 In-Reply-To 关联）。Build-vs-integrate：图文/邮件文案自建薄层；社交=AiToEarn 三 Provider 契约（失败 Plan B=1-2 个官方 API 直连，绝不浏览器自动化）；聊天=Chatwoot（失败 Plan B=自建三表）。顺序：Campaign 骨架→邮件收发闭环→（并行 Spike）→社交→视频；每阶段收口一条「发出→收回→归因」完整环。
2. **商机域**（SaaS 侧）：Opportunity 单一聚合（CANDIDATE→QGO→SAO→CLOSED），附属记录对象 QualificationSnapshot（证据快照防漂移）、SalesAcceptance（owner/stage/nextStep/dueAt/reason 五字段必填）、CommercialOutcome+Verification（验证来源三分）。结构化拒绝原因码回流本仓 backtest。Touchpoint append-only 单表、归因不物化（First/Last Touch=查询视图）；多触点归因门槛（月 QGO≥30、解析率≥80%、标签≥1 季度、渠道≥3）达标前不上。
3. **Pack 机制**：Pack=版本化 jsonb 文档（5 表：pack/version/dependency/binding/snapshot）+ zod 校验 + 纯函数解析（禁止项单向传播）+ 不可变 ResolvedStrategySnapshot；本仓 taxonomy/crosswalks 即 Data Source Pack 运行时、source_policy 即 Compliance Pack 执行面；Motion=横切默认值（第一刀：六维权重外部化）；M2 前 Studio=git；Marketplace 不设计；三交付模式三机制（actor 双字段/责任矩阵数据化/审批路由读矩阵）尽早长进骨架。
4. **前端 IA**：导航分期点亮（M0-M1 四项：今日/客户/企业/设置；终态含一级「机会」；交付包另提「今日/研究/战役/内容/互动/增长」六项方案，随 A 定夺）；AIEnvelope 类型化产物信封（objects/actions/evidence/cost/risks），对象持久化、聊天只是索引；自动化等级 MVP 收敛 L0/L1/L2 三档；首次价值=「30 分钟拿到第一批可解释推荐线索」（现有端点已全部支撑）；不可裁红线：证据可回溯/L2 审批闸/未确认事实阻断/🔴个人数据遮罩。
5. **市场研究域**（本仓可承接，R3 可选提前）：最小 4 层（全球筛选/贸易/买家地图/风险），90% 复用已建件；MarketScorecard 9 维确定性聚合；Trade Intelligence 起步=Comtrade/Census/Eurostat 国家级免费统计；研究→ICP 一键草案+溯源+改版事件。
