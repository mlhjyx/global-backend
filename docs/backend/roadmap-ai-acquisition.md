# 后端路线图 · 能力一：AI 获客主线

> 范围锁定：**企业理解 → ICP → 客户发现 → 验证评分 → Lead**。
> 市场研究（PRD 7.3）与触达/Campaign 延后为下一能力。数据源第一版走 sandbox。

## 目标

跑通「客户输入官网/产品 → 系统理解企业 → 生成 ICP → 多源发现目标客户 → 验证补全评分 → 产出分好组的可跟进 Lead」的后端闭环，产出可交给 Campaign（触达）的合格 Lead。

对应 PRD：旅程 5.2 / 5.4 / 5.5 / 5.6；功能域 7.2 / 7.4 / 7.5；架构第 11 部分。

## 阶段与交付物

| 阶段 | 交付物 | PRD 依据 | 状态 |
|---|---|---|---|
| **P0 地基** | ✅ Nx monorepo · ✅ NestJS `api` + Swagger(`/api/docs`, code-first) · ✅ 本地 PG+Redis · ✅ Prisma 多租户 + RLS（隔离已验证）· ✅ 事件 Outbox 表 · ✅ api↔db(app_user 连) · ✅ 鉴权 seam + AuthGuard + `whoami` · ✅ `workspace` 精简为租户锚点 + JIT provision · ✅ Model Gateway（app→**单一中转站(new-api)端点** + 薄契约 + task 选 model 名 + stub fallback；模型在中转站 UI 统一管理）· ✅ Outbox relay（owner 扫描跨租户）+ Temporal 编排（dev server）· ⬜ Policy stub | 11.5 · ADR-001/002/009 | 🚧 收尾中 |
| **P1 企业理解** | ✅ 数据模型 `company_profile`/`offering`/`knowledge_source`/`claim`/`evidence`/`citation` + RLS · ✅ `POST/GET /companies`（code-first、租户隔离验证、创建写 `CompanyProfileCreated` Outbox）· ✅ Temporal 理解工作流端到端（relay→workflow→活动→ACTIVE + 写 Claim(NEEDS_REVIEW)/Source，活动 stub）· ✅ 抽取走**真模型**（DeepSeek V4 经 new-api 中转站，实测抽出 ISO/CE/MOQ/交期/市场等真实 Claim）· ✅ Claim 审核端点 + 人工 Gate（approve/reject 状态机 + ClaimApproved 事件 + 乐观锁 + 409 非法转移）· ✅ 抓官网走 **Crawl4AI**（真实抓取 + 自带 SSRF egress 防护；实测抓 python.org 抽出真实 Claim）· ✅ **字段级 Evidence**：每条 Claim 存 来源URL+官网原文片段+置信度，可溯源（事实 vs 推断）· ✅ **按任务选模型**（抽取=deepseek-v4-flash，ICP=deepseek-v4-pro）· ⬜ Docling（文档上传路径）· ⬜ 知识冲突/术语表 | 7.2 · 5.2 · KNW-001..011 | 🚧 深化中 |
| **P2 ICP** | ✅ 数据模型 `icp_definition`/`persona`/`buying_committee_role` + RLS · ✅ AI 生成 ICP（`icp.design` Task，DeepSeek 从已确认 Claim 生成 目标属性/痛点/触发信号/排除/买家委员会）· ✅ `POST /companies/:id/icps`、`GET /icps`、`activate`（→ACTIVE + ICPActivated 事件，未回测标 HYPOTHESIS）· ⬜ 样例回测(LED-004) · ⬜ QualificationRule · ⬜ 按 ICP 生成多源查询计划(LED-005，接客户发现) | 7.5 · 5.4 · LED-001..005 | 🚧 骨架完成 |
| **P3 客户发现** | ✅ `ProviderAdapter` 契约（七类，ADR-017 raw 不穿透领域层）· ✅ **真实公开数据挖掘**（PublicWebDiscoveryProvider：SearXNG 元搜索→噪声过滤→robots 闸门→Crawl4AI 抓官网→gemini-2.5-flash 判站抽取→provenance 指纹）· ✅ **Source Registry**（source_policy，SUSPENDED 域名爬前跳过）· ✅ Temporal discoveryWorkflow（READY 计划→逐源→归一→**ICP 资格门**→PARTIAL 容错）· ✅ `raw_source_record`（带采集留痕）→`canonical_company`/`canonical_contact` · ✅ 确定性身份解析（domain_exact > name_country，identity_link 留痕）· ✅ 字段级 `field_evidence` · ✅ **ICP 资格门**（discovery.qualify_fit，gemini-2.5-pro，四门：材质/角色/工艺/商业模式）· ✅ 联系人按需发现 + 邮箱验证 + Suppression · ✅ **真实评测通过**（19 家真公司，真实性 3 项满分，资格门拦竞品/品类不符）· ⬜ 真源合同接入 · ⬜ 规范词表归一（中英属性值映射，真源前必须做） | 7.4 · 5.5 · DAT-001..017 | ✅ 真实数据闭环 |
| **P4 验证评分** | ✅ 六维评分（确定性：规则引擎 Fit + 委员会覆盖 Role + 信号代理 Intent + 完整度 DataQuality + 可达 Reachability + Engagement=0 待触达）· ✅ `lead` + 四队列 + 分数明细（逐规则评估可审计）· ✅ 人工裁决 accept/reject + `lead_decision` 留痕 · ✅ LeadQualified 事件（Campaign 入口）· ✅ 重评不覆盖人工终态 · ⬜ 真实意向信号源 · ⬜ LLM 辅助评分层（LED-007 组合评分） | 7.5 · 5.6 · LED-006..009 | 🚧 主链完成 |
| **P5 收口** | ✅ OpenAPI 导出（38 端点，`packages/contracts/openapi/openapi.json`）+ `INTEGRATION.md` 前端接入说明 · ✅ LeadQualified 出口事件（Campaign 入口）· ✅ 单元测试基线（vitest 24 用例：规则引擎/评分/身份解析/选页/联系方式抽取，`pnpm test`）· ⬜ API 集成测试 + RLS 回归入 CI · ⬜ 事件对外发布通道（现仅 outbox 内部消费） | 11.10/11.11 · 14.1 | 🚧 |

### 补充完成（差距盘点驱动的收口，2026-07-06）

- **P1 深化**：多页抓取（关键子页确定性选择）· Offering 结构化抽取（幂等 upsert + 溯源）· 公开联系方式/社媒（正则确定性，Buyer Trust 原料）· 画像回填（industry/summary）· 手工 Claim 录入 · APPROVED→REVOKED 撤销 + validUntil→EXPIRED 扫描 · 知识冲突检测（Jaccard 启发式 + 人工裁决）· **REVIEW Gate**（零审批不得 ACTIVE，审批≥3 自动激活或显式 confirm）
- **AI 基建**：ai_trace + usage_ledger 全调用记账 · 结构化输出 ajv 校验 + 修复重试 · stub 仅 DEV · 模型调用超时 · persistClaims 幂等（ingestKey）
- **横切**：统一错误模型全局过滤器 · Idempotency-Key（POST /companies）· 我方侧 URL/SSRF 守卫 · outbox producer 字段

### 多源发现 + 工具编排 + 接口管理（2026-07-06 续）

- **真实多源发现**：官网(SearXNG+Crawl4AI+Gemini) + **Wikidata SPARQL**(结构化，实测 20 家真实公司端到端) + **OpenStreetMap Overpass**(地理，多实例 fallback)；executeQuery **fan-out** 到 source_class 全部 ENABLED 适配器；source_hint 收窄子源。设计蓝图见 [discovery-sources.md](discovery-sources.md)。
- **✅ GLEIF 富集**（[discovery-sources.md](discovery-sources.md#gleif-富集落地要点本轮)）：`CompanyEnrichmentAdapter` 新契约 + `enrichRun` 活动（fit 门后，只富集 match 公司）；对已归一公司补 **LEI + 法人形式(ELF) + 实体·登记状态 + 直接·最终母公司**；核心名召回 + 拼写全称归一 + 置信门槛 0.72 + 歧义边距 0.1（绝不贴错身份）；429/5xx 退避重试。实测 Audi→Volkswagen AG、BMW Bank→BMW AG 母子关系落地。
- **工具/Broker 层**（[discovery-architecture.md](discovery-architecture.md)）：Tool 契约 + Registry + **ToolBroker**（allowedTools 白名单/预算 reserve-settle/限流/source_policy/幂等/trace 统一闸门）；AiTaskContract 加 allowedTools 等边界字段。MCP=传输非授权，第一步不做。
- **✅ 规范词表归一**（[vocab-taxonomy.md](vocab-taxonomy.md)）：canonical_taxonomy + term_alias 表；250 国 ISO3166 + 1910 多语言别名 + ISIC 行业；TaxonomyResolver 确定性 + LLM 冷路径沉淀。实测中文「半导体/德国」→ wikidata 挖到 18 家德国公司。**欠账已还**。
- **✅ 统一接口门户**（[api-management.md](api-management.md)）：自托管 Scalar `/api/portal`（前端一个入口浏览+调试全部端点）；OpenAPI 单一事实源 `--export-openapi`；结论：单端点是伪需求、不用 Apifox（出海数据合规）。
- **✅ 前端护栏**：helmet + CORS 白名单 + 按 workspace 限流。
- **✅ 生产鉴权**：JwksTokenVerifier（jose，验签 iss/aud/exp）；生产禁 dev stub。**待 SaaS 平台给 JWKS 契约激活**。

### 已知欠账（按优先级）

1. **鉴权契约对接**：JwksTokenVerifier 已就绪，但需 SaaS 平台的 JWKS 端点 + claim 约定书面确认才能激活（联调前提）。
2. **多源 P0 补源**：VDMA 协会名录 / Hannover Messe·EuroBLECH 展会名录（需逐站抓取模板）。~~GLEIF LEI 富集~~ ✅ 已落地。
3. 异步长任务前端交付：SSE 进度流 + 领域事件出口（现仅裸轮询）。
4. 契约防漂移进 CI：openapi-typescript 生成前端类型 + oasdiff 破坏性变更检查。
5. Docling 文档上传路径；OPA / Langfuse / Golden Set；brand_profile / glossary。
6. 海关贸易公司级数据（付费 reseller，留契约插槽）；product/HS 维归一。

## 关键数据模型（本能力落地的主要表）

所有业务表带 `workspace_id` + PostgreSQL RLS（ADR-001）。

- **企业理解**：`company_profile` · `offering` · `brand_profile` · `knowledge_source` · `claim` · `evidence` · `citation` · `knowledge_conflict` · `glossary`
- **ICP**：`icp_definition` · `persona` · `buying_committee_role` · `qualification_rule`
- **Data Hub**：`data_provider` · `provider_contract` · `dataset_license` · `source_policy` · `raw_source_record` · `canonical_company` · `canonical_contact` · `field_evidence` · `identity_link` · `data_quality_issue` · `data_cost_ledger` · `suppression_record`
- **Lead**：`account` · `contact` · `lead` · `signal` · `lead_score` · `lead_decision` · `lead_cohort`
- **公共/基础设施**：`organization` · `workspace` · `membership` · `outbox_event` · `ai_trace` · `usage_ledger` · `audit_log`

## 状态机（PRD 11.9）

- **Claim**：INGESTED → EXTRACTED → NEEDS_REVIEW → APPROVED → EXPIRED/REVOKED
- **ICP**：DRAFT → HYPOTHESIS → VALIDATING → ACTIVE → SUPERSEDED → ARCHIVED
- **Lead**：DISCOVERED → ENRICHING → REVIEW → QUALIFIED/REJECTED/SUPPRESSED → CONTACTED → CONVERTED

## 贯穿约束（每个阶段都要守）

1. **多租户**：Shared Schema + `workspace_id` + RLS，领域 API 不感知物理隔离（ADR-001）。
2. **AI 分层**：AI 只理解/研究/生成/建议；状态/权限/预算/执行/审计由确定性系统兜底（无「超级 Agent」）。
3. **对外动作前置校验链**：数据权利 → Suppression → Policy → RBAC/ABAC → Campaign Scope → Approval → ExecutionAuthorization。
4. **字段级 Evidence**：Canonical 字段不只存「最终值」，保存来源/时间/置信度/许可/允许动作（7.4.9）。
5. **契约先行**：数据模型 + OpenAPI/AsyncAPI 先定，Provider JSON 禁穿透领域层（ADR-017）。
6. **幂等**：所有外部副作用用稳定 idempotency_key；业务更新用乐观锁/version（11.16）。

## 接口文档（后期交付，code-first）

**不为前端并行开发做协调/mock；后端做好后再出一份接口文档告诉前端如何接入**，不等前端（见 [[api-contract-approach]]）。做法：

1. REST 采用 **code-first**——用 `@nestjs/swagger` 从实现自动生成 OpenAPI，开发期 `/api/docs` 可看可试；后期**导出 OpenAPI + 简短接入说明**作为交付物。
2. 事件用 AsyncAPI/JSON Schema（`packages/contracts/events/`，按 11.10/11.11），随实现补。
3. `packages/contracts` 保留：事件 schema、通用约定(README)、以及最终导出的 OpenAPI；spectral/redoc 用来 lint 与渲染导出的 doc。

统一约定（错误模型 11.15、游标分页、uuid、UTC 时间、金额币种、幂等键、乐观锁）见 `packages/contracts/README.md`。

**鉴权边界**：身份/登录由**外部 SaaS 平台**拥有，我方只校验其签发的 bearer token 并解出 workspace/角色（做成可插拔守卫，本地 dev 校验器）。契约安全方案 `bearerAuth` 不变。

**文档工具链就绪**（早期用手写 `/health`+`/companies` 验证过 lint/mock/gen 全链路；REST 契约后续改由 Nest 自动生成，手写 openapi.yaml 仅作过渡参考）：
- `pnpm contracts:lint` / `contracts:docs` — spectral 校验 + Redoc 渲染（用于最终导出的 doc）
- `contracts:mock` / `contracts:gen` — Prism mock / TS 类型（备用，非当前优先）

## 待定决策

- **数据层 ORM**：✅ 已定 **Prisma**。RLS 用「非超级用户 app_user 连接 + 每事务 `set_config('app.current_workspace_id')` + `current_workspace_id()` 策略函数」，迁移 `20260706_rls_and_app_role` 已落地并验证隔离。
- **首个真实数据源**：Provider 合同 Validation Required；先 sandbox，合同确认后接第一个真实 TradeData/B2B 源。
