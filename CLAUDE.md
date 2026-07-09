# CLAUDE.md — 项目记忆（每会话自动加载）

> 给接手本仓库的 Claude Code 会话（本地 Mac 或远端 WSL）。随 git 同步，是跨会话的权威上下文。
> 详细进度看 [docs/backend/roadmap-ai-acquisition.md](docs/backend/roadmap-ai-acquisition.md)。

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

**Docker 服务**（`docker compose up -d`）：postgres `:5432`(pgvector/pg16, global/global/global_dev) · redis `:6379` · **new-api** `:3001`(模型网关，key 在 `apps/api/.env`) · **crawl4ai** `:11235`(token 在 .env) · **searxng** `:8081`(配置 `infra/searxng/settings.yml`)。
**Temporal** 不在 compose，是独立 CLI：`~/.temporalio/bin/temporal server start-dev --db-filename ~/temporal.db &`（`:7233`）。

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

**两处开发环境**（都同步到 git `global-backend` 私有仓库）：
- 本地 Mac：`/Users/xin/Documents/Global`（gh 已授权）
- 远端 WSL Ubuntu 24.04：`root@100.87.254.70:2222` → `/root/Global`（gh 已装，需 `gh auth login && gh auth setup-git` 才能 push/pull）。免密 SSH 已通。

## 4. 已落地子系统（真实数据、已实测）

- **多源发现** → `canonical_company`：`public_web`(SearXNG+Crawl4AI+Gemini) · `wikidata`(SPARQL) · `openstreetmap` · `directory`(名录列表抽取，实测 151 家) · **`trade_fair`**(展会参展商，RX/Algolia 直连 API，实测 EuroBLECH 398/909)。executeQuery **fan-out** 到 source_class 全部 ENABLED 适配器。
- **富集**（`enrichRun`，fit 门后只富集 match 公司，**attributes 按源命名空间** `attributes.gleif.*`/`attributes.wikidata.*`）：`gleif`(LEI/法人形式/母子关系) + `wikidata`(行业/产品/员工/财务/官网)。共享 `discovery/name-match.ts`（置信门槛 0.72 + 歧义边距，**绝不贴错身份**）。
- **决策人抽取** `contact.find_decision_makers`：Impressum/管理层/团队页 → 具名人 + 职务 + 角色分类（对齐买家委员会）。具名人标 `personalData=true`。
- **采集监控层**（源无关·平台级共享·无 RLS）：`monitored_source`/`source_entity`/`source_fetch`/`source_entity_change` 4 表 + `AcquisitionService.acquire`（抓取→清洗→落库→增量 diff，防误杀阈值）+ **Temporal Schedule 定时 sweep**（`acquisitionSweepWorkflow`，`nextFetchAt` 到期自动增量）。源适配器 `trade_fair`(RX/Algolia，实测 INTERPHEX 美国 602 家/12 国) + `mapyourshow`(MYS 无鉴权 JSON，实测 321)。
- **v3.0 信号富集**（零付费，signal 源只写 `attributes.*` 喂 Intent/Reachability 评分，走 enrichRun 命名空间+field_evidence+幂等）：`digital_footprint`(官网 HTML/DNS→技术栈/在投广告/服务市场/邮件商/JSON-LD 事实) + `structured_harvest`(sitemap→careers/招聘信号)。设计见 [buyer-intelligence-v3.md](docs/backend/buyer-intelligence-v3.md)。
- **自建邮箱验证** `smtp_self`（v3.0 #3）：MX + SMTP RCPT 握手自校验 + catch-all 检测 + SSRF 护栏；Gmail/M365/catch-all/端口不可达 一律 **RISKY**（不谎报 VALID），写 `contact_point` 验证生命周期。
- **网站变更 = intent 引擎** `web_watch`（v3.0 #4，`apps/api/src/intent/`）：**复用 `source_entity_change` diff**，锚点从「公司记录」换成「目标公司意图承载页」（产品/招聘/供应商招募·RFQ/新闻）。逐页抓渲染 HTML→抽结构化意图信号（page-signals，纯）→ **signalHash 只覆盖信号字段**（cosmetic 抖动不误触发）→ 前后快照 diff 出**具体 delta**→ 每条 = 一条 intent 事件（`SOURCING_OPENED`/`HIRING_UP`/`NEW_PRODUCTS`/`NEWS_POSTED`/`PAGE_CHANGED`，带强度+证据）。真实站多不发 Product/Article JSON-LD → 产品/新闻靠**主内容锚点链接**（去 nav/footer）；实测 TRUMPF supplier→`supplier_program`、Flex→3 招募词、products→主内容 7 品类、newsroom→8 新闻指纹。独立 `intentSweepWorkflow`+Schedule（与通用采集 sweep 分离，registry 正向过滤）；DAT-011 SUSPENDED + robots + crawl4ai SSRF 守；🔴 新闻只存**指纹哈希**（不落标题/人名）、事件证据仅数量；保留期清理（GDPR 存储限制）。租户经 `IntentProjectionService` 按 `companyIdentity` dedupeKey 投影进 `attributes.intent.*`。
- **存量对账管线**（2026-07-08 通脉）：`backlogSweepWorkflow`（Schedule 24h + `scripts/run-backlog-sweep.mts`）对**不属于任何 run 的存量公司**（投影进来的 900+ 家，此前永远够不到 fit 门）做 资格门→富集→信号→web_watch→联系人→重评分 全链对账（`fit-judge.ts` 共享四门核心、`id>cursor` 防活锁、批量+轮次双上限、DAT-011、ownerDb 仅平台级只读扫描）。**队列门**：`scoreLead` 的 `authoritativeFit` 只覆盖 Fit 维，recommended=六维总分≥0.55 **且 Reachability>0**（联系不上的不算推荐）。联系人发现首选 `decision_maker`（Impressum 具名决策人，🔴`person.profile` 证据 + `personal_data` 标记，`contact-persist.ts` 共享持久化）。worker 启动幂等 seed + 三 Schedule 自愈（acq/intent/backlog）；intentSweep 尾部 `projectIntentAllWorkspaces` 自动投影（loop 真收口）；`finalizeRun` 自动发 `QualifyRequested`；fit-judge **拒绝 stub 兜底假判定**。**dev 实测**（有界样本 `run-backlog-sweep --fit-batch=10 --max-fit-rounds=1` 等·真库真 crawl·无 sandbox）：首轮冷样本 6 阶段全产出——资格门 10 判/1 match、快事实 10 尝试、信号 4 抓/3 命中、web_watch 注册 4、联系人 5 尝试/1 具名、scored 1040 全量重评；重跑呈**正确幂等**（TTL 新鲜/已注册/已建联系人的行跳过）。**对抗式复审（5 维·14 agent·逐条核验）6 findings**：已修 3 手术刀——队列门 Reachability 硬底补齐**非权威（fitVerdict=null）路径**（此前老路径漏出「联系不上的伪推荐」）、DAT-011 监控注册阶段补 SUSPENDED 守、6 阶段静默 catch→log.warn；🟠 下游 enrich/signal/watch/contact **跨-sweep 游标复位+集不收缩→预算位次后公司饿死**（本 PR 立论 bug 在下游复现）走 fast-follow（根治需 schema 水位列 `lastEnrichedAt/lastSignalAt/lastWatchAt/contactDiscoveryAttemptedAt` + 迁移）。
- **TED 招投标 provider**（2026-07-09，P1+P2+P3，[ted-provider-spec.md](docs/backend/ted-provider-spec.md)）：欧盟采购官方 API（零鉴权 REST，绿事实 CC BY 4.0），归 `public_intelligence` 复用全管线、无需新 SourceClass。**P1 中标发现**（`adapters/ted-api.ts` + `discovery/providers/ted.provider.ts`：expert query/ITERATION 滚动/多语言 eng 优先解包/缺键当 null；中标方 `winner-name`+国别税号 → `ProviderCompanyRecord`，URL 身份安全归属）。**P2 ICP→CPV**（`discovery/icp-to-cpv.ts` `resolveIcpToCpv`=crosswalk 锚定+product 精修**限子树**+country 覆盖门 `icp_fit_warning`；**§8.2** 暴露 taxonomy `crosswalks`（`resolveCpvForProduct` 枚举限子树前缀·去尾零）；**§8.7** `generateQueryPlan` **确定性注入** TED 查询、LLM 不臆造 CPV；CPV 子树种子）。**P3 招标 intent**（`adapters/ted-api.ts` `searchContractNotices` cn-standard 只取绿字段 + 抽共享 `fetchNoticesRaw` 分页；`intent/ted-intent-projection.service.ts` `projectTenders`：**招标=买方需求**，买方 name+alpha-2 归并取最新发布日 → upsert canonical(有则更新/无则建线索) → `attributes.intent.events[{type:'TENDER_PUBLISHED', at:<发布日 ISO>, strength 0.9}]` → 动六维 Intent 维，复用 `mergeIntent`，新 event type 无需改评分）。🔴 合规：CC BY 署名（发现证据 `field_evidence.license` 修，非硬编码 licensed；P3 新建买方另写 `identity` 署名行）+ `winner-email`/`buyer-email` 不入绿库 + `source_policy` **用途门** fail-closed（个人数据源直连前必校验，P3 直连亦过同一 §8.8 门）+ 国别税号身份**按 alpha-2 国别限定**（防跨境同号误并；P3 无国别招标跳过同理）+ ISO-3→alpha-2 归一 + §8.6 发布日 `tedDateToIso` 归一（防 Date.parse NaN 静默 0 分）。**实测**（真库真 API 无 sandbox）：泵+德国 真拉 12~29 家中标（BBA Pumpen/KAESER，真税号）、ICP「pumps+德国」→CPV→buyer_country→TED 闭环；P3 泵+德国近 90 天 24 条开放招标→18 家买方 canonical，Intent 0→0.8657、同参再跑幂等（evidence 36→36）、SUSPENDED→零落地。质量：TDD 261 测 + 3 轮对抗复审（P1 修 1 HIGH、P2 修 3 findings、P3 修 5 findings 含 §8.8 门/幂等/无国别防误并；幂等修复被实测反抓 jsonb 键序 bug）。**下一步**：P4 招标 SAM.gov Sources Sought（早数月意图）；招标 P3 投影上 Temporal Schedule。
- **openFDA 认证注册库 provider**（2026-07-09，P1 器械注册发现，[openfda-provider-spec.md](docs/backend/openfda-provider-spec.md)）：美国 FDA 官方开放数据 API（`api.fda.gov`，零鉴权、**CC0 公共领域**）。`device/registrationlisting` = 「正在合规卖进美国」的规管品类活跃公司名单，归 `public_intelligence` 复用全管线、无需新 SourceClass。**P1 发现**（`adapters/openfda-api.ts` + `discovery/providers/openfda.provider.ts`：search 构造/有界分页 skip≤25000/`openfda` 谐调块缺块当 null/判 error.NOT_FOUND 空/429 退避；establishment → `ProviderCompanyRecord`，`name+iso_country_code` 主键、FDA 注册号→`fda-reg` 全局唯一 scheme、externalId 无号退 name:country 防跨国互撞；分类事实取**匹配搜索码**产品、`attributes.products`=device_name 喂 fit 门；无 product code → fail-safe 空）。**§8.1** 美国进口商=`initial_importer_flag:Y`（**非** establishment_type:Importer）。🔴 合规（**与 TED 关键差异**）：CC0 **署名非义务**（`license='CC0-1.0'`，非 TED 强制 CC BY）+ `us_agent`/`owner_operator`/`contact` 具名个人**不入绿库**（CC0≠GDPR 依据）+ **「注册≠核准」文案红线**（`attributes.fda.disclaimer`）+ `source_policy(api.fda.gov, personalData=true)` §8.8 门 + MAUDE/FAERS 不摄入。**实测**（真库真 API 无 sandbox）：LLZ 放射影像美国进口商 27 家（Philips Ultrasound/GE Healthcare/Karl Storz）→ canonical 27 + CC0 证据 108 → 无具名个人 → §8.8 SUSPENDED 零落地。质量：TDD 289 测 + 1 轮对抗复审（4 findings 全修）。⚠️ fit 门 LLM 判别受阻于**网关 Gemini 额度耗尽(429)**（环境/计费，波及全部 fit 门，已建 task）。**下一步** P2 ICP→FDA 产品码映射（foiclass.zip 种子）· P3 510k→`FDA_CLEARANCE` intent。PR #34。
- **词表归一**：`canonical_taxonomy` + `term_alias`（ISIC + ISO3166 + **CPV 子树**，265 节点），`TaxonomyResolver`（确定性 + LLM 冷路径 + `crosswalks` 暴露供 ICP→CPV）。
- **接口门户** Scalar `/api/portal`；**JWKS 鉴权**（生产禁 dev stub）；helmet+CORS+限流护栏。

## 5. 硬约束 / 决策（别违背）

- **真实数据，不用 sandbox**；要真实测试 + 评判。跑 provider 用 `node --import tsx` 或 `npx tsx`，脚本放 `apps/api` 且手动载 `.env`（ESM 相对 import 按文件位置解析）。
- 🔴 **合规红线**（详见 [trade-fair-intelligence.md §0](docs/backend/trade-fair-intelligence.md)）：**技术能抓 ≠ 合规能用**。RX 官网 ToS 禁爬；用 public key 打 Algolia 撞其 ToS §4.5(h)（灰偏红）；个人数据受 GDPR Art.14（欧盟「公开≠可自由再用」）。**数据分级**：🟢公司事实+GLEIF(CC0) 可商用 / 🟡职能邮箱 走 ePrivacy / 🔴人名邮箱·联系人 默认隔离 + LIA。
- SearXNG 用**放行侧引擎**（Yandex/Marginalia/Mojeek）——Mac 网络对消费级搜索引擎做 SNI 过滤，WSL 无此问题。
- Provider/富集失败 **fail-safe 返回 0/miss**，不阻断其余源；单展会/单源失败不影响整体。

## 6. 下一步（v3.0 买家智能 P0，[buyer-intelligence-v3.md](docs/backend/buyer-intelligence-v3.md)）

核心反转：从「公司名单」→「可成单线索」（补三缺环：**需求证据/对的人/时机**）。**免费优先**，复用已有基建（diff→网站变更 intent、pgvector→look-alike、name-match→consignee 实体解析、first-seen→新进口商、crawl4ai 抓包→通用 API 逆向）。

- P0 复用四件套 ✅ 全部落地（见 §4）：✅ `digital_footprint` · ✅ `structured_harvest`（下一步主路加**自有 ATS JSON 逆向** Greenhouse/Lever，sitemap 兜底） · ✅ **自建邮箱验证** `smtp_self`（#3） · ✅ **网站变更=intent 引擎** `web_watch`（#4，复用 `source_entity_change` diff）。✅ intent 事件已接进**六维 Intent 维评分**（`lead/scoring.ts`：真实 `attributes.intent.*` 逐事件按新近度衰减(半衰期 60d)取最强 + 关键词代理兜底，压过纯代理；关键词代理排除 intent 命名空间防双重计数）。✅ **从 ICP 短名单自动 `registerWatch`**（`discovery.activities.registerWatchesForRun`：`discoveryWorkflow` 信号富集后，对本 run fit=match+域名公司自动建 web_watch，交 intentSweep 持续盯——loop 收口；best-effort 长活动）。**dev 实测整条链路**（`verify-intent-loop.mts`，真库真 crawl）：TRUMPF supplier 页真实 diff→`SOURCING_OPENED`→投影→**Intent 维 0→1、总分 0.39→0.54**。✅ **管线通脉（2026-07-08，见 §4 存量对账管线）**：存量 900+ 家进漏斗、recommended 加 Reachability 硬底、decision_maker 复活、双 loop 收口——「已建好的东西在存量上真跑」优先于建新能力。下一步主路：六维**加法→乘法门**（Fit^a×(1+Intent)×Reachability×…，让可达/需求=0 不被高 Fit 冲淡；需 backtest 校准阈值）+ TED v3/DLP 提单（需求证据）。
- P1 免费外部源：**招投标 TED v3** ✅ **P1 中标发现 + P2 ICP→CPV + P3 招标 intent 已落地**（见 §4 · PR #30/#31/#33；下一步 P4 SAM.gov Sources Sought=早数月意图） · **海关提单**（ImportYeti 免费按公司搜/50 票顶 + **Data Liberation Project FOIA 可再分发基线** + 逆向内部 API 做 HS 反查；美线法定公开 19 USC §1431） · **认证注册库**（openFDA/FCC/EUDAMED 免费官方，注册人=合规卖家；**openFDA P1 器械注册发现已落地** 见 §4 · PR #34；下一步 P2 ICP→FDA 产品码/P3 510k intent） · **专利 inventor**（USPTO/EPO 免费=具名工程决策人） · 国家级贸易统计（Comtrade/Census/Eurostat）。
- 付费仅留插槽（Panjiva/多国空运提单等）；决策人具名一律 `personalData=true` 🔴 + LIA。

## 7. 文档索引（docs/backend/）

`roadmap-ai-acquisition.md`(全量进度) · `discovery-architecture.md`(四层/Agent/MCP) · `discovery-sources.md`(源→方法→字段→合规蓝图) · **`buyer-intelligence-v3.md`(v3.0 买家智能:海关提单/决策人/意图/合规,免费优先,10 支柱深研+对抗核验)** · **`ted-provider-spec.md`(TED v3 招投标 provider 落地规格:活 API 实测契约/ICP→CPV 映射/合规分级/集成接缝/实施顺序——P1 获客源,build-ready)** · **`openfda-provider-spec.md`(openFDA 认证注册库 provider 落地规格:活 API 实测契约/ICP→FDA 产品码映射/CC0 合规/端点接缝——P1 获客源,与 TED 同构,build-ready)** · **`positioning-and-acquisition-backlog.md`(定位/现阶段范围/团队分工架构/获客 backlog——权威)** · `trade-fair-intelligence.md`(展会子系统设计+合规) · `vocab-taxonomy.md`(词表) · `api-management.md`(门户) · `oss-registry.md`。

## 8. 团队协作 / PR / 测试流程（团队开发，每次改动照做）

> 这是**团队仓库**（后续与其他成员合并），走 PR + CI + 自动审查，不直推 `main`。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- **分支**：功能分支 `feat/<topic>` / `fix/` / `docs/`，从最新 `main` 切出；**不在 `main` 直接提交**（`main` 复位跟随 origin）。
- **提交**：Conventional Commits（`feat(scope):` / `fix` / `docs` / `refactor` / `test` / `chore`）；正文说清「为什么 + 实测」；末行 `Co-Authored-By: Claude …`。
- **本地必绿**：`pnpm --filter @global/db generate`（schema 变）→ `pnpm --filter @global/api build`（=tsc 类型检查）→ `pnpm --filter @global/api test`（vitest）。provider/采集/富集类改动**另需真实数据实测**（`node --import tsx scripts/verify-*.mts`，无 sandbox，§5 硬规矩）。
- **PR**：`gh pr create --base main`，填 `.github/pull_request_template.md`。CI（`.github/workflows/ci.yml`：install→prisma generate→build→test）+ Security（`security.yml`：gitleaks 密钥扫描）绿了才合。
- **代码审查**：仓库启用 **Codex 自动审查**（开 PR/标 ready/评论 `@codex review` 触发）。处置每条 inline 意见后，在该线程回复（`gh api …/comments/{id}/replies`）并 GraphQL `resolveReviewThread` 解决。
- **合并判官（merge-judge）**：绿灯**且**低风险才自动合、高风险（migration/RLS/鉴权/GDPR/对外抓取/大量删除）升级到人。设计与启用见 [docs/backend/ci-merge-automation.md](docs/backend/ci-merge-automation.md)。分支保护 ruleset `protect-main` 已启用（PR+CI+gitleaks+线程 resolved）。
- **CI 只跑纯单测**（无 DB/网络）；需 DB/真源的验证走本地 verify 脚本。**依赖更新** dependabot（周更，npm+actions）。
