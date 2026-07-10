> 【定位变更 2026-07-10】本文件已降级为**追加式实施日志（changelog）**，不再代表当前状态。当前状态见 [../status/current.md](../status/current.md)，路线见 [release-plan.md](release-plan.md)，顶层设计见 [../product-scope.md](../product-scope.md)。

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

- **真实多源发现**：官网(SearXNG+Crawl4AI+Gemini) + **Wikidata SPARQL**(结构化，实测 20 家真实公司端到端) + **OpenStreetMap Overpass**(地理，多实例 fallback)；executeQuery **fan-out** 到 source_class 全部 ENABLED 适配器；source_hint 收窄子源。设计蓝图见 [discovery-sources.md](../backend/discovery-sources.md)。
- **✅ GLEIF 富集**（[discovery-sources.md](../backend/discovery-sources.md#gleif-富集落地要点本轮)）：`CompanyEnrichmentAdapter` 新契约 + `enrichRun` 活动（fit 门后，只富集 match 公司）；对已归一公司补 **LEI + 法人形式(ELF) + 实体·登记状态 + 直接·最终母公司**；核心名召回 + 拼写全称归一 + 置信门槛 0.72 + 歧义边距 0.1（绝不贴错身份）；429/5xx 退避重试。实测 Audi→Volkswagen AG、BMW Bank→BMW AG 母子关系落地。
- **✅ Wikidata 富集**（直连 REST，与 GLEIF 互补并跑）：`WikidataEnrichmentProvider` 走 wbsearchentities+wbgetentities，补 **行业/产品/员工数/成立年/母子/LEI/ISIN/上市交易所/总部/官网**；复用共享 name-match（精确命中凭搜索知名度排名消歧、模糊命中需边距）。enrichRun 改为**多源命名空间合并**（`attributes.gleif.*` / `attributes.wikidata.*`，逐源 field_evidence，按源幂等）。实测 SAP(32 万员工/LEI/交易所)、Siemens、Bosch、Bystronic→母公司 Conzzeta。
- **✅ 名录/列表发现**（**已端到端实测**）：`DirectoryDiscoveryProvider` + `discovery.extract_list`（一页多公司）。一次真实运行从 3 个静态目录（metalstamper/mrforum/thefabricator）抽出 **151 家真实公司**（带官网+地址），并正确拒绝非名录页（单会员/单供应商详情页判 not-a-directory）。剩余短板：地域精度——查 Germany 会召回美国目录，需下游 fit/地域过滤收敛。
- **✅ 展会参展商 API 模板**（**已端到端实测**，解决 JS-SPA 短板）：`TradeFairDiscoveryProvider` + `trade-fairs.ts` 逐站/逐平台模板。逆向大展会 SPA 的托管搜索（EuroBLECH/RX=Algolia），**直接打 public API** 拿结构化参展商名录。实测 EuroBLECH 2026 一次拉 **398 家 / 5 秒**（带官网 324 / **公开邮箱 322 / 电话 320** / 招聘信号 55）。`scripts/discover-fair-algolia.mjs` 用 crawl4ai 网络抓取自动提取展会配置（加新展会/换届一条命令）。维护：apiKey/eventEditionId 按届刷新。
- **✅ SearXNG 出网绕行**：本环境对消费级搜索引擎做 SNI 过滤，切到放行侧引擎（Yandex/Marginalia/Mojeek）恢复搜索（0→14 结果），解冻 public-web 发现。
- **工具/Broker 层**（[discovery-architecture.md](../research/discovery-architecture.md)）：Tool 契约 + Registry + **ToolBroker**（allowedTools 白名单/预算 reserve-settle/限流/source_policy/幂等/trace 统一闸门）；AiTaskContract 加 allowedTools 等边界字段。MCP=传输非授权，第一步不做。
- **✅ 规范词表归一**（[vocab-taxonomy.md](../backend/vocab-taxonomy.md)）：canonical_taxonomy + term_alias 表；250 国 ISO3166 + 1910 多语言别名 + ISIC 行业；TaxonomyResolver 确定性 + LLM 冷路径沉淀。实测中文「半导体/德国」→ wikidata 挖到 18 家德国公司。**欠账已还**。
- **✅ 统一接口门户**（[api-management.md](../research/api-management.md)）：自托管 Scalar `/api/portal`（前端一个入口浏览+调试全部端点）；OpenAPI 单一事实源 `--export-openapi`；结论：单端点是伪需求、不用 Apifox（出海数据合规）。
- **✅ 前端护栏**：helmet + CORS 白名单 + 按 workspace 限流。
- **✅ 生产鉴权**：JwksTokenVerifier（jose，验签 iss/aud/exp）；生产禁 dev stub。**待 SaaS 平台给 JWKS 契约激活**。

### 采集监控层 + v3.0 买家智能（2026-07-07）

- **✅ 采集监控层（源无关，平台级）**：`monitored_source`/`source_entity`/`source_fetch`/`source_entity_change` 4 表 + `AcquisitionService.acquire`（抓取→**清洗**（域名/电话/邮箱分级）→落库→**增量 diff**（ADDED/UPDATED/REMOVED，连续缺席阈值防误杀）) + **Temporal Schedule 定时 sweep**（`acquisitionSweepWorkflow`，源自带 cadence，`nextFetchAt` 到期自动增量）。展会只是第一个源：`trade_fair`(RX/Algolia，**实测 INTERPHEX 美国 602 家/12 国**，证明不锁德国/行业) + `mapyourshow`(MYS 无鉴权 JSON，实测 321)。源→`canonical_company` 租户投影（RLS+去重+🔴合规隔离）。
- **✅ v3.0 P0 信号富集（零付费，[buyer-intelligence-v3.md](../research/buyer-intelligence-v3.md)）**：直接兑现 P4「⬜ 真实意向信号源」。signal 源写 `attributes.*` 喂六维 Intent/Reachability：`digital_footprint`（官网 HTML/DNS→技术栈/在投广告像素/服务市场 hreflang/邮件商 MX/JSON-LD 事实，实测 TRUMPF 30 国/Xometry 社媒句柄）+ `structured_harvest`（sitemap→careers→招聘信号，采购岗=买家团队扩张）。走 enrichRun 命名空间+field_evidence+幂等。
- **✅ v3.0 P0 自建邮箱验证 `smtp_self`（#3）**：MX + SMTP RCPT 握手 + catch-all 检测 + SSRF 护栏；Gmail/M365/catch-all/端口不可达 → **RISKY**（不谎报 VALID），写 `contact_point` 验证生命周期。
- **✅ v3.0 P0 网站变更 = intent 引擎 `web_watch`（#4，`apps/api/src/intent/`）**：**复用 `source_entity_change` diff**——逐页抓意图承载页（产品/招聘/供应商招募·RFQ/新闻）→ 抽结构化信号 → `signalHash` 只覆盖信号字段（cosmetic 抖动不触发）→ 前后快照 diff 出 delta → 每条 = intent 事件（`SOURCING_OPENED`/`HIRING_UP`/`NEW_PRODUCTS`/`NEWS_POSTED`/`PAGE_CHANGED` + 强度）。真实站多不发 Product/Article JSON-LD → 产品/新闻靠**主内容锚点链接**（去 nav/footer）；**实测** TRUMPF supplier→`supplier_program`、Flex→3 招募词、products→主内容 7 品类、newsroom→8 新闻指纹。独立 `intentSweepWorkflow`+Schedule（registry 正向过滤，不碰通用采集 sweep）；DAT-011 SUSPENDED + robots + crawl4ai SSRF 守；🔴 新闻只存**指纹哈希**（不落标题/人名），保留期清理；租户 `IntentProjectionService` 按 `companyIdentity` dedupeKey 投影 `attributes.intent.*`。**✅ 已接进六维 Intent 维**（`lead/scoring.ts`：真实 intent 事件按新近度衰减(半衰期 60d)取最强 + 关键词代理兜底，`intent=max(realIntent,keywordIntent)`；代理排除 intent 命名空间防双重计数；`scoreLead` 加 `opts.nowMs` 可测；权重/阈值不变，仅在有真实信号时上移）。**✅ 从 ICP 短名单自动 `registerWatch`**（`discovery.activities.registerWatchesForRun` 接在 `discoveryWorkflow` 信号富集后：本 run fit=match+域名公司自动建 web_watch → intentSweep 持续盯，best-effort）。**dev 整条链路实测**（`verify-intent-loop.mts`，真库+真 crawl）：TRUMPF supplier 真实 diff→`SOURCING_OPENED`→投影→Intent 维 0→1、总分 0.39→0.54。**下一步**：六维加法→乘法门（需 backtest 校准阈值）。
- **⬜ v3.0 续（P1）**：自有 ATS JSON 逆向（Greenhouse/Lever/Workday CXS 招聘）· 海关提单（ImportYeti 免费+FOIA 基线+HS 反查逆向）· 招投标（TED v3/SAM.gov）· 认证注册库（openFDA/FCC/EUDAMED）· 专利 inventor（USPTO/EPO）。设计+免费访问+对抗核验见 [buyer-intelligence-v3.md](../research/buyer-intelligence-v3.md)。

### 管线通脉：存量对账 + 队列门修复 + loop 收口（2026-07-08）

> 背景（全库体检结论）：架构跑在数据前面——982/1040 家公司卡在 `fitVerdict=null`（投影公司从不属于任何 run，够不到前向取件的资格门）；4 个 signal provider 只靠 relay 启动静默 seed；`recommended` 队列被 fit 单维覆盖（11 家推荐里 9-10 家零联系人）；`DecisionMakerProvider` 从未注册；intent 事件无人投影。本次不建新能力，只让已建好的在存量上真跑。

- **✅ 存量对账管线 `backlogSweepWorkflow`**（`temporal/backlog.activities/workflow.ts`，Schedule 24h + 手动 `scripts/run-backlog-sweep.mts`）：资格门（`fit-judge.ts` 共享四门核心）→ GLEIF/Wikidata 快事实 → 信号富集（TTL 感知）→ web_watch 注册 → 联系人发现 → `scoreCandidates` 重评分。`id>cursor` 分页防活锁（单 sweep 每行至多一次，跨 sweep 自然重试）；批量+轮次双上限有界；网络一律事务外；DAT-011/SUPPRESSED 全程守。跨租户目标经 ownerDb 只读扫描（「受信系统扫描器」，同 relay 先例）。
- **✅ 队列门修复**：`scoreLead` 接 `authoritativeFit`（LLM 资格门）**只覆盖 Fit 维**；队列走六维总分阈值 + **Reachability 硬底**（match 但零联系方式 → needs_review 并注明先做联系人发现）；EXCLUSION 永远优先。`scoreCandidates` 每批独立事务（千余家单事务会撞 Prisma 5s 超时）。
- **✅ `decision_maker` 复活**：`ContactDiscoveryAdapter` 包装注册为联系人发现**首选**（Impressum/管理层页具名决策人+买家角色，此前是死代码、实际走 public_web 正则只挖 info@）；`contact-persist.ts` 共享持久化（🔴具名人 `person.profile` 证据 + `personal_data` 标记，无 outreach 授权）；`discoverContacts` 服务改「短事务①→网络→短事务②」。
- **✅ 启动自愈**：worker 启动幂等 seed（失败大声，双保险 relay）+ **三个 Schedule 自动 ensure**（acq/intent/backlog——dev Temporal 重置即丢 Schedule 的根治）；relay 合并 QualifyRequested AlreadyStarted。
- **✅ loop 双收口**：`intentSweepWorkflow` 尾部 `projectIntentAllWorkspaces`（事件自动流到 `attributes.intent.*` → Intent 维）；`finalizeRun` 自动发 `QualifyRequested`（发现完成 → 评分自动刷新）。
- **✅ 数据完整性**：fit-judge 拒绝 stub 兜底判定（实测抓到 2 家被网关 fallback 的罐头 null 假判定并重置）。
- **✅ dev 实测（真库真 crawl·无 sandbox）**：有界样本 `run-backlog-sweep --fit-batch=10 --max-fit-rounds=1` 等，首轮冷样本 **6 阶段全产出**——资格门 10 判/1 match、快事实 10 尝试、信号 4 抓/3 命中、web_watch 注册 4、联系人 5 尝试/1 具名、`scored` 1040 全量重评；重跑呈**正确幂等**（TTL 新鲜/已注册/已建联系人的行跳过，不重复烧网关/抓取）。
- **✅ 对抗式复审收口（5 维·14 agent·逐条核验 → 6 findings）**：已修 3 手术刀——① 队列门 Reachability 硬底此前**只在 authoritative 分支生效**，`fitVerdict=null` 存量（982/1040 家）走规则引擎老路径时零联系方式仍能进 recommended（实算 total 0.57≥0.55），抽 `canRecommend` 对两条推荐分支统一生效 + 补 2 测试（RED→GREEN）；② DAT-011 `registerWatchesBacklog` 唯独没调 `suspendedDomains()` → 补 SUSPENDED 守（🔴 注册期 sitemap 探测对 kill-switch 域名越线）；③ 6 阶段静默 catch→`log.warn`（持续性故障不再吞成绿色空转）。

### TED 招投标 provider（P1 中标发现 + P2 ICP→CPV + P3 招标 intent，2026-07-09）

> 获客三缺环「需求证据/时机/对的人」的欧盟官方源。TED（Tenders Electronic Daily）= 欧盟采购官方公报，**零鉴权 REST**、绿事实 CC BY 4.0。归 `public_intelligence` 类，**复用 discovery→fit→enrich→score 全管线，无需新 SourceClass**。规格 [ted-provider-spec.md](../implementation-records/ted-provider-spec.md)（活 API 实测 + 对抗核验，含 §8 审查修正 8 点）。

- **✅ P1 中标发现**：`adapters/ted-api.ts`（`POST /v3/notices/search` expert query 构造 / ITERATION 滚动分页 / `winner-name` 多语言 eng 优先解包 / 缺键当 null / winner-* 按位对齐 / URL 身份安全归属）+ `discovery/providers/ted.provider.ts`（中标公告 → 每中标方一条 `ProviderCompanyRecord`，`winner-name` + 国别税号主解析键；`executeQuery` fan-out，无 CPV → fail-safe 空）。**实测**：泵(CPV 42120000)+德国 近 60 天真拉 12 家（BBA Pumpen/KAESER 等，真税号）→ 真落 canonical 过 fit 门。
- **✅ P2 ICP→CPV 映射（多租户不硬编码）**：`discovery/icp-to-cpv.ts` `resolveIcpToCpv`（industry `crosswalk.cpv` 锚定确定性 + product LLM 精修**限子树** + country 覆盖门非 EU/EEA/UK → `icp_fit_warning` 绝不静默丢）+ **§8.2** 暴露 taxonomy `crosswalks`（`resolveCpvForProduct` 枚举限子树前缀·去尾零覆盖子码）+ **§8.7** planner 路由 TED（`generateQueryPlan` **确定性注入** TED 查询，LLM 绝不臆造 CPV）+ CPV 子树种子（手工核验，非全 9450 树）。**实测**：ICP「pumps+德国」→ cpv 42120000+DEU → 注入 TED 查询 → 真拉 29 家闭环；US → 覆盖门 warning。
- **🔴 合规**（spec §3）：绿事实带 **CC BY 4.0** 署名（发现证据 `field_evidence.license` 修，非硬编码 `'licensed'`）· `winner-email`/具名联系点**不入绿库** · `source_policy(api.ted.europa.eu, personalData=true)` **用途门**（含个人数据源直连前 fail-closed，非「ToolBroker 可选」）· 国别税号身份**按 alpha-2 国别限定**（防跨境同号误并）· 国别 ISO-3→alpha-2 归一（防跨源 dedupe 裂键）。
- **质量闭环**：TDD（252 单测）+ 真库真 API 端到端（无 sandbox，`verify-ted-discovery.mts`/`verify-icp-to-cpv.mts`）+ **2 轮对抗复审工作流**（P1 修 1 HIGH 跨境同号误并 · P2 修 3 findings：CPV 子树前缀去尾零/缓存子树作用域/行业词双路采集）。PR #30/#31 自审自合。
- **✅ P3 招标 → TENDER_PUBLISHED intent（招标=买方需求，动 Intent 维）**：`adapters/ted-api.ts` `searchContractNotices`（`cn-standard`，`CONTRACT_FIELDS` 只取绿字段 buyer/CPV/截止/发布日，**绝不 winner/buyer-email**；抽共享 `fetchNoticesRaw` 分页，award 路径不变）+ `intent/ted-intent-projection.service.ts` `projectTenders`（买方身份 name+alpha-2 归并取最新发布日 → upsert canonical(有则更新/无则建线索) → append `attributes.intent.events[{type:'TENDER_PUBLISHED', at:<发布日 ISO>, strength 0.9}]` → 动六维 Intent 维，复用 `mergeIntent`，**新 event type 无需改评分**）。**§8.6** 发布日 `tedDateToIso` 归一（缺 T 补全 + Date.parse 校验；非法/缺失则跳过，绝不 NaN 静默 0 分）。🔴 **§8.8** 直连前过 `source_policy` 门（SUSPENDED/用途不含 intent\|discovery → fail-closed，与 P1 同一 DAT-011 kill-switch）· **幂等**（`sameIntent` canonical **键序无关**比较——开放招标每 sweep 复现不 bump version/不堆 evidence/不虚报指标）· **无国别招标跳过**（防跨国同名误并）· 新建买方写 `identity` 署名证据（CC BY 4.0 provenance）。**实测**（真库真 API 无 sandbox，`verify-ted-intent.mts` 五段全绿）：泵+德国近 90 天 **24 条开放招标 → 18 家买方 canonical**（skip 全 0）；同参再跑幂等（`companiesTouched=0`、evidence 36→36）；样本 Intent **0→0.8657**、总分 **0.1425→0.2724**；SUSPENDED→零落地。**3 轮对抗复审**（本轮 4 维·16 agent → 9 findings 收敛 5 处真缺陷全修；幂等修复被实测反抓 **jsonb 键序** bug）。TDD 261 测（+2 tedDateToIso）。PR #33 自审自合。
- **✅ P5 招标 intent 投影上 Temporal Schedule**（见下「外部源 intent sweep」——TED 招标 + openFDA 清关共用 `externalIntentSweepWorkflow`，ACTIVE ICP → CPV/FDA 码 → 投影，生产周期真跑）。
- **⬜ 下一步**：P4 招标 SAM.gov Sources Sought（早数月意图）。

### openFDA 认证注册库 provider（P1 器械注册发现 + P2 ICP→FDA 产品码 + P3 510(k) intent，2026-07-09）

> 获客第二个官方免费源。openFDA（`api.fda.gov`）= 美国 FDA 官方开放数据 API，**零鉴权、CC0 公共领域**。`device/registrationlisting` = 「正在合规卖进美国」的规管品类活跃公司名单（「注册人=合规卖家」）。与 TED 同构，归 `public_intelligence` 类、**复用全管线无需新 SourceClass**。规格 [openfda-provider-spec.md](../implementation-records/openfda-provider-spec.md)。

- **✅ P1 器械注册发现**：`adapters/openfda-api.ts`（`GET /device/registrationlisting.json` search 构造 / 有界样本分页 skip≤25000 / `openfda` 谐调块缺块当 null / 判 `error.NOT_FOUND` 空 / 429 退避 / 分类事实取**匹配 ICP 搜索码**的产品块）+ `discovery/providers/openfda.provider.ts`（establishment → `ProviderCompanyRecord`，`name+iso_country_code` 主解析键、FDA 注册号→`fda-reg` **全局唯一 scheme**（非国别税号）、externalId 无注册号退 name:country 防跨国同名互撞；无 product code → fail-safe 空）。**§8.1** 美国进口商=`initial_importer_flag:Y`（**非** establishment_type:Importer）。fit 门设备信号经 `attributes.products`=device_name 送达。
- **🔴 合规**（spec §3，**与 TED 关键差异**）：绿事实 **CC0**（可商用、**署名非义务**，`license='CC0-1.0'`，非 TED 强制 CC BY）· `us_agent`/`owner_operator`/`contact` **具名个人绝不入绿库**（CC0≠GDPR 依据）· **「注册≠核准」文案红线**（`attributes.fda.disclaimer`，绝不称 FDA 认证）· `source_policy(api.fda.gov, personalData=true)` **§8.8 用途门** fail-closed · MAUDE/FAERS 患者数据不摄入 · 捕获的 `owner_operator_number` 是非个人 firm id。
- **质量闭环**：TDD（289 单测，+28）+ 真库真 API 端到端（无 sandbox，`verify-openfda-discovery.mts` 四段全绿：LLZ 放射影像美国进口商 27 家 → canonical 27 + CC0 证据 108 → 无具名个人 → §8.8 SUSPENDED 零落地）+ **对抗复审工作流**（4 维·10 agent → 4 findings 全修：匹配产品分类/跨国 externalId/fit 门设备信号/firm 归并留键）。PR #34 自审自合。⚠️ Tier 3 fit 门 LLM 判别受阻于**网关 Gemini 额度耗尽(429)**（环境/计费，波及全部 fit 门，已建 task 跟进），openFDA 数据已正确进入门。
- **✅ P2 ICP→FDA 产品码映射（多租户不硬编码）**：`taxonomy-resolver.ts` 加 `resolveFdaProductCode`（产品词精修，枚举**限 panel 子树** `parentCode ∈ panelCodes`——FDA 3 字母码不透明无前缀层级、靠显式 panel 父维；缓存命中复验落当前子树；**复用 parentCode 列零 migration**）+ `listFdaProductCodes`（panel 宽网）；`discovery/icp-to-fda.ts` `resolveIcpToFda`（industry `crosswalk.fdaPanels` 锚定 + product LLM 精修限子树 + panel 宽网回退 + 直锚码**并集**）+ `buildFdaQuery`；`icp.service.ts` `generateQueryPlan` 链式 `injectFdaQuery`。**国家维与 TED 相反**：FDA=全美市场无覆盖门，租户选**贸易侧**（进口渠道 `initial_importer_flag:Y` / 同类制造商 `establishment_type`；未识别侧默认进口 + warn）。种子 curated（同 CPV 子树哲学）：6 panel + 6 放射 product code（码/名/class/regulation 手工核验自 `/device/classification`）+ ISIC 医疗器械节点 '325' crosswalks.fdaPanels（**只列已种子 panel**，不 over-claim）。**实测**（真库真 API，`verify-icp-to-fda.mts` 三段全绿，**确定性 allowLlm=false 即通**、不依赖模型）：ICP「放射影像器械+进口商」→ panel RA → 码子树 → 闭环真拉 25 家在美注册进口商（Philips Ultrasound/Carestream/Xoran…）。TDD 302 测 + 对抗复审（3 维·11 agent → 6 findings 全修：wikidata QID 错锚[Q12140 药品→Q6554101 器械]/panel 过度声明/贸易侧兜底/直锚码并集/标签截断）。PR #36。基于 #35（Gemini→deepseek 改路由）rebase。
- **✅ P3 510(k) → `FDA_CLEARANCE` intent 投影（动分，镜像 TED intent 投影）**：`adapters/openfda-api.ts` 加 `search510kClearances`（`GET /device/510k.json`，**顶层** `product_code`/`country_code` + `decision_date:[FROM TO TO]` 有界分页）+ `build510kSearch` + `map510k`（只取绿事实：法人 applicant/清关码/器械名/顶层 `openfda` 块，🔴 绝不取 `contact`/地址自然人）+ `fdaDateToIso`（§8.6/gotcha#5：`YYYY-MM-DD`/紧凑 `YYYYMMDD`/ISO datetime → `'YYYY-MM-DD'`，非法→undefined，防 `scoring.ts` `Date.parse` NaN 静默 0 分）+ `isClearedDecision`（§8.6/gotcha#6：**只对正向清关投**——`SE*` 家族 + `SN/ST/PT/SI` + `DENG`；NSE/被拒/撤回排除，绝不给被拒公司误加分；allowlist=fail toward 不投影）。`intent/openfda-intent-projection.service.ts` `projectClearances`：**具名申请人清关=新品/上市时机**，按 name+alpha-2 归并取最新决定日 → upsert canonical(有则更新/无则建线索) → `attributes.intent.events[{type:'FDA_CLEARANCE', at:<决定日 ISO>, strength 0.85}]` → 动六维 Intent 维（复用 `mergeIntent`，新 event type **无需改评分**——`scoring.ts` 逐事件泛读）。§8.8 用途门 fail-closed；**§6 高精度个体户边界**（`isLikelyIndividualApplicant` 只判人称头衔/"Surname, Given" 逗号格式，**绝不按「几个大写词」形状误伤真公司**——"GE Precision Healthcare"/"Karl Storz Endoscopy" 都是 3 词却是公司；风险有界=从不落 contact/邮箱、applicant 为公开备案主体名）；幂等（`sameIntent`）。**合规（与 TED 关键差异）**：CC0 **署名非义务**（`field_evidence.license='CC0-1.0'`，非 TED 强制 CC BY）+「注册/清关≠核准」`attributes.fda.disclaimer` 恒置。**DRY**：`sameIntent`/`canonicalize` 上移 `intent-projection.service.ts` 供 TED/openFDA 共享；`mergeIntent` 排序比较器改一致（相等 `at` 返 0 保序，V8 稳定；修共享幂等基石的潜在不一致比较器）。**实测**（真库真 API 无 sandbox，`verify-openfda-510k-intent.mts` 五段全绿）：ICP「AI 放射影像诊断软件 product code QAS」近 1 年 16 条清关（Qure.Ai/Aidoc/Ischemaview/A2z Radiology Ai… IN/TW/US/CA/ES/IL）→ **11 家去重 canonical + 11 FDA_CLEARANCE**（"Ischemaview"+"Ischemaview, Inc." 正确并到最新决定日）、disclaimer/CC0-1.0/无 PII、同参再跑幂等（evidence 22→22）、Intent 维 0→0.0252 总分 0.1425→0.1463、§8.8 SUSPENDED 零落地。TDD 339 测（+37：510k 映射/日期/清关码 + `isLikelyIndividualApplicant` + 共享幂等基石单测）+ 对抗复审（3 维·7 agent → 4 findings 全经核验，2 条真机制加固：比较器一致性 + 共享幂等基石单测）。PR #37。
- **✅ 510k intent 投影上 Temporal Schedule**（见下「外部源 intent sweep」）。
- **⬜ 下一步**：P4 `attributes.fda.*` 富集（分类事实/清关历史）· monitoring sweep（定时扫新注册/清关 `created_date`/`decision_date` 增量）· FDA 分类扩 `foiclass.zip` 全表种子（resolver/宽网机制已就位，扩种子即生效）。

### 外部源 intent sweep 上 Temporal Schedule（P5 · loop 收口，2026-07-09）

> 让已落地的两 P3 intent 投影（TED 招标 `TENDER_PUBLISHED` + openFDA 510k 清关 `FDA_CLEARANCE`）**在生产周期真跑**——此前只在 verify 脚本里活，生产永不触发、Intent 维永远拿不到外部信号。核心原则「已建的东西在生产真跑优先于建新能力」。

- **✅ `externalIntentSweepWorkflow` + 第 4 个 Schedule**（`temporal/external-intent.{activities,workflow}.ts` + `ensure-schedules.ts`，默认 6h、overlap=SKIP、env `EXTERNAL_INTENT_SWEEP_EVERY` 可调，worker 启动幂等自愈）：`listExternalIntentTargets`（ownerDb 只读枚举**全部** ACTIVE ICP——无静默截断防旧 ICP 饿死，稳定序 id asc；+ data_provider `ted`/`openfda` ENABLED kill-switch）→ 逐 ICP `projectExternalIntentForIcp`：ICP `companyAttributes`/`targetMarkets` → **确定性**（`allowLlm:false`，调度不臆造码/可复现/零 LLM 成本）解析 CPV（`resolveIcpToCpv`）+ FDA 产品码（`resolveIcpToFda`）→ `projectTenders` + `projectClearances`。各 provider 独立 enabled 门 + 单 provider/单 ICP 失败 fail-safe 不阻断其余；投影写全走 `withWorkspace`（RLS 安全，跨租户枚举走「受信系统扫描器」先例）；§8.8 source_policy 门由两 projection service 各自把守。worker 抽出**共享** `TaxonomyResolver` 一实例（discovery + external-intent 复用）。
- **实测**（真库真 API 无 sandbox，`verify-external-intent-sweep.mts` 四段全绿，活动级）：seed 两 ACTIVE ICP → 枚举命中 + provider ENABLED；pumps+EU → CPV 1 码 → **68 招标 → 54 买方 canonical → 54 TENDER_PUBLISHED**；radiology+US → 6 FDA 码 → **82 清关 → 70 公司 → 70 FDA_CLEARANCE**；`ted` DISABLED → `tedEnabled=false` 跳过。build 绿 · 340 单测绿 · 对抗复审（3 维·7 agent → 1 finding 经核验后加固：ACTIVE ICP 枚举去静默截断防饿死）。PR #38。
- **⬜ 下一步**：超大规模（ACTIVE ICP 数千+）再上 `lastSweptAt` 水位列做增量轮转（当前全量枚举，dozens 级绰绰有余）。

### 已知欠账（按优先级）

- 🟠 **存量下游跨-sweep 游标饿死（fast-follow，复审 #1/#2 HIGH）**：`enrichBacklog/enrichSignalsBacklog/registerWatchesBacklog/discoverContactsBacklog` 每 sweep 游标复位为 null（Schedule 全新 workflow、无跨-sweep 持久化）+ 扫描集按 `fitVerdict='match'` 不随处理收缩（处理只改 attributes/version，不脱离过滤集；联系人集靠结果依赖的 `contacts:{none:{}}`，空结果常态 → 永久留前排）→ 每轮重扫 id 最前固定 N 家（预算 signals/watch 各 36），**预算位次后的 match 公司在信号/监控/联系人上永久饿死**（某租户 match>36 即触发），Intent/Reachability 恒 0、永不满足 recommended——**本管线立论 bug 在下游复现**。根治：加 schema 水位列 `lastEnrichedAt/lastSignalAt/lastWatchAt/contactDiscoveryAttemptedAt`，WHERE 过滤「已处理且 TTL 新鲜」使扫描集随处理收缩、游标真吞噬存量（仅调大预算治标不治本）。

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

### 收口① CandidateAssessment：fit 判定迁到 ICP×公司维（2026-07-10，PR #43）

> release-plan 六收口第一项。修 as-built 缺口 #1（真 bug）：fit_verdict/fit_reasons 原挂 canonical_company（公司级），同 workspace 两个 ACTIVE ICP 时后判 ICP 判不了（qualifyFit 只判 null）且评分读到前判 ICP 的判定（污染）。

- **迁移**：Lead(+fitVerdict/fitReasons/`[ws,icp,fitVerdict]` 索引/FK→canonical onDelete:Cascade)；canonical 删两列、4 水位索引去 fit 前缀；migration 有意不 backfill（生产未上，sweep 按 ICP 重判）。共享 `upsertLeadFit`（run 增量 + backlog 存量两路统一）；初始 queue 按 verdict 映射（mismatch→rejected）。
- **过滤语义**：discovery 下游=本 run ICP 的 match（`leads.some(icpId,match)`）；backlog 下游=任一 ICP match（公司级去重）；四水位列留 canonical（公司级，多 ICP 共享）。scoreCandidates 的 authoritativeFit 改读本 ICP Lead。
- **对抗复审 2 findings 已修**：ENRICHED 死值（真正富集成功处写回，updateMany+SUPPRESSED 守护）；空分 Lead 置顶（排序 nulls last）。迁移/RLS/并发维 5 疑点全核验安全。
- **实测**：build 零错 · 343 vitest（回归 spec RED→GREEN）· 真库真 RLS `verify-candidate-assessment-fit.mts` 全绿（app_user 硬 guard；两 ICP 独立/幂等/迁移生效/水位保留）。

### 收口③ LeadQualifiedPackage 真实交付：Outbox 假发布根治（2026-07-10，PR #46）

> release-plan 六收口第三项（P0）。修 as-built 缺口 #3：relay 对无 handler 的 8 种事件（含 LeadQualified）也标 publishedAt——假发布、静默丢失，平台核心交付物事实上发不出去。

- **事件注册表三分支**（`relay/event-registry.ts` 穷举 11 种产地）：3 内部命令→Temporal（补 AlreadyStarted 幂等，`startWorkflowIdempotent` 三处共用）；8 集成事件→`outbox_delivery` 账本单事务原子路由（skipDuplicates 幂等，publishedAt 语义=已路由进交付层）；未注册→`parkedAt` 停靠+大声报错（不假发布、不毒化 2s 轮询）。
- **双 sink**：`saas` 拉模式=`GET /events`（游标=**交付账本行 id**，构造性消除「低 id 晚发布被游标越过→永久漏交付」；任意重放 at-least-once）+ `POST /events/ack`（幂等、锁死 pull sink——webhook 的 ACKED 只能由 relay 2xx 写）；`webhook` 推模式=URL+SECRET 且 https 才启用、HMAC-SHA256 签名（验签契约 `contracts/events/WEBHOOK.md`）、指数退避封顶 1h、10 次 DEAD（DLQ）、成功/失败双路径 CAS。
- **LeadQualified 快照 v1**（decide(accept) 事务当刻不可变副本，契约 `lead-qualified.v1.schema.json` + ajv Consumer Test）：六维分（demand_proof 收口⑤前恒 null）+ icp_version + company_ref（LEI/FDA 标识符）+ 🔴 contact_refs 只带 ref+职务元数据绝不嵌人名/邮箱（additionalProperties:false 契约兜死）；含具名 refs 事件 privacyClassification=RESTRICTED。
- **decide 幂等+CAS**：同状态重复裁决短路（双击不产生第二条 LeadQualified）；version 乐观锁并发 409。值域护栏：权重 @Min(0)+快照/scoring clamp01。expireDueClaims 两步包事务（ClaimExpired 现为对外事件，不可丢）。
- **对抗复审**（3 维 18 agent 逐条核验）：15 findings→确认 13（2 对重复=11 独立）**全修**，杀 2 误报。记档不阻塞：游标 volume 侧信道→后续不透明游标；LeadQualificationRevoked 撤销事件；internal command attempts 上限停靠。
- **实测**：build 零错 · 435 vitest（RED→GREEN 有据）· 真库真 RLS `verify-outbox-delivery.mts` 24 断言全绿（app_user 非 superuser 硬 guard；路由/幂等/停靠/账本游标翻页不漏不重/跨租户 RLS/端到端 decide→快照→拉取→ajv 契约校验→无 PII/重复 decide 幂等）。
- **部署注意**：relay 单写者约束（多副本前需 advisory lock）；存量已假发布旧事件不回补（thin payload 无快照可补）。

### 选项 B · P0.4 决策人邮箱猜测接入主链（2026-07-10，PR #48，设计 [decision-maker-p0.4-mainchain-wiring-design.md](decision-maker-p0.4-mainchain-wiring-design.md)）

> 承接 P0.3（PR #42/#45）：已落地但**无生产调用方**的 `guessEmailsForCompany` 接进主链，让 fit=match+域名+缺邮箱的具名决策人**自动补全邮箱**。混合姿态（会话拍板）。service 方法零改动，两条路复用其底层纯件。

- **组件 A 按需端点**：`POST /canonical-companies/:id/guess-emails`（`GuessEmailsDto` 镜像 VerifyContactPointDto + maxContacts/maxProbe 护栏）→ 透传 `guessEmailsForCompany`。调用方（SaaS 前端代客户）带 LIA = per-tenant 干净合法性来源。
- **组件 B 存量 sweep 阶段⑤b**：新活动 `guessEmailsBacklog`（镜像 discoverContactsBacklog：短事务①载入→事务外 SMTP→短事务②落库→水位 stamp-all）。🔴 **双闸合规门·默认关**：全局 kill-switch `email_guess` provider（seed **DISABLED**）ENABLED **且** `config.lawfulBasis` 有合法记录才自动探测；**自动路径永不 allowPersonalWithoutBasis**（红线，单测+实测证伪）。RISKY 猜测无 outreach、suppression 不落、personal_data+lawful_basis 留痕（走未改动的 persistGuessedEmail）。
- **组件 C 水位列**：迁移加 `canonical_company.email_guess_attempted_at`（加性可空 + 索引，镜像 4 同族列）；`backlog.eligibility` 加该水位（30d TTL 防重锤 MX）+ `requireEmaillessContact` 谓词。
- 🔴 **诚实交底**：B 路径 `config.lawfulBasis` 是 **interim 全局**（ENABLED 时对所有租户套同一条），仅适用当前单客户/dev；per-tenant LIA 采集归收口⑥ DataRightsService+SaaS。默认 DISABLED 即为此设计。
- **对抗复审**（4 维·逐条对抗核验）：无 HIGH/CRITICAL；修 2 MEDIUM（自动路径 per-company SMTP 扇出无上界→大团队公司超时→水位不 stamp→重锤 MX；service/backlog 目标构建逐字重复漂移）——抽共享纯件 `buildGuessTargets`（RISKY 排除 + per-company cap 25）供两路共用一并根治 + 补 no_verifier 测试 + 清死字段。
- **实测**：build 零错 · **464 vitest** · 真库真 SMTP 真 RLS `verify-email-guess-backlog.mts` 全绿（app_user 非 superuser 硬 guard；双闸全开→真扫→真 SMTP 诚实降级 RISKY 不谎报 VALID→落库+水位 stamp；幂等 scanned=0 不重锤；两红线可证伪 DISABLED/无 LIA→skip）。
- **遗留**（后续独立 track）：待办 2 跨源身份解析（name-match 合并多源同一人）；待办 3 P1 身份源（专利/注册处/商标）。
