# architecture/current —— 本仓顶层架构（as-built + 目标收敛 · L1/L4）

> 2026-07-10 v2（合流定稿）。上游：[../product-scope.md](../product-scope.md)（边界与决策）、[../adr/registry.md](../adr/registry.md)（决策注册表）。缺口的整改排期见 [../roadmap/release-plan.md](../roadmap/release-plan.md)。

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
ToolBroker / Execution Gateway（唯一执行闸门——目标态，现状见 §8 缺口2）
        ▼
ProviderAdapters / Anti-Corruption Layer
        ▼
TED / openFDA / Web / Crawl4AI / SearXNG / GLEIF / Wikidata / SMTP ／ new-api 模型网关
```

物理形态：模块化单体 + 单 PostgreSQL；进程可按资源特征拆（API/workflow worker/crawl worker/outbox delivery worker）——**资源隔离，不是微服务化**（ADR-002）。

## 2. Bounded Contexts（9 个）

| Context | 核心对象 | 数据归属 |
|---|---|---|
| Access & Delivery | RequestContext、Command/Query、Handoff | B；外部 token 只提供 ID |
| Seller Knowledge | SellerProfile(CompanyProfile)、Offering、Claim、ClaimEvidence、KnowledgeConflict | Workspace/RLS |
| Targeting | ICPVersion、QualificationRule、Persona、BuyingCommitteeRole、QueryPlan | Workspace/RLS |
| Source Governance & Acquisition | DataProvider、SourcePolicy、CanonicalTaxonomy、MonitoredSource、SourceFetch/Entity/Change | 平台共享；**不得含个人数据** |
| Discovery & Identity | DiscoveryRun、RawSourceRecord、Organization(canonical_company)、OrganizationIdentifier、IdentityLink、FieldEvidence | Raw/候选按 Workspace/RLS |
| Buyer Signals | **Signal（一等，待建=收口⑤）**、DemandEvidence、WebsiteWatch | 两层：平台级 `source_signal`（绿色公司事实、无 RLS、零个人数据）+ 租户级投影（RLS）；web_watch 类租户注册源归租户层 |
| Contact & Storage Compliance | CanonicalContact、Employment、ContactPoint、PersonalDataClass、Suppression、Retention/DSR | Workspace/RLS、列级加密、最小化 |
| Candidate Qualification & Handoff | **CandidateAssessment（ICP×Organization，待建=收口①）**、ScoreSnapshot、Lead、QualificationDecision、LeadQualifiedPackage | Workspace/RLS；事件交付 SaaS |
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

**共享源流（ingest once, project many，收口⑤）**：全局公开源（TED/FDA 等）**平台级采一次** → `source_signal`（无 RLS 绿色事实）→ 身份解析 → 匹配受影响租户的 ICP candidates → 租户级投影（RLS）→ 增量重评分。**修正现状**：external-intent sweep 目前按每个 ACTIVE ICP 重复请求 TED/FDA——收口时改为平台级拉取+多租户投影匹配。

## 5. 状态机（收敛版）

- CompanyProfile：DRAFT→ENRICHING→REVIEW→ACTIVE
- Claim：INGESTED→EXTRACTED→NEEDS_REVIEW→APPROVED→EXPIRED|REVOKED
- ICP：DRAFT→HYPOTHESIS→VALIDATING→ACTIVE→SUPERSEDED|ARCHIVED
- QueryPlan：DRAFT→READY→EXECUTED|SUPERSEDED · DiscoveryRun：RUNNING→DONE|PARTIAL|FAILED|CANCELLED
- CandidateAssessment/Lead：DISCOVERED→EVALUATING→NEEDS_REVIEW|QUALIFIED|REJECTED|SUPPRESSED→EXPIRED
- ContactPoint：UNVERIFIED→VALID|RISKY|INVALID→STALE|REVOKED · Signal：DETECTED→ACTIVE→EXPIRED|REVOKED
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

scores 与 as-built 六维映射注记：现行六维=fit/role/intent/dataQuality/reachability/engagement（scoring.ts）；`demand_proof` 是收口⑤后才有事实源的新维——**schema v1 允许 null，收口⑤后升 v2 填充**。

**SaaS 回传（仅作学习标签）**：QgoCreated · SalesAccepted · CommercialOutcomeVerified · LeadOutcomeRejected。

**投递语义（收口③，P0 阻塞）**：内部 workflow command 与外部 integration event 分开；`outbox_delivery(sink, status, attempts, acked_at)` 按 sink 投递/重试/ACK/DLQ；**禁止无 handler 事件标记 published**（现状 relay 对无 handler 事件直接标 published——已核验，LeadQualified 事实上被静默丢弃）。每个外部事件有 payload schema（AsyncAPI 入 packages/contracts/events）+ Consumer Test。

## 7. API ownership

- 保留：`/companies` `/icps` `/query-plans` `/discovery-runs` `/canonical-companies` `/leads` `/suppressions`（+补 `/events` 拉取、`/evidence` 查询、`/deletion-requests`）。
- `/campaigns` `/outreach` `/qgos` `/opportunities` **不属于本仓，任何时候不在本仓新增**；改边界唯一途径=修订 ADR-001+三方书面确认。
- 统一返回信封（Evidence/Quality/Rights/Freshness/Cost/Partial）：owner=C 定义+B 套用，并入收口④、R0 内定稿。

## 8. as-built 缺口登记（已核验，8 项）

| # | 缺口 | 证据 | 处置 |
|---|---|---|---|
| 1 | Fit 挂错聚合根（canonical_company 而非 ICP×公司，多 ICP 互相覆盖） | schema.prisma:504 | 收口① |
| 2 | ToolBroker 非唯一闸门：主链直调 adapter；source_policy 未登记默认放行（fail-open）；BudgetLedger.open 零调用；allowedTools 全空；伪 workspace 'discovery' 令 AI trace 静默写入失败 | tool-broker.ts:97、discovery.activities.ts:99 | 收口② |
| 3 | Outbox 假发布：LeadQualified 等无 sink 仍标 published——**无真实对外交付能力，P0** | apps/api/src/relay/outbox-relay.service.ts:143 | 收口③ |
| 4 | OpenAPI 双事实源：38-path JSON vs 旧 3-path YAML，contracts 5 脚本全读旧 YAML | packages/contracts/package.json | 收口④ |
| 5 | Intent 是 JSON 投影非一等事实；外部源按 ICP 重复拉取 | attributes.intent.events[] | 收口⑤ |
| 6 | 实体解析单键选择非身份图（无 merge/split/回放） | identity.ts:45 | ADR-007；R2 落最小版（R3 新 provider 前置） |
| 7 | 合规半落地：无一等 LIA/consent/Art.14/retention/deletion；roles 解析后未用；app_user 全表 CRUD；PII 无列级加密 | RLS migration :22 | 收口⑥ + roles→scopes 执行点归 B（R0） |
| 8 | 下游跨-sweep 游标饿死：扫描集不收缩，预算位次后的 match 公司永久饿死 | roadmap 🟠（水位列修复进行中） | R2 验收：预算位次后公司 N 轮 sweep 内可被处理 |
