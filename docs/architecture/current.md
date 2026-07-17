# architecture/current —— 本仓顶层架构（as-built + 目标收敛 · L1/L4）

> 2026-07-10 v2（合流定稿）。上游：[../product-scope.md](../product-scope.md)（边界与决策）、[../adr/registry.md](../adr/registry.md)（决策注册表）。缺口的整改排期见 [../roadmap/release-plan.md](../roadmap/release-plan.md)。
> **2026-07-16 补，2026-07-17 模型决策同步**：本文 §1–§8 主体描述**获客后端**（C 核心）as-built 架构。自 2026-07-13 起主线转为**独立站建设子系统（Site Builder）**；其 as-built 快照见下方 §1A，细节与承重决策见 [../site-builder/02-architecture.md](../site-builder/02-architecture.md)、[../site-builder/09-m1-implementation-design.md](../site-builder/09-m1-implementation-design.md) 和 [../adr/registry.md](../adr/registry.md) ADR-013~020。旧 Word、v3.1/v3.2 和研究稿不是 as-built 权威。

## 1. 顶层运行架构

```
External SaaS（身份 / UI / Campaign / Outreach / Opportunity·QGO）
        │ JWKS token + REST          ▲ 领域事件（按 sink 投递+ACK）
        ▼                            │
NestJS Interface Layer（B：Auth context / Controllers / OpenAPI）
        ▼ 方法调用
Modular Acquisition Core（C：Seller / ICP / Discovery / Identity / Signals / Contacts / Qualification）
        ▼
Temporal Workflows（编排；业务状态在 Postgres）
        ▼
ToolBroker / Execution Gateway（唯一执行闸门——✅ 已收口，PR #51：13 工具 + fail-closed + 预算 + Trace）
        ▼
ProviderAdapters / Anti-Corruption Layer
        ▼
TED / openFDA / Web / Crawl4AI / SearXNG / GLEIF / Wikidata / SMTP ／ new-api 模型网关
```

物理形态：模块化单体 + 单 PostgreSQL；进程可按资源特征拆（API/workflow worker/crawl worker/outbox delivery worker）——**资源隔离，不是微服务化**（ADR-002）。

## 1A. Site Builder as-built 与演进门

```
SaaS / API Client
        │ JWKS + REST
        ▼
NestJS site-builder context（intake / site / profile / asset / KB / build）
        │                         │
        ▼                         ▼
PostgreSQL + RLS             MinIO（素材/KB 对象）
        │                         ▲
        ▼                         │
Temporal 固定 DAG → 有界 AI Task / Docling / BGE-M3 → SiteSpec 1.0.0
                                                   │
                                                   ▼
                                    Astro renderer → 本地构建产物/静态预览
```

- 类型边界：`@global/contracts` 的 `SiteSpec` 1.0.0 是 API 生产端与 Astro 消费端唯一共享类型（DQ-1/#117）；运行时 Zod 门与 1.1.0 目标字段尚未落地，不得写成 as-built。
- #121/#123/#124/#126 已收口 intake 行为、事实安全、隐私、可取消超时、失败保站、幂等合同与 OpenAPI；R1-safety、R2-A1–A4、MF0-A/B、M1-c 与 R3-A/B1/B2 均已落地。R3-B2 的 renderer 产物仍是 `local:` durable artifact，并通过数据库 CAS 后的原子 symlink pointer 切换本地预览；这不等于 ADR-013 的生产对象存储不可变 Release、跨节点恢复/回收，后者仍属 R1-min。
- R4-A1 已新增内部 `EvidenceRefV2` 合同、不可变 `SiteEvidenceSourceSnapshot`/`BrandProfileEvidenceRef`、FORCE RLS 与复合 provenance FK。P1 Activity 在模型前冻结经 PII 清洗和规范化的 intake/KB/storefront/research 语料，KB 精确到 chunk hash；新事实必须精确绑定 source/type/SHA-256/quote/Unicode selector。旧 v1 BrandProfile 不伪造回填；公开 OpenAPI 未变化。R4-A1 只证明引用完整性，不证明事实真值或可发布性。
- 模型面须分层描述：当前 main 的 7 个文本 task 仍使用 `task-routes.ts` 的 DeepSeek/GLM/MiniMax/Doubao `currentRoute`；本机 new-api 已可见 GPT/Claude/Gemini 3.5/GPT Image 2。#140 合并后，Ubuntu 开发环境的应用已把 Ollama BGE-M3 以私有别名 `site-builder-bge-m3-local` + 专用模型受限令牌统一经 new-api 调用，并通过真实 `EmbeddingsClient` 两条 1024 维有限向量验证；这不代表生产部署。ADR-020 只是批准的质量优先目标组合，逐 task promotion 仍受 ADR-016 约束；BGE 路由迁移不换模型、维度或 `embed_version`，因此不触发重嵌。
- 当前关键路径：**R4-A2 Claim/Evidence truth bridge → R4-B-min → M1-d**。value/quote 语义对齐、`research_hint` 不可发布、cert Asset/人工 verified 发布门与 APPROVED Claim 消费均属 A2；BrandProfile 重试幂等和成本真值属 B-min。R1-min 的生产 Release 边界仍须在 M1-e 可见预览前完成。
- 🔴 **抓取 egress as-built**：Compose 已移除 broad allow-internal；Crawl4AI 固定不可变镜像 digest，保留 seed global-unicast 守卫和浏览器 pinning proxy。Ubuntu fake-IP 仅在系统答案全部位于 `198.18.0.0/15` 时经固定 Cloudflare DoH 回退；private/loopback/metadata/保留或混合答案 fail-closed。API 的 Crawl/robots/`http.get` 在每一跳解析、校验并钉扎连接，限制 redirect、超时、响应大小且跨域剥离凭证。公网与 private/loopback/metadata/IPv4-mapped/redirect-to-metadata 真机矩阵已全绿；loopback 端口绑定仍保留为 defense-in-depth。

## 2. Bounded Contexts（9 个）

| Context | 核心对象 | 数据归属 |
|---|---|---|
| Access & Delivery | RequestContext、Command/Query、Handoff | B；外部 token 只提供 ID |
| Seller Knowledge | SellerProfile(CompanyProfile)、Offering、Claim、ClaimEvidence、KnowledgeConflict | Workspace/RLS |
| Targeting | ICPVersion、QualificationRule、Persona、BuyingCommitteeRole、QueryPlan | Workspace/RLS |
| Source Governance & Acquisition | DataProvider、SourcePolicy、CanonicalTaxonomy、MonitoredSource、SourceFetch/Entity/Change | 平台共享；**不得含个人数据** |
| Discovery & Identity | DiscoveryRun、RawSourceRecord、Organization(canonical_company)、OrganizationIdentifier、IdentityLink、FieldEvidence | Raw/候选按 Workspace/RLS |
| Buyer Signals | **Signal（一等，✅ 已建=收口⑤ PR #56：`source_signal` + `signal_ingest` 账本）**、DemandEvidence、WebsiteWatch | 两层：平台级 `source_signal`（绿色公司事实、无 RLS、零个人数据）+ 租户级投影（RLS）；web_watch 类租户注册源归租户层（其一等事实账本=source_entity_change） |
| Contact & Storage Compliance | CanonicalContact、Employment、ContactPoint、PersonalDataClass、Suppression、Retention/DSR | Workspace/RLS、列级加密、最小化 |
| Candidate Qualification & Handoff | **CandidateAssessment（ICP×Organization，已由 Lead 聚合根承载，收口①/#43）**、ScoreSnapshot、Lead、QualificationDecision、LeadQualifiedPackage | Workspace/RLS；事件交付 SaaS |
| Runtime Platform | Temporal、ToolBroker、ModelGateway、UsageLedger、AITrace、Outbox、Audit | 平台基础设施 |

命名修正（含交付包 §6.4 语义对齐）：`canonical_company` 实为 **workspace 内** canonical（非全球主档）——短期保留表名、文档明确语义，长期拆「平台级绿色 Organization Identity」与「租户级 Account 投影」；本仓机器产出正式命名 **Qualified Buyer Candidate（Batch）**——`Lead`=Company×ICP 资格评估对象（评分读模型），**用户接受后的「正式 Lead」概念上归平台业务核心**（单库现实下由本仓代管 accept 端点，目标归属入 ADR 备案）；ClaimEvidence/FieldEvidence/SignalEvidence 分开。

## 3. 数据平面与最小权限

- Tenant plane：`workspace_id + RLS`（✅ 已建）。
- Platform reference plane：taxonomy/provider/source_policy/monitored_source/source_signal，无 RLS，**只存共享低风险绿色事实、零个人数据**（ADR-003）。
- PII/rights zone：contact_point/具名决策人——**列级加密或 Tokenization**（收口⑥交付）+ 保留期 + 删除链。
- **DB 角色拆分**（收口⑥）：现状 `app_user` 对 public schema 全表默认 CRUD → 拆 `tenant_app`/`platform_worker`/`platform_reader`/`migration_owner`。
- **逻辑 Schema 写入 Owner 分区**（吸收交付包 §6.2，演进方向非立即迁移）：单库内按域分逻辑区并绑定写入 Owner（示意：core/knowledge/data/intel/execution/analytics/ops），以 Repository+应用服务+DB 权限+Code Owner 共同强制「同库也禁止跨模块直接写表」。触发时机=B 写路径进场或第二个领域模块开建。

## 4. 数据流（两条）

**前向主链**：SaaS JWT → API Command → Seller Understanding →（人审）SellerProfile → ICPVersion + QueryPlan gate → ToolBroker → Provider Adapter → Raw Observation → Identity/Evidence 归一 → CandidateAssessment(ICP×Org) → Fit → 富集 → Signal/DemandProof → Contact + Storage Policy → 渠道验证 → 版本化评分 → **QualifiedLeadHandoff** → Outbox sink+ACK → SaaS 拥有 outreach/Opportunity → outcome 标签回流 backtest。

**共享源流（ingest once, project many，✅ 收口⑤已落，PR #56）**：全局公开源（TED/FDA）**平台级采一次** → `source_signal`（无 RLS 绿色事实，payload 白名单零个人数据）→ 按 subjectKey（与租户 dedupeKey 同规范化）+ taxonomy scope（`cpv:`/`fda:` 前缀键）匹配受影响租户的 ICP → 租户级投影（RLS；CC BY 署名/FDA disclaimer 在租户侧履行）→ 评分消费。**ingest-once 键** = `(provider, queryFingerprint, windowKey)`：指纹=规范化查询参数 sha256（码/国别排序去重、大小写无关），**时间窗=6h UTC 对齐桶**（env `SIGNAL_INGEST_WINDOW_MS`）——「同一外部源同一时间窗跨 workspace 只拉取一次」的可测定义，账本表 `signal_ingest`（ERROR 条件记账绝不覆盖并发 OK 行）。投影零出网；复算入口 `IntentRecomputeService`（surfaces=与增量投影同过滤面，防跨 CPV/跨 ICP 注入）；sweep 编排四段=枚举→逐 ICP 确定性解析（零出网）→指纹全局去重拉取一次→逐 ICP 只读投影。

## 5. 状态机（收敛版）

- CompanyProfile：DRAFT→ENRICHING→REVIEW→ACTIVE
- Claim：INGESTED→EXTRACTED→NEEDS_REVIEW→APPROVED→EXPIRED|REVOKED
- ICP：DRAFT→HYPOTHESIS→VALIDATING→ACTIVE→SUPERSEDED|ARCHIVED
- QueryPlan：DRAFT→READY→EXECUTED|SUPERSEDED · DiscoveryRun：RUNNING→DONE|PARTIAL|FAILED|CANCELLED
- CandidateAssessment/Lead：DISCOVERED→EVALUATING→NEEDS_REVIEW|QUALIFIED|REJECTED|SUPPRESSED→EXPIRED
- ContactPoint：UNVERIFIED→VALID|RISKY|INVALID→STALE|REVOKED · Signal：DETECTED→ACTIVE→EXPIRED|REVOKED（✅ 收口⑤：官方 API 源摄取即 ACTIVE、DETECTED 为保留态；EXPIRED 由 sweep 按 `expiresAt=occurredAt+类型 TTL`（招标 90d/清关 365d，env 可调）翻转，投影/复算剔除；REVOKED=合规撤回终态且**撤即脱敏**（subjectName 占位+payload 清空），单条/按主体/按 provider 三入口。**两级撤停语义**：source_policy SUSPENDED=停采不停用（只拦出网），「采集本身被判违规」类事件用 `revokeByProvider` 处置存量信号）
- 🔴 `CONTACTED/CONVERTED` 不由本仓自行推进——只能由 SaaS 结果事件回写（现有 Lead 状态机中这两态标记为「回写位」）。Opportunity 状态机整体在 SaaS。

## 6. 事件目录与 LeadQualifiedPackage

**本仓发布**：CompanyProfileActivated · ClaimApproved/Revoked · ICPActivated · DiscoveryRunCompleted/PartiallyCompleted · CompanyResolved · IntentSignalDetected/Expired · ContactPointVerified · **LeadQualified** · LeadQualificationRevoked · LeadSuppressed · LeadDecisionRecorded。

**LeadQualified 不可变交付快照**（幂等 ID + schema version）：

```
lead_id / workspace_id / initiative_id? / icp_id + icp_version
company_ref（canonical id + 标识符集）/ contact_refs
scores: { fit, role, intent, demand_proof?, reachability, data_quality, engagement }
evidence_refs + freshness / qualification_rule_version
storage_rights_decision / personal_data_class / suppression_state
recommended_action / valid_until
```

scores 与 as-built 六维映射注记：现行六维=fit/role/intent/dataQuality/reachability/engagement（scoring.ts）；`demand_proof` ✅ 收口⑤起由一等 Signal 填充（需求证据类事件=TENDER_PUBLISHED+SOURCING_OPENED，evidence 判据强制；FDA_CLEARANCE 属上市时机留 Intent 维）——**观测维不进总分**（乘法门待 R2 backtest ≥50 QGO 标签），`qualification_rule_version` 升 `additive-6dim-v2` 供消费端区分；**v1 契约预留 number|null 槽位使填充零破坏，snapshot_version 保持 1、不开 v2 文件**（避免 v1/v2 混流坑消费者——release-plan「升 v2」以此达成）。null=lead 评分早于 v2 规则。

**SaaS 回传（仅作学习标签）**：QgoCreated · SalesAccepted · CommercialOutcomeVerified · LeadOutcomeRejected。

**投递语义（✅ 收口③已落地，PR #46）**：事件注册表三分支（`relay/event-registry.ts` 穷举）——内部 workflow command（3 种→Temporal，AlreadyStarted 幂等）/外部 integration event（8 种→`outbox_delivery` 账本单事务原子路由，`publishedAt` 语义=已路由进交付层）/未注册类型 `parkedAt` 停靠+大声报错（不假发布、不毒化轮询）。sink：`saas` 拉模式（`GET /events` 游标=**交付账本行 id**、任意重放 at-least-once、`POST /events/ack` 幂等且锁死 pull sink）+ `webhook` 推模式（URL+SECRET 且 https 才启用；HMAC-SHA256 签名、指数退避封顶 1h、10 次 DEAD=DLQ、双路径 CAS）。LeadQualified payload=快照 v1（`packages/contracts/events/payloads/lead-qualified.v1.schema.json`，ajv Consumer Test；contact_refs 只带 ref+职务元数据不嵌 PII，含具名 refs 事件分级 RESTRICTED）。**部署约束**：relay 单写者（多副本前需 advisory lock）；其余 7 种 integration 事件的专用 payload schema 待补（现走 envelope 通契约）。

## 7. API ownership

- 保留：`/companies` `/icps` `/query-plans` `/discovery-runs` `/canonical-companies` `/leads` `/suppressions`（+补 `/events` 拉取、`/evidence` 查询、`/deletion-requests`）。
- `/campaigns` `/outreach` `/qgos` `/opportunities` **不属于本仓，任何时候不在本仓新增**；改边界唯一途径=修订 ADR-001+三方书面确认。
- Site Builder 当前端点位于 `/site-builder/intake`、`/site-builder/sites*`、`/site-builder/assets*`、`/site-builder/builds*`；正式形状只认 code-first OpenAPI。目标契约草案 [07-api-contract-draft.md](../site-builder/07-api-contract-draft.md) 与 as-built 不同的部分必须显式标注，不能冒充已实现。
- 统一返回信封 **✅ 收口④已定稿（PR #48）**：2xx 一律 `{data}`；分页 `{data, page:{next_cursor, has_more}}`；错误 `{error:{code,message,details?}}`；`/health*` 探针例外。协议键 snake_case、资源字段 camelCase；运行时与 swagger 声明同源（`common/envelope.ts` + `common/api-envelope.decorator.ts`）。契约唯一真值=code-first 导出的 `packages/contracts/openapi/openapi.json`（40 paths），CI contracts job 三道门（drift/spectral/oasdiff breaking + `breaking-change-approved` label 放行）。Evidence/Quality/Rights/Freshness/Cost/Partial 等信封扩展字段待收口⑤⑥随一等 Signal/权利词表补充。

## 8. as-built 缺口登记（已核验，8 项）

| # | 缺口 | 证据 | 处置 |
|---|---|---|---|
| 1 | ~~Fit 挂错聚合根（canonical_company 而非 ICP×公司，多 ICP 互相覆盖）~~ | ~~schema.prisma:504~~ | ✅ **已修（PR #43）**：fit_verdict/fit_reasons 迁到 Lead（ICP×公司），共享 upsertLeadFit，真库真 RLS 实测两 ICP 独立互不覆盖 |
| 2 | ~~ToolBroker 非唯一闸门：主链直调 adapter；source_policy 未登记默认放行（fail-open）；BudgetLedger.open 零调用；allowedTools 全空；伪 workspace 'discovery' 令 AI trace 静默写入失败~~ | ~~tool-broker.ts:97、discovery.activities.ts:99~~ | ✅ **已修（PR #51，收口②完成）**：13 个 L0 工具收编 22 处直连出网（发现/富集/intent/采集/理解五链全经 `broker.invoke`，例外四类登记：robots.txt/DNS/模型网关/outbox webhook）；`sourcePolicy=required\|advisory\|none` 分层 fail-closed（未登记/无 reader 拒；用途门按本次调用 purpose 判）+ 8 治理域 seed（algolia.net 如实 REVIEWED_RESTRICTED）；预算真开账（run 开/关账 + sweep 阶段账引用计数 + **LLM 网关 reserve-then-settle**，settle 按 token 折算、截断显性化 run 转 PARTIAL）；allowedTools 4 任务填实 + taskContractId 绑定；ExecutionContext 贯穿灭 'discovery'/'taxonomy' 伪 workspace——AI trace 真库实证写入成功。真库 verify 15 断言 + TED E2E 全绿；对抗复审 11 findings 全修 |
| 3 | ~~Outbox 假发布：LeadQualified 等无 sink 仍标 published——无真实对外交付能力~~ | ~~outbox-relay.service.ts:143~~ | ✅ **已修（PR #46）**：事件注册表三分支 + `outbox_delivery` 账本 + `GET /events` 拉取/ACK + 快照 v1 契约；真库 RLS 实测 24 断言 + 对抗复审 13 findings 全修 |
| 4 | ~~OpenAPI 双事实源：38-path JSON vs 旧 3-path YAML，contracts 5 脚本全读旧 YAML~~ | ~~packages/contracts/package.json~~ | ✅ **已修（PR #48）**：旧 YAML 删除、5 脚本切 code-first openapi.json（40 paths）；统一信封定稿（2xx 一律 `{data}`/`{data,page:{next_cursor,has_more}}`，/health 探针例外）38 业务操作全套 + swagger 响应 schema 0 缺失；CI contracts job 三道门（drift=git status porcelain + spectral + oasdiff breaking，label 放行）；对抗复审 10 findings 全修 |
| 5 | ~~Intent 是 JSON 投影非一等事实；外部源按 ICP 重复拉取~~ | ~~attributes.intent.events[]~~ | ✅ **已修（PR #56，收口⑤完成）**：`source_signal` 一等信号表（零个人数据白名单 payload、双时间轴 occurred/observed、状态机+TTL、ADR-006 字段全落）+ `signal_ingest` ingest-once 账本（指纹×6h 窗唯一键）；TED/openFDA 投影反转为**只读平台表**（fetch 拆层，构造去 broker）；sweep 四段化；`attributes.intent` 降为可复算投影（recompute surfaces=与增量同过滤面+不动点回归锁；mergeIntent 去重键 epoch 归一——存量旧格式事件一次重写自然收敛无需 backfill）；快照 demand_proof 真值填充（v1 槽位零破坏，rule→additive-6dim-v2）。真库实测：24 条真招标一次拉取、双租户各投 18 家且投影零出网、EXPIRED/REVOKED 剔除+撤即脱敏、复算重建后 unchanged；对抗复审 3 维 21 agent 14 缺陷全修/记档、2 误报驳回 |
| 6 | 实体解析单键选择非身份图（无 merge/split/回放） | identity.ts:45 | ADR-007；R2 落最小版（R3 新 provider 前置） |
| 7 | ✅ **大部落地（收口⑥ 完成，PR-A #60 + PR-B）**：一等 LIA/Art.14/deletion + `DataRightsService` 判定引擎 + PII 列级加密 + DB 角色拆分（app_user 审计表 append-only + REVOKE）+ deletionWorkflow(Art.17)。**剩**：consent(Art.21)/retention sweep/细粒度 RolesGuard（roles→scopes 执行点）随 R1 | RLS migration :22 | ~~收口⑥~~ ✅；consent/retention/roles→scopes 归 R1（roles 执行点归 B） |
| 8 | 下游跨-sweep 游标饿死：扫描集不收缩，预算位次后的 match 公司永久饿死 | roadmap 🟠（水位列修复进行中） | R2 验收：预算位次后公司 N 轮 sweep 内可被处理 |
