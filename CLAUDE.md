# CLAUDE.md — 项目记忆（每会话自动加载）

> 给接手本仓库的 Claude Code 会话（本地 Mac）。随 git 同步，是跨会话的权威上下文。
> 当前状态与待拍板看 [docs/status/current.md](docs/status/current.md)；收口与路线看 [docs/roadmap/release-plan.md](docs/roadmap/release-plan.md)；历史实施日志看 [docs/roadmap/changelog.md](docs/roadmap/changelog.md)。

## 1. 这是什么 + 边界（关键）

出海企业 **AI 全球客户开发与增长执行平台**的**增长业务后端**。

- **我们只做增长后端**。完整 SaaS 平台（前端 + 独立服务器 + 独立 DB + 全部用户/权限/登录/鉴权）由**另一个开发者**做，前后端分开开发、后期接口对接。
- 本后端**不做身份系统**：只校验 SaaS 平台签发的 token（JWKS 验签）→ 解出 `workspace_id` / `user` / `roles`。不签发、不刷新、不管用户表。
- 不为前端并行造 mock、不等前端。接口 code-first OpenAPI，后期交付。

## 2. 技术栈 / 架构

- **NestJS 单体（模块化）+ Prisma + PostgreSQL**（多租户 **RLS**：`app_user` 连接 + `set_config('app.current_workspace_id')` + `current_workspace_id()` policy；owner 连接绕 RLS 供 relay/seed）。
- **Temporal** 持久工作流（understanding / discovery / qualify）；**Transactional Outbox** + relay 发领域事件。
- **模型网关 = new-api 中转站**（单一 OpenAI 兼容端点）。可用模型：`deepseek-v4-flash` / `deepseek-chat` / `deepseek-reasoner` / `gemini-2.5-flash` / `gemini-2.5-pro`（gemini-2.0/3.x 不可用）。
- **发现四层**：L0 Tool → L1 ProviderAdapter（按 SourceClass）→ L2 AI Task（有界任务契约，**非超级 Agent**）→ L3 Temporal Workflow。**ToolBroker** 是唯一确定性执行闸门（allowedTools 白名单 + 预算 reserve-settle + 限流 + source_policy + 幂等 + trace）。
- **MCP = 传输非授权**，第一步不做；第三方 MCP 内化到 ProviderAdapter 后面。

## 3. 开发环境

**Docker 服务**（`docker compose -p global up -d`，data-root 落 8T 盘 `/data/docker`）：postgres `:5432`(pgvector/pg16, global/global/global_dev) · redis `:6379` · **new-api** `:3001`(模型网关，key 在 `apps/api/.env`) · **crawl4ai** `:11235`(token 在 .env) · **searxng** `:8081`(配置 `infra/searxng/settings.yml`) · **minio** `:9000/9001` · **embeddings**(ollama `:11434`，模型 `bge-m3` 1024 维) · **docling** `:5001`。共 8 个，容器名 `global-*`。
**Temporal** 不在 compose：Ubuntu 上跑成 systemd 服务 `temporal-dev.service`（开机自启、`:7233`）——用 `systemctl status/restart temporal-dev` 管，不再手动 CLI。

**跑起来**：
```bash
pnpm install
cd packages/db && DATABASE_URL=postgresql://global:global@localhost:5432/global_dev pnpm exec prisma migrate deploy && pnpm exec prisma generate
DATABASE_URL=... node apps/api/scripts/seed-taxonomy.mjs        # 词表种子（需先 build）
pnpm --filter @global/api build                                 # 或 start:dev（watch）
pnpm --filter @global/api start:dev    # API
pnpm --filter @global/api worker       # Temporal worker
cd apps/api && pnpm test               # vitest
```
data_provider 源（gleif/directory/trade_fair/wikidata/…）在 **API/relay 启动时自动 seed**。

**开发环境**（同步到 git `global-backend` 私有仓库）：**Ubuntu 26.04 服务器**（Tailscale 内网 `100.88.153.74`，root，63G/4 核 + 外挂 8T `/data`），代码在 **`/global/backend`**，开发模式 = **CC SSH 远程**；Mac 现为瘦客户端。迁移细节见 memory `ubuntu-server-migration`。~~本地 Mac `/Users/xin/Documents/Global`~~（2026-07-15 迁走）、~~远端 WSL~~（2026-07-14 取消）均已弃用。

## 4. 已落地子系统（真实数据、已实测）

- **多源发现** → `canonical_company`：`public_web`(SearXNG+Crawl4AI+Gemini) · `wikidata`(SPARQL) · `openstreetmap` · `directory`(名录列表抽取，实测 151 家) · **`trade_fair`**(展会参展商，RX/Algolia 直连 API，实测 EuroBLECH 398/909)。executeQuery **fan-out** 到 source_class 全部 ENABLED 适配器。
- **富集**（`enrichRun`，fit 门后只富集 match 公司，**attributes 按源命名空间** `attributes.gleif.*`/`attributes.wikidata.*`）：`gleif`(LEI/法人形式/母子关系) + `wikidata`(行业/产品/员工/财务/官网)。共享 `discovery/name-match.ts`（置信门槛 0.72 + 歧义边距，**绝不贴错身份**）。
- **决策人抽取** `contact.find_decision_makers`：Impressum/管理层/团队页 → 具名人 + 职务 + 角色分类（对齐买家委员会）。具名人标 `personalData=true`。
- **采集监控层**（源无关·平台级共享·无 RLS）：`monitored_source`/`source_entity`/`source_fetch`/`source_entity_change` 4 表 + `AcquisitionService.acquire`（抓取→清洗→落库→增量 diff，防误杀阈值）+ **Temporal Schedule 定时 sweep**（`acquisitionSweepWorkflow`，`nextFetchAt` 到期自动增量）。源适配器 `trade_fair`(RX/Algolia，实测 INTERPHEX 美国 602 家/12 国) + `mapyourshow`(MYS 无鉴权 JSON，实测 321)。
- **v3.0 信号富集**（零付费，signal 源只写 `attributes.*` 喂 Intent/Reachability 评分，走 enrichRun 命名空间+field_evidence+幂等）：`digital_footprint`(官网 HTML/DNS→技术栈/在投广告/服务市场/邮件商/JSON-LD 事实) + `structured_harvest`(sitemap→careers/招聘信号)。设计见 [buyer-intelligence-v3.md](docs/research/buyer-intelligence-v3.md)。
- **自建邮箱验证** `smtp_self`（v3.0 #3）：MX + SMTP RCPT 握手自校验 + catch-all 检测 + SSRF 护栏；Gmail/M365/catch-all/端口不可达 一律 **RISKY**（不谎报 VALID），写 `contact_point` 验证生命周期。
- **网站变更 = intent 引擎** `web_watch`（v3.0 #4，`apps/api/src/intent/`）：**复用 `source_entity_change` diff**，锚点从「公司记录」换成「目标公司意图承载页」（产品/招聘/供应商招募·RFQ/新闻）。逐页抓渲染 HTML→抽结构化意图信号（page-signals，纯）→ **signalHash 只覆盖信号字段**（cosmetic 抖动不误触发）→ 前后快照 diff 出**具体 delta**→ 每条 = 一条 intent 事件（`SOURCING_OPENED`/`HIRING_UP`/`NEW_PRODUCTS`/`NEWS_POSTED`/`PAGE_CHANGED`，带强度+证据）。真实站多不发 Product/Article JSON-LD → 产品/新闻靠**主内容锚点链接**（去 nav/footer）；实测 TRUMPF supplier→`supplier_program`、Flex→3 招募词、products→主内容 7 品类、newsroom→8 新闻指纹。独立 `intentSweepWorkflow`+Schedule（与通用采集 sweep 分离，registry 正向过滤）；DAT-011 SUSPENDED + robots + crawl4ai SSRF 守；🔴 新闻只存**指纹哈希**（不落标题/人名）、事件证据仅数量；保留期清理（GDPR 存储限制）。租户经 `IntentProjectionService` 按 `companyIdentity` dedupeKey 投影进 `attributes.intent.*`。
- **存量对账管线**（2026-07-08 通脉）：`backlogSweepWorkflow`（Schedule 24h + `scripts/run-backlog-sweep.mts`）对**不属于任何 run 的存量公司**（投影进来的 900+ 家，此前永远够不到 fit 门）做 资格门→富集→信号→web_watch→联系人→重评分 全链对账（`fit-judge.ts` 共享四门核心、`id>cursor` 防活锁、批量+轮次双上限、DAT-011、ownerDb 仅平台级只读扫描）。**队列门**：`scoreLead` 的 `authoritativeFit` 只覆盖 Fit 维，recommended=六维总分≥0.55 **且 Reachability>0**（联系不上的不算推荐）。联系人发现首选 `decision_maker`（Impressum 具名决策人，🔴`person.profile` 证据 + `personal_data` 标记，`contact-persist.ts` 共享持久化）。worker 启动幂等 seed + 三 Schedule 自愈（acq/intent/backlog）；intentSweep 尾部 `projectIntentAllWorkspaces` 自动投影（loop 真收口）；`finalizeRun` 自动发 `QualifyRequested`；fit-judge **拒绝 stub 兜底假判定**。**dev 实测**（有界样本 `run-backlog-sweep --fit-batch=10 --max-fit-rounds=1` 等·真库真 crawl·无 sandbox）：首轮冷样本 6 阶段全产出——资格门 10 判/1 match、快事实 10 尝试、信号 4 抓/3 命中、web_watch 注册 4、联系人 5 尝试/1 具名、scored 1040 全量重评；重跑呈**正确幂等**（TTL 新鲜/已注册/已建联系人的行跳过）。**对抗式复审（5 维·14 agent·逐条核验）6 findings**：已修 3 手术刀——队列门 Reachability 硬底补齐**非权威（fitVerdict=null）路径**（此前老路径漏出「联系不上的伪推荐」）、DAT-011 监控注册阶段补 SUSPENDED 守、6 阶段静默 catch→log.warn；🟠 下游 enrich/signal/watch/contact **跨-sweep 游标复位+集不收缩→预算位次后公司饿死**（本 PR 立论 bug 在下游复现）走 fast-follow（根治需 schema 水位列 `lastEnrichedAt/lastSignalAt/lastWatchAt/contactDiscoveryAttemptedAt` + 迁移）。
- **TED 招投标 provider**（2026-07-09，P1+P2+P3，[ted-provider-spec.md](docs/implementation-records/ted-provider-spec.md)）：欧盟采购官方 API（零鉴权 REST，绿事实 CC BY 4.0），归 `public_intelligence` 复用全管线、无需新 SourceClass。**P1 中标发现**（`adapters/ted-api.ts` + `discovery/providers/ted.provider.ts`：expert query/ITERATION 滚动/多语言 eng 优先解包/缺键当 null；中标方 `winner-name`+国别税号 → `ProviderCompanyRecord`，URL 身份安全归属）。**P2 ICP→CPV**（`discovery/icp-to-cpv.ts` `resolveIcpToCpv`=crosswalk 锚定+product 精修**限子树**+country 覆盖门 `icp_fit_warning`；**§8.2** 暴露 taxonomy `crosswalks`（`resolveCpvForProduct` 枚举限子树前缀·去尾零）；**§8.7** `generateQueryPlan` **确定性注入** TED 查询、LLM 不臆造 CPV；CPV 子树种子）。**P3 招标 intent**（`adapters/ted-api.ts` `searchContractNotices` cn-standard 只取绿字段 + 抽共享 `fetchNoticesRaw` 分页；`intent/ted-intent-projection.service.ts` `projectTenders`：**招标=买方需求**，买方 name+alpha-2 归并取最新发布日 → upsert canonical(有则更新/无则建线索) → `attributes.intent.events[{type:'TENDER_PUBLISHED', at:<发布日 ISO>, strength 0.9}]` → 动六维 Intent 维，复用 `mergeIntent`，新 event type 无需改评分）。🔴 合规：CC BY 署名（发现证据 `field_evidence.license` 修，非硬编码 licensed；P3 新建买方另写 `identity` 署名行）+ `winner-email`/`buyer-email` 不入绿库 + `source_policy` **用途门** fail-closed（个人数据源直连前必校验，P3 直连亦过同一 §8.8 门）+ 国别税号身份**按 alpha-2 国别限定**（防跨境同号误并；P3 无国别招标跳过同理）+ ISO-3→alpha-2 归一 + §8.6 发布日 `tedDateToIso` 归一（防 Date.parse NaN 静默 0 分）。**实测**（真库真 API 无 sandbox）：泵+德国 真拉 12~29 家中标（BBA Pumpen/KAESER，真税号）、ICP「pumps+德国」→CPV→buyer_country→TED 闭环；P3 泵+德国近 90 天 24 条开放招标→18 家买方 canonical，Intent 0→0.8657、同参再跑幂等（evidence 36→36）、SUSPENDED→零落地。质量：TDD 261 测 + 3 轮对抗复审（P1 修 1 HIGH、P2 修 3 findings、P3 修 5 findings 含 §8.8 门/幂等/无国别防误并；幂等修复被实测反抓 jsonb 键序 bug）。招标 P3 投影已**上 Temporal Schedule**（见「外部源 intent sweep」P5 · PR #38）。**下一步**：P4 招标 SAM.gov Sources Sought（早数月意图）。
- **openFDA 认证注册库 provider**（2026-07-09，P1 器械注册发现 + P2 ICP→FDA 产品码映射，[openfda-provider-spec.md](docs/implementation-records/openfda-provider-spec.md)）：美国 FDA 官方开放数据 API（`api.fda.gov`，零鉴权、**CC0 公共领域**）。`device/registrationlisting` = 「正在合规卖进美国」的规管品类活跃公司名单，归 `public_intelligence` 复用全管线、无需新 SourceClass。**P1 发现**（`adapters/openfda-api.ts` + `discovery/providers/openfda.provider.ts`：search 构造/有界分页 skip≤25000/`openfda` 谐调块缺块当 null/判 error.NOT_FOUND 空/429 退避；establishment → `ProviderCompanyRecord`，`name+iso_country_code` 主键、FDA 注册号→`fda-reg` 全局唯一 scheme、externalId 无号退 name:country 防跨国互撞；分类事实取**匹配搜索码**产品、`attributes.products`=device_name 喂 fit 门；无 product code → fail-safe 空）。**§8.1** 美国进口商=`initial_importer_flag:Y`（**非** establishment_type:Importer）。🔴 合规（**与 TED 关键差异**）：CC0 **署名非义务**（`license='CC0-1.0'`，非 TED 强制 CC BY）+ `us_agent`/`owner_operator`/`contact` 具名个人**不入绿库**（CC0≠GDPR 依据）+ **「注册≠核准」文案红线**（`attributes.fda.disclaimer`）+ `source_policy(api.fda.gov, personalData=true)` §8.8 门 + MAUDE/FAERS 不摄入。**实测**（真库真 API 无 sandbox）：LLZ 放射影像美国进口商 27 家（Philips Ultrasound/GE Healthcare/Karl Storz）→ canonical 27 + CC0 证据 108 → 无具名个人 → §8.8 SUSPENDED 零落地。质量：TDD 289 测 + 1 轮对抗复审（4 findings 全修）。**P2 ICP→FDA 产品码映射**（`taxonomy-resolver.resolveFdaProductCode`：产品词精修**枚举限 panel 子树**[`parentCode ∈ panelCodes`，FDA 3 字母码无前缀层级靠显式父维]+ `listFdaProductCodes` 宽网，**复用 parentCode 列零 migration**；`discovery/icp-to-fda.ts resolveIcpToFda`：industry `crosswalk.fdaPanels` 锚定 + 精修 + 宽网 + 直锚码**并集**；`icp.service injectFdaQuery` 注入；**国家维与 TED 反**=全美市场无覆盖门、选**贸易侧** importer/manufacturer；curated 种子 6 panel + 6 放射码 + ISIC 医疗器械节点，实测 ICP「放射器械+进口商」→ RA 码 → 闭环真拉 25 家在美进口商）。质量 TDD 302 测 + 2 轮对抗复审（P1 4 findings、P2 6 findings 含 wikidata QID 错锚[Q12140 药品→Q6554101 器械]/panel 过度声明/贸易侧兜底）。⚠️ fit 门先前受**网关 Gemini 额度耗尽(429)**阻（#35 已改路由 deepseek 恢复）。**P3 510(k)→intent**（`adapters/openfda-api.ts` `search510kClearances`/`build510kSearch`/`map510k`/`fdaDateToIso`/`isClearedDecision`；`intent/openfda-intent-projection.service.ts` `projectClearances`：**510k 具名申请人清关=新品/上市时机**，申请人 name+alpha-2 归并取最新决定日 → upsert canonical(有则更新/无则建线索) → `attributes.intent.events[{type:'FDA_CLEARANCE', at:<决定日 ISO>, strength 0.85}]` → 动六维 Intent 维，复用 `mergeIntent`、新 event type 无需改评分）。🔴 §8.6 gotcha#6 **只对正向清关投**（`isClearedDecision`=SE 家族+SN/ST/PT/SI+DENG；NSE/被拒/撤回排除，绝不给被拒公司误加分）+ §8.6 `fdaDateToIso` 归一(紧凑 YYYYMMDD 防 NaN 静默 0 分) + CC0 **署名非义务**(`license='CC0-1.0'`) +「清关≠核准」`attributes.fda.disclaimer` 恒置 + contact/us_agent 不入绿库 + §8.8 用途门 fail-closed + §6 **高精度**个体户边界(只判头衔/"Surname, Given"，绝不按形状误伤真公司)。DRY：`sameIntent`/`canonicalize` 上移 `intent-projection.service.ts` 供 TED/openFDA 共享，`mergeIntent` 排序比较器改一致(相等 at 保序)。**实测**（真库真 API 无 sandbox，五段全绿）：ICP「AI 放射软件 QAS」近 1 年 16 条清关(Qure.Ai/Aidoc/Ischemaview…IN/TW/US/CA/ES/IL)→ 11 家去重 canonical + 11 FDA_CLEARANCE、disclaimer/CC0/无 PII、幂等(evidence 22→22)、Intent 0→0.0252、§8.8 SUSPENDED 零落地。TDD 339 测 + 对抗复审（3 维·7 agent → 4 findings 全核验，2 条真机制加固：比较器一致性 + 共享幂等基石单测）。510k intent 投影已**上 Temporal Schedule**（见「外部源 intent sweep」P5 · PR #38）。**下一步** P4 `attributes.fda.*` 富集 · monitoring sweep · foiclass 全表种子扩专科。PR #34/#36/#37。
- **外部源 intent sweep 上 Temporal Schedule**（P5，2026-07-09，loop 收口）：把已落地的两 P3 intent 投影（TED 招标 `TENDER_PUBLISHED` + openFDA 510k 清关 `FDA_CLEARANCE`）接进**第 4 个周期 Schedule**（`temporal/external-intent.{activities,workflow}.ts` + `ensure-schedules.ts`，默认 6h、overlap=SKIP、env 可调、worker 启动幂等自愈）——此前只在 verify 脚本活、生产永不触发。`listExternalIntentTargets`（ownerDb 只读枚举**全部** ACTIVE ICP——**无静默截断**防旧 ICP 饿死，稳定序 id asc；+ `ted`/`openfda` data_provider ENABLED kill-switch）→ 逐 ICP `projectExternalIntentForIcp`：ICP `companyAttributes`/`targetMarkets` → **确定性**(`allowLlm:false`，调度不臆造码/可复现/零 LLM 成本) `resolveIcpToCpv` + `resolveIcpToFda` → `projectTenders` + `projectClearances`。各 provider 独立 enabled 门 + 单 provider/ICP 失败 fail-safe；投影写走 `withWorkspace`(RLS)，跨租户枚举走「受信系统扫描器」先例；§8.8 门由两 service 各自守；worker 抽共享 `TaxonomyResolver` 一实例。**实测**（真库真 API 无 sandbox，`verify-external-intent-sweep.mts` 四段全绿·活动级）：pumps+EU→CPV 1 码→**68 招标→54 买方→54 TENDER_PUBLISHED**；radiology+US→6 FDA 码→**82 清关→70 公司→70 FDA_CLEARANCE**；`ted` DISABLED→跳过。340 单测 + 对抗复审（1 finding 加固：去枚举静默截断防饿死）。PR #38。
- **词表归一**：`canonical_taxonomy` + `term_alias`（ISIC + ISO3166 + **CPV 子树**，265 节点），`TaxonomyResolver`（确定性 + LLM 冷路径 + `crosswalks` 暴露供 ICP→CPV）。
- **接口门户** Scalar `/api/portal`；**JWKS 鉴权**（生产禁 dev stub）；helmet+CORS+限流护栏。

## 5. 硬约束 / 决策（别违背）

- **真实数据，不用 sandbox**；要真实测试 + 评判。跑 provider 用 `node --import tsx` 或 `npx tsx`，脚本放 `apps/api` 且手动载 `.env`（ESM 相对 import 按文件位置解析）。
- 🔴 **合规红线**（详见 [trade-fair-intelligence.md §0](docs/implementation-records/trade-fair-intelligence.md)）：**技术能抓 ≠ 合规能用**。RX 官网 ToS 禁爬；用 public key 打 Algolia 撞其 ToS §4.5(h)（灰偏红）；个人数据受 GDPR Art.14（欧盟「公开≠可自由再用」）。**数据分级**：🟢公司事实+GLEIF(CC0) 可商用 / 🟡职能邮箱 走 ePrivacy / 🔴人名邮箱·联系人 默认隔离 + LIA。
- SearXNG 用**放行侧引擎**（Yandex/Marginalia/Mojeek）——Mac 网络对消费级搜索引擎做 SNI 过滤。
- Provider/富集失败 **fail-safe 返回 0/miss**，不阻断其余源；单展会/单源失败不影响整体。

## 6. 下一步（v3.0 买家智能 P0，[buyer-intelligence-v3.md](docs/research/buyer-intelligence-v3.md)）

> 🔴 **2026-07-13 起获客侧开发暂停**（用户指示，明确通知才恢复）。**当前主线 = 独立站建设（Site Builder）**：设计文档 8 份见 [docs/site-builder/](docs/site-builder/)（01 PRD / 02 架构+决策 D1-D16 / 03 agents 详设 / 04 SiteSpec 契约 / 05 部署托管 / 06 安全滥用 / 07 API 草案 / 08 评测测试）；工作流程红线=**先研究对标→讨论→用户认可→才提交**。本节以下为获客侧冻结内容。

核心反转：从「公司名单」→「可成单线索」（补三缺环：**需求证据/对的人/时机**）。**免费优先**，复用已有基建（diff→网站变更 intent、pgvector→look-alike、name-match→consignee 实体解析、first-seen→新进口商、crawl4ai 抓包→通用 API 逆向）。

- P0 复用四件套 ✅ 全部落地（见 §4）：✅ `digital_footprint` · ✅ `structured_harvest`（下一步主路加**自有 ATS JSON 逆向** Greenhouse/Lever，sitemap 兜底） · ✅ **自建邮箱验证** `smtp_self`（#3） · ✅ **网站变更=intent 引擎** `web_watch`（#4，复用 `source_entity_change` diff）。✅ intent 事件已接进**六维 Intent 维评分**（`lead/scoring.ts`：真实 `attributes.intent.*` 逐事件按新近度衰减(半衰期 60d)取最强 + 关键词代理兜底，压过纯代理；关键词代理排除 intent 命名空间防双重计数）。✅ **从 ICP 短名单自动 `registerWatch`**（`discovery.activities.registerWatchesForRun`：`discoveryWorkflow` 信号富集后，对本 run fit=match+域名公司自动建 web_watch，交 intentSweep 持续盯——loop 收口；best-effort 长活动）。**dev 实测整条链路**（`verify-intent-loop.mts`，真库真 crawl）：TRUMPF supplier 页真实 diff→`SOURCING_OPENED`→投影→**Intent 维 0→1、总分 0.39→0.54**。✅ **管线通脉（2026-07-08，见 §4 存量对账管线）**：存量 900+ 家进漏斗、recommended 加 Reachability 硬底、decision_maker 复活、双 loop 收口——「已建好的东西在存量上真跑」优先于建新能力。下一步主路：六维**加法→乘法门**（Fit^a×(1+Intent)×Reachability×…，让可达/需求=0 不被高 Fit 冲淡；需 backtest 校准阈值）+ TED v3/DLP 提单（需求证据）。
- P1 免费外部源：**招投标 TED v3** ✅ **P1 中标发现 + P2 ICP→CPV + P3 招标 intent 已落地**（见 §4 · PR #30/#31/#33；下一步 P4 SAM.gov Sources Sought=早数月意图） · **海关提单**（ImportYeti 免费按公司搜/50 票顶 + **Data Liberation Project FOIA 可再分发基线** + 逆向内部 API 做 HS 反查；美线法定公开 19 USC §1431） · **认证注册库**（openFDA/FCC/EUDAMED 免费官方，注册人=合规卖家；**openFDA P1 器械注册发现 + P2 ICP→FDA 产品码 + P3 510(k)→FDA_CLEARANCE intent 已落地** 见 §4 · PR #34/#36/#37；下一步 P4 富集/P5 monitoring/foiclass 全表种子） · **专利 inventor**（USPTO/EPO 免费=具名工程决策人） · 国家级贸易统计（Comtrade/Census/Eurostat）。
- 付费仅留插槽（Panjiva/多国空运提单等）；决策人具名一律 `personalData=true` 🔴 + LIA。

## 7. 文档索引（单一事实源体系，2026-07-10 重构）

**权威层（先读这四份）**：`docs/product-scope.md`(产品范围/边界/北极星/团队分工/决策记录——**定位权威**；边界=止于 LeadQualifiedPackage，QGO 归 SaaS；身份归 A+ADR-011 两硬规) · `docs/architecture/current.md`(本仓 as-built 架构/9 上下文/数据平面/事件与 LeadQualified 快照/**8 项已核验缺口**) · `docs/adr/registry.md`(12 ADR + 3 PDR——唯一决策真值) · `docs/status/current.md`(当前状态/待拍板 4 项——活文档)。
**路线**：`docs/roadmap/release-plan.md`(六项收口+R0-R3——**先收口再加 provider**) · `docs/roadmap/changelog.md`(原 roadmap-ai-acquisition，降级为追加式实施日志)。
**基底与归档**：`docs/platform/`(Codex 顶层架构交付包两份 docx=L0/L1 基底，待批准) · `docs/research/`(冻结研究：buyer-intelligence-v3(§10 修正优先)/discovery-architecture(目标态)/positioning-backlog(已被 product-scope 取代)/platform-top-level-design-v1(SUPERSEDED)/评测归档) · `docs/implementation-records/`(ted/openfda-provider-spec(已完成标注)/trade-fair-intelligence(专表方案已被通用采集层替代))。
**仍在 docs/backend/ 的活文档**：`discovery-sources.md`(源蓝图) · `vocab-taxonomy.md`(词表) · `oss-registry.md` · `ci-merge-automation.md`。两份 v3.0 Word=冻结研究综合稿，不再是权威基线。

## 8. 团队协作 / PR / 测试流程（团队开发，每次改动照做）

> 这是**团队仓库**（后续与其他成员合并），走 PR + CI + 自动审查，不直推 `main`。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- **分支**：功能分支 `feat/<topic>` / `fix/` / `docs/`，从最新 `main` 切出；**不在 `main` 直接提交**（`main` 复位跟随 origin）。
- **提交**：Conventional Commits（`feat(scope):` / `fix` / `docs` / `refactor` / `test` / `chore`）；正文说清「为什么 + 实测」；末行 `Co-Authored-By: Claude …`。
- **本地必绿**：`pnpm --filter @global/db generate`（schema 变）→ `pnpm --filter @global/api build`（=tsc 类型检查）→ `pnpm --filter @global/api test`（vitest）。provider/采集/富集类改动**另需真实数据实测**（`node --import tsx scripts/verify-*.mts`，无 sandbox，§5 硬规矩）。
- **PR**：`gh pr create --base main`，填 `.github/pull_request_template.md`。CI（`.github/workflows/ci.yml`：install→prisma generate→build→test）+ Security（`security.yml`：gitleaks 密钥扫描）绿了才合。
- **代码审查**：仓库启用 **Codex 自动审查**（开 PR/标 ready/评论 `@codex review` 触发）。处置每条 inline 意见后，在该线程回复（`gh api …/comments/{id}/replies`）并 GraphQL `resolveReviewThread` 解决。
- **合并判官（merge-judge）**：绿灯**且**低风险才自动合、高风险（migration/RLS/鉴权/GDPR/对外抓取/大量删除）升级到人。设计与启用见 [docs/backend/ci-merge-automation.md](docs/backend/ci-merge-automation.md)。分支保护 ruleset `protect-main` 已启用（PR+CI+gitleaks+线程 resolved）。
- **CI 只跑纯单测**（无 DB/网络）；需 DB/真源的验证走本地 verify 脚本。**依赖更新** dependabot（周更，npm+actions）。
