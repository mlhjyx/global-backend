> 【定位变更 2026-07-10】本文件已降级为**追加式实施日志（changelog）**，不再代表当前状态。当前状态见 [../status/current.md](../status/current.md)，路线见 [release-plan.md](release-plan.md)，顶层设计见 [../product-scope.md](../product-scope.md)。
> 【环境勘误 2026-07-16】历史条目中的 Mac/WSL 路径、手动 Temporal、旧模型与“Crawl4AI 已有 SSRF 防护”等只记录当时验证；当前 Ubuntu `/global/backend` 环境与安全边界以 AGENTS、architecture/current 与 release-plan 为准。

## 2026-07-17 · Site Builder MF0-A（AssetVariant 数据地基）

- 新增 additive `asset_variant`：workspace/site/Asset 直接 scope，父 Asset 与 source Variant 复合 FK 锁 provenance；单输出 `(asset_id,recipe_hash)` 幂等、canonical object key/hash/正尺寸/状态 payload CHECK、显式 app_user CRUD、ENABLE+FORCE RLS。
- `@global/contracts` 新增 recipe 与 `DerivedImageManifest` 共享类型；recipe hash 覆盖 pipeline/source/role/format/尺寸/crop/focal/quality，纯 projector 只从 ready Variant 确定性物化旧 `derivedKeys` 视图。未接 Sharp writer、未伪造历史 backfill、未预建 MediaJob/AssetUsage。
- TDD 与 Ubuntu 开发环境真 PostgreSQL 验证：app_user 非 super/non-BYPASSRLS，A/B/unset 隔离，跨 workspace/site/Asset provenance 和 CHECK 负例，并发同 recipe 恰一胜；现库增量迁移、临时空库 39 migrations 与 Prisma schema diff=0，fixture 清零。这里只代表开发环境，不代表生产部署。
- MF0-B 仍须完成 SiteSpec+Profile 引用扫描、409、删除/写侧共享并发门，以及 canonical+Variant 严格异步回收与历史 parked 对账；在此之前 canonical 继续 parked，不宣称整个 MF-0 完成。

## 2026-07-17 · Site Builder R2-A2（KB 正确性状态机）

- KB 改为单素材持久状态机：due queued/过期 processing 以 Asset attempt+UUID token+lease CAS 认领；外部 IO 间续租，所有回写 fenced。文档/chunks 与 Asset ready 同事务提交，结果丢失重跑 replace 同一文档，旧 worker 复活不能 zombie write。
- migration 以 020000 单事务/表锁完成 reconciliation + constraints 原子门，021000 仅作已在共享开发库执行过旧迁移名的 compatibility marker，022000 再让旧开发库形态通过正常 deploy 收敛到同一结构。除 duplicate/orphan/零块/不完整历史外，Site→Asset/KbDocument、document→Asset、chunk→document 均闭合复合租户 provenance；Site/workspace 不一致的子行无法安全跨租户改写时迁移直接中止，要求显式 quarantine/audit，绝不硬删 canonical Asset 或绕过 R2-A4/MF-0 cleanup 账本。开发库应用前预检该类行数为 0。
- Docling、embedding 与 KB 存储边界改 typed error；瞬时故障回 `queued+retryAt`，真损坏文档才 `failed_terminal`。commit workflow 透传 assetId；新增 5 分钟 recovery Schedule、有界扫描、结构化告警和 `redrive-site-builder-kb.mts`。
- 验证：专项 TDD、空库 37 migrations、从 34 migrations 构造旧 020000/021000 实际形态再只执行 022000 的升级、零块/healthy+processing|failed/重复/跨 workspace chunk/跨 Site 租户/terminal 保留等样本，以及真 PostgreSQL/app_user RLS/MinIO/Docling/BGE-M3、双 worker/过期接管/zombie fence、真损坏 PDF、recovery/redrive、unique/FK 与删除级联全部通过；fixture、对象与旧 M1-a verifier 残留均清零。当前仅为 Ubuntu 开发环境验证，不代表生产部署；生产迁移仍须独立变更审批与备份/回滚窗口。

## 2026-07-17 · Site Builder R2-A1（Asset 正确性状态机）

- Asset 增加 `processing_attempt`、UUID `lease_token`、`lease_until`、`retry_at` 与 `deleted_at`；active `object_key` 改为部分唯一索引，并以 validated CHECK 锁住状态/lease/tombstone 形状。
- commit 入口先 CAS 认领，所有完成/失败回写按 attempt+token fencing；canonical copy content-addressed 幂等，DB 真值先于 staging 删除，瞬时错误保留 staging 转 `failed_retryable`，唯一竞态显式转 `duplicate`。
- DELETE 从硬删改为 tombstone，KB 检索面同事务移除；cleanup intent 与状态变化同事务写 Outbox。R2-A4 前命令刻意 parked，MF-0 引用扫描器前 canonical 不自动删除。
- TDD 覆盖并发 loser、过期 lease 接管/zombie write、copy 失败重试、P2002、清理失败与 tombstone；开发环境真 PostgreSQL/app_user RLS/MinIO/presigned PUT 全绿，34 个 migration 在临时空库全量 deploy、索引与约束复验通过，verifier 无残留。

## 2026-07-17 · Site Builder R1-safety ②（抓取出口隔离）

- 移除开发 Compose 的 `CRAWL4AI_ALLOW_INTERNAL_URLS`；Crawl4AI 固定到 0.9.1 不可变 digest，保留 global-unicast seed guard 与浏览器 pinning proxy，并只在系统解析结果全部为 `198.18.0.0/15` fake-IP 时经固定 Cloudflare DoH 窄回退。
- API 新增统一 guarded HTTP：Crawl、robots 与 `http.get` 均在每一跳校验 global-unicast、将连接钉扎到已校验 IP、跨域剥离凭证并执行 redirect/超时/响应大小上限；不再保留 check-then-fetch 的 DNS-rebinding 窗口。
- 单测覆盖特殊地址、fake/private 混合答案、无二次 DNS、redirect 与大小上限；真机探针覆盖公网 `/md`+`/crawl`，并确认 private/loopback/metadata/IPv4-mapped/redirect-to-metadata 均被拒绝。R1-safety 两个安全小 PR 至此完成，下一主路为拆分后的 R2-A。

## 2026-07-17 · Site Builder R1-safety ①（构建隔离）

- 两条 Astro 构建路径共用随机 0700 临时目录与 0600 SiteSpec，成功/异常均由 `finally` 删除，消除失败/超时后的租户内容残留。
- Renderer 改为固定 Node/Astro 入口和 7 变量 env allowlist，不经 shell/pnpm/PATH、不再展开 `process.env`；数据库、对象存储、模型网关、代理和 `NODE_OPTIONS` 均不出域。
- 新增单测锁住权限/清理/错误保持/allowlist，并以真 Astro fixture 验证三页产物与子路径资产；R1-safety ② Crawl/robots egress/SSRF 仍是下一项，未把 per-run staging/原子预览冒充已完成。

## 2026-07-16 · Site Builder R0 contract closeout（#126）

- intake 成功合同收口为 `{siteId,buildId,status:"generating_demo"}`，移除旧响应 `mode`；`hasWebsite/websiteUrl` 仅作品牌理解背景。
- 复用通用 `idempotency_key` 账本并新增 nullable SHA-256 `request_hash`：同 workspace/endpoint/key 同请求重放首次结果，异请求 fail-closed 409；历史其他 endpoint 的 NULL 行保持兼容；格式约束先以 `NOT VALID` 落地，再由独立迁移事务验证，避免把建列锁持有到全表扫描结束。
- Temporal 以确定性 workflowId、`REJECT_DUPLICATE + USE_EXISTING`、execution-chain head 与 DB CAS 持久化收敛启动 ACK 不确定窗口；终态缺 ACK 只 describe 修复，不重新 start；start 已成功但 ACK 写库失败时保留 Site/run，绝不补偿删除仍在运行的 workflow 锚点。
- code-first OpenAPI、生成类型、消费者迁移说明、稳定 400/409/502 错误码同步；验证包含单测、真实 PostgreSQL 并发/RLS/迁移约束与真实 Temporal probe。

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

### 选项 B · P0.4 决策人邮箱猜测接入主链（2026-07-10，PR #49，设计 [decision-maker-p0.4-mainchain-wiring-design.md](decision-maker-p0.4-mainchain-wiring-design.md)）

> 承接 P0.3（PR #42/#45）：已落地但**无生产调用方**的 `guessEmailsForCompany` 接进主链，让 fit=match+域名+缺邮箱的具名决策人**自动补全邮箱**。混合姿态（会话拍板）。service 方法零改动，两条路复用其底层纯件。

- **组件 A 按需端点**：`POST /canonical-companies/:id/guess-emails`（`GuessEmailsDto` 镜像 VerifyContactPointDto + maxContacts/maxProbe 护栏）→ 透传 `guessEmailsForCompany`。调用方（SaaS 前端代客户）带 LIA = per-tenant 干净合法性来源。
- **组件 B 存量 sweep 阶段⑤b**：新活动 `guessEmailsBacklog`（镜像 discoverContactsBacklog：短事务①载入→事务外 SMTP→短事务②落库→水位 stamp-all）。🔴 **双闸合规门·默认关**：全局 kill-switch `email_guess` provider（seed **DISABLED**）ENABLED **且** `config.lawfulBasis` 有合法记录才自动探测；**自动路径永不 allowPersonalWithoutBasis**（红线，单测+实测证伪）。RISKY 猜测无 outreach、suppression 不落、personal_data+lawful_basis 留痕（走未改动的 persistGuessedEmail）。
- **组件 C 水位列**：迁移加 `canonical_company.email_guess_attempted_at`（加性可空 + 索引，镜像 4 同族列）；`backlog.eligibility` 加该水位（30d TTL 防重锤 MX）+ `requireEmaillessContact` 谓词。
- 🔴 **诚实交底**：B 路径 `config.lawfulBasis` 是 **interim 全局**（ENABLED 时对所有租户套同一条），仅适用当前单客户/dev；per-tenant LIA 采集归收口⑥ DataRightsService+SaaS。默认 DISABLED 即为此设计。
- **对抗复审**（4 维·逐条对抗核验）：无 HIGH/CRITICAL；修 2 MEDIUM（自动路径 per-company SMTP 扇出无上界→大团队公司超时→水位不 stamp→重锤 MX；service/backlog 目标构建逐字重复漂移）——抽共享纯件 `buildGuessTargets`（RISKY 排除 + per-company cap 25）供两路共用一并根治 + 补 no_verifier 测试 + 清死字段。
- **实测**：build 零错 · **464 vitest** · 真库真 SMTP 真 RLS `verify-email-guess-backlog.mts` 全绿（app_user 非 superuser 硬 guard；双闸全开→真扫→真 SMTP 诚实降级 RISKY 不谎报 VALID→落库+水位 stamp；幂等 scanned=0 不重锤；两红线可证伪 DISABLED/无 LIA→skip）。
- **遗留**（后续独立 track）：待办 2 跨源身份解析（name-match 合并多源同一人）；待办 3 P1 身份源（专利/注册处/商标）。

## 2026-07-10 · 收口④ OpenAPI 单一真值 + 统一信封（PR #48，缺口#4 已修）

- **统一响应信封定稿**（PRD 11.12/11.15 + contracts README 既有约定落地）：2xx 一律 `{data}`；分页 `{data, page:{next_cursor, has_more}}`（协议键 snake_case、资源字段 camelCase）；错误 `{error}`；`/health*` 探针例外。8 控制器 38 业务操作全套 + `@ApiEnvelope/@ApiPageEnvelope/@ApiListEnvelope`（与运行时 `common/envelope.ts` 同源），响应 schema 覆盖 23 缺失→0。
- **双源消失**：删旧 3-path `openapi.yaml`；contracts lint/bundle/docs/mock/gen 5 脚本切 code-first 导出的 `openapi.json`（40 paths）；README 重写 code-first；`src/generated/api.ts` 从 JSON 重生成。顺手修 17 处 DTO 契约错型（`string|null` 联合被 swagger 推断成 object）+ create 202/201 错位。
- **CI contracts job 三道门**：`--export-openapi`（无需 DB/Temporal，假 DATABASE_URL 实测可跑）→ drift（`git status --porcelain`，抓修改+untracked+删除态）→ spectral lint → oasdiff breaking（PR base 对比；`breaking-change-approved` label 放行——本 PR 即首例，v1 无消费方是定稿零成本窗口；`review:'false'` 关掉 action 默认把私有契约上传 oasdiff.com 的外发）。
- **对抗复审**（3 维 find + 逐条对抗核验，14 agent）：11 findings → 10 确认全修 + 1 误报杀掉。HIGH×2：6 端点 13 个可选 @Query 被推断 required:true（prism mock 实测合法首页请求 422）→ 显式 @ApiQuery；Idempotency-Key 大小写不合并成双 header 矛盾参数 → 改小写合并。MEDIUM×4：事件 envelope schema 与 envelope.schema.json 双源漂移（补 10 required+枚举+3 条一致性单测）；恒在可空字段错标可缺失（@ApiProperty+nullable 正确建模）；22 处裸 `{type:'object'}` 致 codegen `Record<string,never>` 字段访问全编译错（补 additionalProperties:true）。LOW×4：drift 门 untracked 盲区、oasdiff 隐私外发、class-validator 约束进契约、INTEGRATION.md 旧示例。
- **实测**（真实数据无 sandbox）：461 vitest 全绿（TDD RED→GREEN）· `verify-envelope.mts` 真 API+真 dev 库 18 断言全绿（1040 家 canonical 真数据游标续拉不重复、真事件 snake_case envelope、404/400 错误模型、真响应逐个过 openapi.json ajv 校验）· 契约复检（query required 清零/单 idempotency header/events 10 required+enum/裸 object 清零）· CI contracts job 首跑即绿（ubuntu 重导出与提交契约逐字节一致=跨平台确定性）。
- **记档不阻塞**：Lead/CanonicalCompany 等松散 object 的结构化 DTO 待收口⑤/实体解析定型后收紧；信封扩展字段（Evidence/Quality/Rights/Freshness/Cost/Partial）随收口⑤⑥补。

## 2026-07-11 · 收口② ExecutionContext + Broker 真收口（PR #51，缺口#2 已修——R0 四刀全部完成）

- **主链全经 Broker**：新增 8 个 L0 工具（`crawl4ai.render`/`http.get`/`wikidata.entity`/`gleif.fetch`/`ted.search`/`openfda.search`/`tradefair.algolia`/`mapyourshow.fetch`，`tools/source-tools.ts`）+ 既有 5 件套，收编 22 处直连出网——发现/富集/intent/采集/理解五条链全部 `broker.invoke`（业务层直连 grep 清零）。登记例外四类注明：robots.txt 抓取（合规原语）、DNS 解析（SSRF 护栏原语）、模型网关内部 HTTP（网关层自治）、outbox relay webhook（交付账本治理）。
- **source_policy fail-closed 分层**：`ComplianceMeta.sourcePolicy = required|advisory|none`——required（受治理数据源，policyDomain 固定治理域）未登记/无 reader/提不出域一律拒；advisory（标的公司站点）登记即强制、未登记放行（robots/SSRF/DAT-011 兜底，不杀发现引擎）。删 ted/openfda 四处手写 §8.8 镜像（「无 reader fail-open」缺陷）收敛 Broker 单点；用途门按**本次调用用途**判（`ToolContext.purpose: string|string[]`，any-of ∩ 工具声明集——TED E2E 负向测试抓到交集弱化回归后补）；seed 补 6 治理域行（algolia.net ToS 灰红源如实标 REVIEWED_RESTRICTED=显性风险登记点，SUSPENDED 即全链停抓）。
- **预算真开账 + LLM 网关门**：discovery run 逐活动幂等 `open(runId, RUN_BUDGET_CENTS)`/finalize 强制 close；backlog sweep fit/contact 阶段账（BudgetLedger open/close 引用计数防并发误删 + settle 迟到句柄钳 0）；**RouterModelGateway reserve-then-settle**——`maxCostCents` 从纯声明变真闸，settle 按 token 折算实际成本（`LLM_CENTS_PER_MTOK` 保守混合价；复审 HIGH：原按上限记账令 $20 run 实为 ~100 次调用硬顶）、预算拒绝落 trace、fit 截断显性化（`stats.fitSkippedForBudget` + run 转 PARTIAL 绝不假 DONE；backlog 该页收手下轮重判）、stub fallback 零成本入账。
- **allowedTools 填实 + 灭伪 workspace**：extract_company/extract_list/find_decision_makers/extract_claims 填真实工具 id，provider 经 broker 调用绑 taskContractId（白名单真实生效）；`ExecutionContext {workspaceId, runId?, correlationId?}` 贯穿 adapter 契约（discoverCompanies/enrichCompany/discoverContacts 增 ctx），`'discovery'`×3 + `'taxonomy'`×3 伪值清零（taxonomy 无租户时跳过 LLM 冷路径）——ai_trace/usage_ledger 按真租户/run 归账。
- **实测**（真库真源无 sandbox）：`verify-broker-closure.mts` 15/15 断言（未登记拒/无 reader 拒/SUSPENDED 真库翻转 Broker 真拦/预算双门真拦截/**ai_trace 真写入** + 伪 workspace 负向对照 22P02 静默 0 行/TED 真拉 5 中标/SSRF 真拦云元数据 IP）· `verify-ted-discovery.mts` 端到端全绿（raw 13→canonical 13→CC BY 证据→真 LLM fit 四门）· 494 vitest（+33 新测）· 15 个 verify 脚本同步新契约。
- **对抗复审**（3 维 find + 14 agent 逐条对抗核验）：11 findings 确认全修（HIGH×2：预算按上限记账静默截断假 DONE、http.get redirect:'follow' SSRF 绕过→改 manual 逐跳护栏≤3 跳；MEDIUM×4：intent 用途门缺口、directory 名录页 60k→40k 上下文劣化（工具加 maxChars）、http.get 丢浏览器兼容 UA、sweep 预算生命周期注释与事实不符；LOW×3）+ 3 误报核验杀掉（含 algolia seed APPROVED——显性登记优于 main 零门现状）。
- **记档不阻塞**：整轮 sweep 硬上界需持久化账本（收口⑤/R2 预算基建）；DNS-rebinding TOCTOU 连接层 IP pinning（收口⑥安全加固）；Broker ToolTrace 落库（现 console，成本/合规决策审计表后续）；幂等闸门仍为 trace 元数据（无结果缓存）。

### 选项 B · 待办 2 跨源决策人身份解析（2026-07-11，PR #54，设计 [decision-maker-cross-source-identity-design.md](decision-maker-cross-source-identity-design.md)）

> 承接 P0.4（#49）+ 设计定稿（#53）：落库前加 `resolvePersonIdentity` 解析前置——先问「本公司是否已有同一人」，有则并入、无则新建——修 P0.4 令其更活的决策人重复 bug（email/无-email 桥 + 人名变体），并建成待办 3（专利/注册处/商标）复用缝。

- **新 `person-name.ts`**：从 `email-permutation.ts` **搬迁**人名归一（去称谓/贵族前缀/"Surname, Given" 语序/NFC/德语去音标），email-permutation 改 import + re-export，**行为逐字不变**（69 email 测全绿）。
- **新 `person-identity.ts` `resolvePersonIdentity`**：同 companyId 内 4-Tier（externalId / 邮箱精确 / 归一名精确 / 高置信模糊）。🔴 **绝不错并**：仅同公司 + fuzzy 严阈值 **0.9 + margin 0.1** + **邮箱冲突守卫**（同公司同名不同邮箱→判不同人、不并）；方向宁欠并不错并。
- **改 `contact-persist.ts`**：命中并入（title/seniority 补空不覆盖 + `identity.merge` snake_case 证据）、无则原 `contactIdentity` 键新建；`created`/`merged` 分计。**无 schema 迁移**（键形不变、matchRule 走 field_evidence、Tier0 留 TODO 供待办 3）。
- **对抗复审**（单 reviewer 逐条对抗核验）：抓 **1 HIGH（🔴 错并）**——Tier 3 原误借**公司名匹配器** `normForMatch` 剥法人后缀（co/sa/oy/as…），姓氏恰为这些真实姓氏时（"Marco Sa"/"Erik Oy"/挪威姓 "…As"）→ 剥成只剩名 → 错并两人；**已修**：Tier 3 改用人名归一 token Jaccard、不碰公司匹配器 + 锁死回归测。2 LOW（`created` 含并入、证据 camelCase→snake_case）一并修；邮箱守卫/欠并方向/重构等价/事务纪律逐条核验安全。
- **实测**：build 零错 · **521 vitest**（+3 错并回归）· 真库真 RLS `verify-cross-source-identity.mts` 三场景全绿（①一人无邮箱→带邮箱同名→并一条 ②同公司同名不同邮箱→两条不并🔴 ③"Dr. Johann Schmidt"→"Johann Schmidt"→并）。
- **遗留**：待办 3 P1 身份源（专利 inventor/注册处董事/商标申请人）——本期已建 `externalIds→Tier 0` 缝、留 TODO 空跑通。

## 2026-07-11 · 收口⑤ 一等 Signal + ingest-once（PR #56 代码 + 本 PR 文档）

**缺口#5 根治**：intent 从「JSON 投影非一等事实 + 外部源按 ICP×workspace 重复直拉」反转为两层模型。

- **平台层**：`source_signal` 一等信号表（无 RLS 零个人数据：payload 白名单显式构造 + FDA 个体户摄取层即拒 + 对抗单测锁；subject 身份键与租户 dedupeKey 同规范化；双时间轴 occurred/observed=backtest 基础；license 行级；状态机 ACTIVE→EXPIRED|REVOKED + 类型 TTL 招标 90d/清关 365d）+ `signal_ingest` ingest-once 账本。**时间窗拍板：6h UTC 对齐桶**（env `SIGNAL_INGEST_WINDOW_MS`），拉取键=(provider, 规范化查询指纹, windowKey)——跨 workspace 同参 ICP 天然共享一次拉取。
- **SignalIngestService**：经 Broker（PLATFORM_WORKSPACE + purpose=['intent','discovery']）+ `sweep:external-intent` 预算开账 + BudgetExceeded 透传；ERROR 条件记账绝不覆盖并发 OK 行（TOCTOU 护栏）；**撤即脱敏** revoke + revokeBySubjectKey/ByProvider（Art.17 路径）。**两级撤停语义拍板**：source_policy SUSPENDED=停采不停用（只拦出网），「采集被判违规」类事件用 revokeByProvider 处置存量。
- **投影反转**：TED/openFDA intent 投影只读 source_signal（fetch 拆层、构造去 broker）；FDA 码过滤下推 jsonb；扫描窗/上限截断显性告警 + subjectsTruncated 可观测。sweep 四段化（枚举→确定性解析→指纹去重拉取一次→逐 ICP 投影），expireStale 状态机先行。
- **可复算**：IntentRecomputeService（surfaces=与增量投影同过滤面——对抗复审 HIGH：防跨 CPV/跨 ICP 注入与抖动循环，不动点回归锁）；mergeIntent 去重键 epoch 归一（对抗复审 HIGH：存量旧格式 at 与新 UTC ISO 同刻去重，生产 sweep 一次重写自然收敛，无需 backfill）。web_watch 按 ADR-006 留租户轨（事实账本=source_entity_change，复算地平线=保留期）。
- **demand_proof 维切分拍板**：需求证据=TENDER_PUBLISHED+SOURCING_OPENED（FDA_CLEARANCE 属上市时机留 Intent 维）；evidence 判据强制（ADR-010）；观测维**不进总分**（乘法门待 R2 backtest ≥50 QGO 标签）；快照 v1 契约预留槽位 → **零破坏填充**（snapshot_version 保持 1，不开 v2 文件防混流；qualification_rule_version→additive-6dim-v2）。
- **实测**（真库真 API 无 sandbox，四脚本全绿）：verify-signal-first 38 断言（验收①②③各有专属断言：24 条真招标一次拉取双租户各投 18 家零出网 / EXPIRED-REVOKED 剔除+脱敏 / 复算重建 unchanged）；三旧脚本适配两层架构（真跑抓到并修 openFDA 投影 taxonomy 键大小写 bug）。547/547 vitest（+53 新测 TDD）+ build + eslint 零告警。
- **对抗复审**：3 维 21 agent 逐 finding 独立核验——14 缺陷确认全修/记档（2 HIGH 根治+回归锁）、2 误报驳回。
- **记档不阻塞**：ingest PENDING 抢锁根治 · TED CPV 前缀列+GIN 下推 · 投影上限游标化（缺口#8 同类）· license 值 SPDX 统一（随收口⑥ 权利词表）。

### 选项 B · 待办 3 首个身份源 UK Companies House（2026-07-11，PR #58，设计 [decision-maker-p1-companies-house-design.md](decision-maker-p1-companies-house-design.md)）

> 承接待办 2（#54）**兑现 `resolvePersonIdentity` 的 Tier 0 externalId 缝**：对 fit=match 英国公司 → CH 官方注册处取现任董事 → 高置信对齐公司 → `externalId(uk-ch-officer)` 走 Tier 0 精确并/新建；**同董事若也在 Impressum 出现→自动并成一条**（兑现待办 2 跨源合并）。

- 新 `adapters/companies-house.ts`（Basic auth CH client，经 ToolBroker 出网）+ `providers/companies-house.provider.ts`（`ContactDiscoveryAdapter`）；扩 `ProviderContactRecord.externalIds/license` + `contact-persist` 写 `external_id` 点/传 resolve；联系人发现改 **fan-out 全部 enabled adapter**（CH 与 decision_maker 并跑经缝合并，逐 adapter fail-safe）；seed `companies_house` data_provider（无 key 天然 no-op）+ source_policy。**无 schema 迁移**。
- 🔴 合规：**GB country 门**（非英不搜）+ 公司对齐 `pickBestByName` 0.9·margin（绝不挂错公司）+ **数据最小化**（只 name+role+officer_id，不摄 DOB/国籍/职业/住址）+ **§8.8 source_policy 用途门 fail-closed** + 董事 personalData + **OGL-UK-3.0** 署名穿透 field_evidence。
- **对抗复审**（PoC 单测在分支上实测复现）：抓 **2 HIGH 全修**——① Tier 0 缺反向守卫致同公司同名不同 officer_id 董事误并（加 `hasExternalIdConflict` 对称 email 守卫，Tier 2/3 拦冲突）；② GB 门 `.uk` 域名当辖区可绕过（`.uk` 2014 全球开放），改 country 优先（非英一律拒、`.uk` 仅缺国别弱兜底）+ 1 MED（fan-out 静默 catch 补 warn）。已核验安全：数据最小化/§8.8 门/公司对齐 margin/key 不泄漏/自足性（committed schema 构建通过，不依赖并发 storage-compliance WIP）。
- **实测**：build 0 · **610 vitest**（含错并回归）· 真库真 CH API `verify-companies-house.mts` 四段全绿（AstraZeneca 真拉 12 董事·对齐 1.00·Tier 0 二次幂等 merged=12·跨源与 Impressum 并一条·§8.8 去用途→拒→零联系人·无 DOB/国籍入库）。
- **遗留**：待办 3 后续源（专利 inventor USPTO/EPO、商标 EUIPO/WIPO；CH 扩德/法）——fan-out + Tier 0 缝已跑通，后续源同法接入。

## 2026-07-11 · 收口⑥ 存储合规 PR-B 删除编排（GDPR Art.17，六项工程收口最后一项完成）

设计见 [../implementation-records/storage-compliance-spec.md §8](../implementation-records/storage-compliance-spec.md)。承 PR-A #60（存储合规地基），本 PR 落地 DSR 删除编排，**满足收口⑥ 验收① DSR 全链演练 + ②「删除编排先于任何发送上线」时序门前置**——**六项工程收口至此全部完成**。

- **schema**：`deletion_request`（状态机 RECEIVED→FROZEN→ERASING→COMPLETED\|FAILED，租户 RLS，`stats` 持久化擦除计数）+ `deletion_receipt`（租户 RLS + **append-only** REVOKE UPDATE,DELETE + **FK onDelete RESTRICT** 防级联删绕过 + `REVOKE DELETE ON deletion_request`）+ 「同主体至多一条在途」**部分唯一索引**。
- **纯核**（+12 单测）：`deletion.types/state`(状态机)/`plan`(禁联项)/`snapshot`(最小化事件 payload)。
- **Temporal 三段编排 + 四活动（CAS 幂等）**：`freezeSubject`（定位擦除面 pre-deletion 快照 + 写 suppression_record 对外动作第一道闸 + **company 即标 SUPPRESSED**）→ `eraseSubject`（硬删 canonical_contact 级联 contact_point + 显式删 field_evidence(contact) + **擦除时刻重查 company 联系人捕漏网** + 受影响 ACTIVE ICP 发 QualifyRequested 重评分 + 同 tx 持久化 stats）→ `completeDeletion`（写回执 append-only + DeletionCompleted 事件同 tx + **取持久化 stats 写忠实回执、拒绝为未擦除请求伪造回执、CAS 收尾**）。
- **`DeletionService`**：受理 → **事务性 outbox 发 DeletionRequested** → relay dispatch 起 deletionWorkflow（Temporal 暂挂靠 relay 重试起，「受理即必然执行」）；`createRequest` catch P2002 → 复用在途请求（并发去重）。**`DeletionController`** `POST/GET /deletion-requests`（authN + RLS 隔离，**无 RolesGuard**=授权归 SaaS，R1 加固）。
- **outbox 注册** DeletionRequested(internal)+DeletionCompleted(integration) + 契约 `deletion-completed.v1.schema.json`。
- 🔴 **合规红线**：located 进 Temporal 历史 **PII-free**（只 uuid+计数，禁联邮箱仅 freeze 内部落库不外泄）；`source_signal` 是**平台共享零-PII 绿库** → 租户 DSR **不撤**（避免跨租户误删），signalsRevoked 恒 0；回执/事件**内容最小化**只计数 + 行 id 引用；receipt DB 层 append-only + FK RESTRICT 双护 GDPR Art.5(2) 问责证据。
- **质量**：TDD **682 单测**（12 新纯核）+ **真库 DSR 全链演练 31 断言全绿**（contact/company 主体 + 幂等 + 无 PII 残留 + RLS 隔离 + 并发去重 + 部分失败忠实回执 + append-only 护证 + 擦除完整性）+ **对抗复审（5 维·16 agent·逐条 adversarial 核验）6 findings（11 raised）去重 4 根因全修**：F1 部分失败伪造 0 回执（stats 持久化 + 拒伪造 + CAS）、F2 append-only 被级联删绕过（FK RESTRICT + REVOKE DELETE）、F3 createRequest 并发竞态重复请求（部分唯一索引 + P2002 复用）、F4 company freeze→erase 窗口漏网新联系人（freeze 即 SUPPRESSED + 擦除时刻重查）；驳回 HIGH「verify 不真跑 Temporal」（测试覆盖 gap 非可触发缺陷）。openapi 无 drift。
- **下一步**：R1 发送侧上线时联合校验「删除编排先于发送」时序门；细粒度 RolesGuard、consent_record(Art.21)、retention sweep 随 R1；`verify-deletion-orchestration.mts` 后续可补 Temporal 端到端（现活动级）。

## 2026-07-11 · 收口⑤ fast-follow：外部源 intent 投影 live 重读 DataProvider kill-switch（Codex #56 P1）

Codex 复审 #56（收口⑤ 一等 Signal）提 **P1 TOCTOU**：`temporal/external-intent.activities.ts` 的 `projectExternalIntentForIcp` 只认 sweep 头部 `listExternalIntentTargets` **捕获的** `tedEnabled/openfdaEnabled` 标志。摄取活动 `ingestExternalSignals` 已逐指纹 `liveEnabled` 重读 `data_provider`，但投影此前只受**捕获门**——若 provider 在捕获之后被 ops 置 DISABLED（`DataProvider.status`=Kill Switch 执行点），投影仍会把缓存 `source_signal` 投进本租户 canonical **造新线索**，绕过摄取侧的 live kill-switch（原 verify Tier 5 只喂 `tedEnabled=false` 走 trivial 分支，从未覆盖「捕获=true 但 live=DISABLED」的真缺口）。

- **修**：`projectExternalIntentForIcp` 投影前 `liveEnabled()` 重读 `data_provider`，`tedOn = 捕获标志 && live.ted`（openfda 同），对齐摄取侧逐单元重读纪律——provider 中途下线本轮即不投影。kill-switch 自此是**非破坏性「停一切新活动（含新线索）不脱敏存量」**闸，填补 SUSPENDED（太软·仍投）与 `revokeByProvider`（太硬·脱敏存量）之间的空档。
- **刻意不做**：**不**在投影加 `source_policy` SUSPENDED 门。SUSPENDED=**停采不停用**（egress-only，见 [../architecture/current.md](../architecture/current.md) §5 两级撤停语义）——停「用」存量信号的正解是 `revokeByProvider`（翻 REVOKED，投影已按 `status='ACTIVE'` 剔除）。在投影加 SUSPENDED 门会违背该设计。Codex 建议「re-check live provider state」被采纳（=DataProvider kill-switch）；「skip cached signals while suspended」按两级语义驳回并说明。
- **实测**：build 0 · **673 vitest**（新增 `external-intent.activities.spec.ts` 3 测：捕获 true+live DISABLED→跳过该 provider / 双 ENABLED→均投 / 双 DISABLED→全跳）· 真库真 TED/openFDA `verify-external-intent-sweep.mts` 全绿（Tier 5 加 **TOCTOU 断言**：喂过时 `tedEnabled=true` + `data_provider` DISABLED → 投影 live 重读 kill-switch，TED 仍跳过；Tier 4 正路 64 信号→50 买方 canonical 不受影响）。**无 schema 迁移**。

## 2026-07-11 · 待办 2 create 层收尾：createContact 尊重 resolve 拒并（#54-D/#54-E / Codex #62-2/#62-3）

> Codex 复审（PR #62 P2 + 重开 #54 P1）暴露待办 2 遗留缺陷：`resolvePersonIdentity` 的合并守卫被 `persistDiscoveredContacts`→`createContact` 的 `contactIdentity` **键控 upsert 旁路**——resolve 明确「拒并」（同名歧义 / RISKY 猜测邮箱）返 null 后，create 层仍按键相同的旧行 upsert，把新记录并回错行，令拒并形同虚设。**先合入 #62（resolve 层拒并的另一半，含 Tier 1 RISKY 跳过 + Tier 2 唯一才并 + external_id 不算可达），再补 create 层**（本 PR）——两半齐落才真正闭合误并。

- **`resolvePersonIdentity` 返富结果 `{hit, ambiguous}`**（`person-identity.ts`；`resolveAmongCandidates` 保留为薄封装、签名与其 ~25 单测不变）：`ambiguous`=因**同名歧义**拒并（Tier 2 ≥2 合格同名候选 / Tier 3 高分但 margin 不足），**与 DB 当前占位无关**（只看候选语义）——这是幂等的关键（见下）。
- **`createContact` 拒并键**（`identity.ts` 新纯件 `declinedContactIdentity` + `contact-persist.ts` 守卫）：resolve 返 null 时，若 `ambiguous || 明文键（盲值）与既有**不同**联系人碰撞`（`findUnique` 探测，同 tx 读己写），改用**不碰撞确定性拒并键**新建独立行——`dx:` 命名空间与明文 `e:`/`c:` 互斥、按 `companyKey` 隔离；判别符优先级 **externalId `dx:x:<ck>:<scheme:value>` > 可信 email `dx:e:<ck>:<归一名>:<email>` > 人名 `dx:c:<ck>:<归一名>`**。可信 email=明文键 `e:<email>` 未被占用（非 catch-all/RISKY 共享地址），占用则退回人名。拒并键盲化落库（复用 #65 `blindContactKey`，去 PII 明文）。
- 🔴 **绝不错并**：同名不同 externalId（HIGH-1）/ 同址不同名（catch-all，#54-E）/ **同名不同 VALID 邮箱**（名+邮箱双判别符）三类全分开。**同源再跑幂等**：`ambiguous` DB-state 无关 + 拒并键确定性 → 二次跑落回同一行、不生重复（纯碰撞探测会在「歧义但来件明文键恰空」翻键生第三/四行，故 `ambiguous` 信号必需）；正常合并/新建路径行为逐字不变（EPO/CH verify 二次跑 created=0 不破）。
- **质量**：TDD **725 vitest**（新增 `declinedContactIdentity` 单测 + `createContact` 歧义/RISKY/误并回归 + `resolvePersonIdentity` `ambiguous` 信号）· build 0 · 真库真 RLS 真盲化 `verify-contact-decline-honor.mts` **三场景全绿**（① RISKY 同址不同名新建+二次跑幂等 ② 歧义无邮箱新建独立行+二次跑不生第 4 行 ③ 同名不同邮箱各自成行+二次跑幂等）。**对抗复审 3 维（误并 / 幂等 / 集成完整性，逐条 adversarial + 修后再攻）**：误并维抓 **1 HIGH**（`dx:c` 只按名致同名不同 VALID 邮箱塌键=净新误并）→ 补 email 判别符 → 再攻确认闭合 + 补**名+邮箱双判别符**闭合「不同名共用 catch-all」残余（LOW）；幂等维 5 场景全幂等；集成维 6 类（ripple/blinding/regression/completeness/tx/test）全净。**无 schema 迁移**。#62 的 2 条 Codex 线程已回复「create 层于本 PR 修」并 resolve。

## 2026-07-11 · 收口⑤ fast-follow²：外部源 intent 投影 kill-switch 单次重读优化（承 #64）

承 #64（Codex #56 P1，投影每 ICP `liveEnabled()` 重读 DataProvider kill-switch）。#64 的 per-ICP 重读正确但每 ICP 一次 owner-DB 读；本 PR 把它降到**每 sweep 一次**，同时**不丢活动自守与任何既有保证**（保严格性优化，非「移守卫出活动去信任调用方」的降级式改法）。

- **workflow 单次读 + thread**：`externalIntentSweepWorkflow` 摄取后调**一次** `liveProviderState()`（新活动=`liveEnabled()` 薄封装），把 `LiveProviderState` 快照 thread 给逐 ICP `projectExternalIntentForIcp`。取「投影阶段开始前一刻」的 live 态——覆盖 #64 关掉的**主窗口**（sweep 头部捕获→摄取全程分钟级 egress→投影开始），残留仅投影循环自身（零出网、下轮自愈）。
- **投影活动保留自守（防御纵深）**：`projectExternalIntentForIcp` 新增可选 `live?: LiveProviderState`，`const live = args.live ?? await liveEnabled()`——**注入优先**（省读），**缺省自读兜底**（直连调用者=测试/verify/未来调用不被信任，#64 的 TOCTOU 断言与单测零改动仍绿）。仍逐 ICP AND 各自捕获标志（捕获=false 者无论 live 都不投）。workflow 单次读失败 fail-safe→undefined→投影自读兜底（一次读故障不放大成整轮不投）。
- **刻意仍不做**：`source_policy` SUSPENDED 门不入投影（停采不停用，见 §4/#64）。
- **实测**：build 0 · **759 vitest**（新增注入快照 4 测：注入门控且零自读 / 注入优先 / 捕获标志不被绕过 / 缺省自读兜底）· 真库真 TED/openFDA `verify-external-intent-sweep.mts` 全绿（Tier 5 加：`liveProviderState` 单次重读 + 「data_provider ENABLED 但注入 live.ted=false → 投影用注入快照跳过 TED」证明非自读）。**无 schema 迁移**。

## 待办 3 第二源 · 专利发明人 BigQuery Google Patents（替代被封 EPO OPS）

- **背景**：EPO OPS（PR #61）账号被网关封停、PatentsView 卡 ID.me 美国身份墙 → 专利发明人源改走 **BigQuery Google Patents Public Data**（`patents-public-data.patents.publications`，IFI CLAIMS 谐调）：仅需 Google 账号，**无审批/无身份墙/无封号风险**，1TB/月查询免费。
- **DRY 源无关移植**：provider（`bigquery-patents.provider.ts`）几乎原样移植自 #61 `epo-ops.provider.ts`——那套护栏源无关，只换 L0 数据客户端（EPO OPS REST → BigQuery）。保留：applicant 高置信对齐（0.9·margin 0.1）+ 归一名去重候选 + **只取独家申请人专利**（防合著误挂）+ 国别门 + 近 5 年·cap 25 + **归一名并（非 Tier 0，无 externalIds）**。
- **L0 adapter**（`adapters/bigquery-patents.ts`）：`assigneeLikeAnchor` 宽预筛锚（provider 再精确对齐）+ `buildQuery` 只 SELECT 2 列 + **`maximumBytesBilled` 成本硬顶**（默认 200GB，超顶即 fail-closed，护免费额度）+ `normalizeRow` 🔴 **数据最小化**（inventor 只留 name，丢 country_code）+ 无 SA key/project → 天然 no-op 返空。
- **合规**：`google_patents.search` = required 工具（personalData=true，policyDomain `bigquery.googleapis.com`，§8.8 用途门 fail-closed）+ CC-BY-4.0 署名写 `field_evidence.license`（⚠️ ENABLE 前核实确切 attribution 文案）+ SA key 文件 gitignored（`.env.example` 记 `GOOGLE_PATENTS_SA_JSON`/`_PROJECT`/`_MAX_GB`）。
- **⚠️ 规模警示**：publications 表无 assignee 分区 → 每查全表扫描（约数十 GB/查）→ 适合有界样本/周期 sweep，不适合高频实时逐公司；生产规模 fast-follow = 物化「assignee→inventor」小表。
- **seed DISABLED**：`google_patents` data_provider 种 DISABLED（真库真测待 GCP key），`bigquery.googleapis.com` source_policy APPROVED（供 verify 过 §8.8 门）。verify 脚本直 new Provider 跑，DISABLED 不挡真测；生产 fan-out 不路由（无静默错采）。
- **质量**：build 0 · eslint 0 · **909 vitest**（新增 33：adapter `assigneeLikeAnchor`/`normalizeRow` 数据最小化/成本护栏 env+默认路径/无 creds fail-safe + provider 全护栏移植测）。**无 schema 迁移**（新增依赖 `@google-cloud/bigquery`）。EPO 代码 PR #61 留档 DISABLED。
- **✅ 真库真 BigQuery 四段 verify 全绿**（2026-07-14，用户 GCP key，无 sandbox）：A 真 API Siemens(DE)→**25 名真实发明人**六护栏全绿；B 落库 25 + person.profile CC-BY-4.0 署名/personal_data、无 external_id 点、二次幂等（created=0/merged=25 Tier 2 归一名）；C 跨源并 match_rule=name_exact；D §8.8 用途门 DENIED 零发明人。对抗复审 APPROVE（0 CRITICAL/HIGH，1 MEDIUM「MAX_GB=0 静默默认」+ 2 LOW 均已收）。
- **⚠️ seed 仍 DISABLED（刻意）**：verify 证明源可用，但 publications 无 assignee 分区 = 每查全表扫（数十 GB）→ 生产逐公司 fan-out 会快速吃光 1TB/月免费额度。**生产启用 = 物化「assignee→inventor」小表 fast-follow**（scale-safe），非直接翻 ENABLED 全量 fan-out。
