# AGENTS.md — 项目记忆（每会话自动加载）

> 给接手本仓库的 Codex 会话。随 git 同步，是跨会话的权威上下文。
> **当前开发主体（2026-07-16 用户确认）= Codex**：Codex 负责读项目记忆、规划、实现、验证、提 PR 与收口审查；旧 CC/Claude 会话、分支与 worktree 是**待 Codex 审计的历史/迁移 provenance**，不再代表当前执行责任，也不得在独有提交核验前删除。`CLAUDE.md` 仅保留兼容入口，冲突一律以本文件和下列权威文档为准。
> **当前主线先看** [docs/status/current.md](docs/status/current.md) 与 [docs/roadmap/release-plan.md](docs/roadmap/release-plan.md)；边界看 [docs/product-scope.md](docs/product-scope.md)，as-built 看 [docs/architecture/current.md](docs/architecture/current.md)，承重决策只认 [docs/adr/registry.md](docs/adr/registry.md)。历史实施日志见 [docs/roadmap/changelog.md](docs/roadmap/changelog.md)。

## 1. 这是什么 + 边界（关键）

出海企业 **AI 全球客户开发与增长执行平台**的后端仓库，现包含两个产品面：已暂停新增开发、保留维护的**买家智能与机会资格后端**，以及当前开发主线 **Site Builder 独立站建设子系统**。

- **获客侧边界不变**：止于 `LeadQualifiedPackage`；Campaign、触达、Conversation、Opportunity/QGO/SAO、归因归 SaaS。Site Builder 在本仓负责建站与发布能力，SaaS 负责身份、控制面和产品 UI。
- 本后端**不做身份系统**：只校验 SaaS 平台签发的 token（JWKS 验签）→ 解出 `workspace_id` / `user` / `roles`。不签发、不刷新、不管用户表。
- 不为前端并行造 mock、不等前端。接口 code-first OpenAPI，后期交付。

## 2. 技术栈 / 架构

- **NestJS 单体（模块化）+ Prisma + PostgreSQL**（多租户 **RLS**：`app_user` 连接 + `set_config('app.current_workspace_id')` + `current_workspace_id()` policy；owner 连接绕 RLS 供 relay/seed）。
- **Temporal** 持久工作流（understanding / discovery / qualify）；**Transactional Outbox** + relay 发领域事件。
- **模型网关 = new-api 中转站**（单一 OpenAI 兼容端点）。可用模型：`deepseek-v4-flash` / `deepseek-v4-pro` / `gemini-2.5-flash` / `gemini-2.5-pro`（gemini-2.0/3.x 不可用）。旧别名 `deepseek-chat`/`deepseek-reasoner` 官方 2026-07-24 关停，一律用显式 V4 型号。
- **发现四层**：L0 Tool → L1 ProviderAdapter（按 SourceClass）→ L2 AI Task（有界任务契约，**非超级 Agent**）→ L3 Temporal Workflow。**ToolBroker** 是唯一确定性执行闸门（allowedTools 白名单 + 预算 reserve-settle + 限流 + source_policy + 幂等 + trace）。
- **MCP = 传输非授权**，第一步不做；第三方 MCP 内化到 ProviderAdapter 后面。
- **Site Builder** = NestJS bounded context + Temporal 固定 DAG + 有界 AI Task + `@global/contracts` SiteSpec + Astro 静态渲染；不使用自由 Planner。素材/KB 对象进 MinIO，KB 使用 Docling + BGE-M3；当前 renderer 构建产物仍是本地路径，不得把目标态 immutable Release 写成 as-built。

## 3. 开发环境

**Docker 服务**（`docker compose -p global up -d`，共 8 个，容器名 `global-*`）：postgres `:5432`(pgvector/pg16, global/global/global_dev) · redis `:6379` · **new-api** `:3001`(模型网关，key 在 `apps/api/.env`) · **crawl4ai** `:11235`(token 在 .env) · **searxng** `:8081`(配置 `infra/searxng/settings.yml`) · **minio** `:9000/9001` · **embeddings**(ollama `:11434`，`bge-m3` 1024 维) · **docling** `:5001`。
**Temporal** 不在 compose，跑成 systemd 服务 `temporal-dev.service`（开机自启、`:7233`）——`systemctl status/restart temporal-dev`，不再手动 CLI。

**Compose 项目名迁移护栏**：当前 Ubuntu 实机的容器标签、固定容器名和数据卷已核验为项目 `global`（例如 `global_pgdata`）；`-p global` 是现行真值。旧 Mac/WSL 曾可能使用目录推导的 `global-backend`，切换时**不得**直接 `down -v`、删除固定 `global-*` 容器或假定新卷已有数据。先读 [Compose 项目名迁移 runbook](docs/backend/compose-project-migration.md)；若尚未迁移，临时使用 `pnpm infra:up:legacy`，完成 pg_dump/restore 和卷/服务验收后再切换。

**跑起来**：
```bash
cd /global/backend
pnpm install
docker compose -p global up -d
DATABASE_URL=postgresql://global:global@localhost:5432/global_dev pnpm --filter @global/db exec prisma migrate deploy
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/api build
DATABASE_URL=postgresql://global:global@localhost:5432/global_dev node apps/api/scripts/seed-taxonomy.mjs
pnpm --filter @global/api start:dev    # API
pnpm --filter @global/api worker       # Temporal worker
pnpm --filter @global/api test         # vitest
```
data_provider 源（gleif/directory/trade_fair/wikidata/…）在 **API/relay 启动时自动 seed**。

**唯一当前开发环境**：**Ubuntu 26.04**（2026-07-15 迁入），代码在 `/global/backend`；Mac 仅作 SSH 瘦客户端，旧 Mac/WSL 路径都不是当前施工目录。Tailscale 主机 `xin`（root，`100.88.153.74`），8T 盘挂 `/data` 且承载 Docker data-root。墙内网络经桌面用户 xin 的 mihomo `127.0.0.1:7897`，apt 使用 `mirrors.aliyun.com`，Docker registry 使用 daocloud 镜像。`docker compose` 一律带 `-p global`；Temporal 一律走 systemd `temporal-dev.service`。Compose 开发服务端口一律只绑 `127.0.0.1`，Mac 访问须用 SSH 端口转发，不向 Tailscale/公网直接暴露。

🔴 **Crawl4AI 本地安全例外（不是生产基线）**：当前 mihomo fake-IP 会把公网域名解析进 `198.18.0.0/16`（2026-07-16 实测 `example.com → 198.18.0.13`），Crawl4AI 默认 SSRF 守卫会因此返回 400。开发 Compose 暂设 `CRAWL4AI_ALLOW_INTERNAL_URLS=true` 并把 `:11235` 只绑定 `127.0.0.1`；这会关闭容器原生目的地址校验，ToolBroker/source_policy/robots **不能替代网络 SSRF 防护**，loopback 也只防外部直连 `:11235`。当前 `IntakeDto.websiteUrl` 会经 brand research 进入 Crawl4AI，`robots.txt` 还有独立直连；因此本地只允许开发者自己核验的公网 URL，不得向不可信租户暴露这条抓取链。**R1-safety 必须立即收口全部 egress 入口**：以独立安全/infra PR 落真实 DNS/可校验 egress 或逐跳 URL guard，覆盖 Crawl4AI 与 robots 直连，关闭例外并做公网正例 + private/loopback/metadata/DNS-rebinding/redirect 反例。未通过前，生产或任何接收不可信 URL 的环境严禁沿用。

## 4. 已落地子系统（真实数据、已实测）

- **Site Builder M0（当前主线）**：注册引导、`Site`/`SiteVersion`/`BuildRun`、素材直传与 KB、Demo v0 Temporal 流程、Astro 渲染器 10 型组件、SiteSpec 1.0.0 共享类型（DQ-1/#117）和 7 个有界 AI Task 路由已存在。#121 已做无条件触发 demo 的行为修复，#123 已禁虚构身份，#124 已落 businessEmail 隔离/可取消超时/失败保站；**R0 contract closeout（#126）已补齐 intake `Idempotency-Key`、`buildId`、稳定错误码、Temporal 启动证据和 code-first OpenAPI，响应固定为 `{siteId,buildId,status:"generating_demo"}` 且不再暴露 `mode`**。**R1-safety ①（2026-07-17）已完成构建隔离**：随机 0700/0600 临时 SiteSpec + `finally` 清理，Renderer 固定 Node/Astro 入口与 7 变量 env allowlist；R1-safety ② Crawl/robots egress 仍在施工。

- **多源发现** → `canonical_company`：`public_web`(SearXNG+Crawl4AI+Gemini) · `wikidata`(SPARQL) · `openstreetmap` · `directory`(名录列表抽取，实测 151 家) · **`trade_fair`**(展会参展商，RX/Algolia 直连 API，实测 EuroBLECH 398/909)。executeQuery **fan-out** 到 source_class 全部 ENABLED 适配器。
- **富集**（`enrichRun`，fit 门后只富集 match 公司，**attributes 按源命名空间** `attributes.gleif.*`/`attributes.wikidata.*`）：`gleif`(LEI/法人形式/母子关系) + `wikidata`(行业/产品/员工/财务/官网)。共享 `discovery/name-match.ts`（置信门槛 0.72 + 歧义边距，**绝不贴错身份**）。
- **决策人抽取** `contact.find_decision_makers`：Impressum/管理层/团队页 → 具名人 + 职务 + 角色分类（对齐买家委员会）。具名人标 `personalData=true`。
- **采集监控层**（源无关·平台级共享·无 RLS）：`monitored_source`/`source_entity`/`source_fetch`/`source_entity_change` 4 表 + `AcquisitionService.acquire`（抓取→清洗→落库→增量 diff，防误杀阈值）+ **Temporal Schedule 定时 sweep**（`acquisitionSweepWorkflow`，`nextFetchAt` 到期自动增量）。源适配器 `trade_fair`(RX/Algolia，实测 INTERPHEX 美国 602 家/12 国) + `mapyourshow`(MYS 无鉴权 JSON，实测 321)。
- **v3.0 信号富集**（零付费，signal 源只写 `attributes.*` 喂 Intent/Reachability 评分，走 enrichRun 命名空间+field_evidence+幂等）：`digital_footprint`(官网 HTML/DNS→技术栈/在投广告/服务市场/邮件商/JSON-LD 事实) + `structured_harvest`(sitemap→careers/招聘信号)。设计见 [buyer-intelligence-v3.md](docs/research/buyer-intelligence-v3.md)。
- **自建邮箱验证** `smtp_self`（v3.0 #3）：MX + SMTP RCPT 握手自校验 + catch-all 检测 + SSRF 护栏；Gmail/M365/catch-all/端口不可达 一律 **RISKY**（不谎报 VALID），写 `contact_point` 验证生命周期。
- **网站变更 = intent 引擎** `web_watch`（v3.0 #4，`apps/api/src/intent/`）：**复用 `source_entity_change` diff**，锚点从「公司记录」换成「目标公司意图承载页」（产品/招聘/供应商招募·RFQ/新闻）。逐页抓渲染 HTML→抽结构化意图信号（page-signals，纯）→ **signalHash 只覆盖信号字段**（cosmetic 抖动不误触发）→ 前后快照 diff 出**具体 delta**→ 每条 = 一条 intent 事件（`SOURCING_OPENED`/`HIRING_UP`/`NEW_PRODUCTS`/`NEWS_POSTED`/`PAGE_CHANGED`，带强度+证据）。真实站多不发 Product/Article JSON-LD → 产品/新闻靠**主内容锚点链接**（去 nav/footer）；实测 TRUMPF supplier→`supplier_program`、Flex→3 招募词、products→主内容 7 品类、newsroom→8 新闻指纹。独立 `intentSweepWorkflow`+Schedule（与通用采集 sweep 分离，registry 正向过滤）；DAT-011 SUSPENDED + robots 合规；完整 Crawl4AI/robots egress 防护待 R1-safety（当前开发例外仅可信 URL）；🔴 新闻只存**指纹哈希**（不落标题/人名）、事件证据仅数量；保留期清理（GDPR 存储限制）。租户经 `IntentProjectionService` 按 `companyIdentity` dedupeKey 投影进 `attributes.intent.*`。
- **存量对账管线**（2026-07-08 通脉）：`backlogSweepWorkflow`（Schedule 24h + `scripts/run-backlog-sweep.mts`）对**不属于任何 run 的存量公司**（投影进来的 900+ 家，此前永远够不到 fit 门）做 资格门→富集→信号→web_watch→联系人→重评分 全链对账（`fit-judge.ts` 共享四门核心、`id>cursor` 防活锁、批量+轮次双上限、DAT-011、ownerDb 仅平台级只读扫描）。**队列门**：`scoreLead` 的 `authoritativeFit` 只覆盖 Fit 维，recommended=六维总分≥0.55 **且 Reachability>0**（联系不上的不算推荐）。联系人发现首选 `decision_maker`（Impressum 具名决策人，🔴`person.profile` 证据 + `personal_data` 标记，`contact-persist.ts` 共享持久化）。worker 启动幂等 seed + 三 Schedule 自愈（acq/intent/backlog）；intentSweep 尾部 `projectIntentAllWorkspaces` 自动投影（loop 真收口）；`finalizeRun` 自动发 `QualifyRequested`；fit-judge **拒绝 stub 兜底假判定**。**dev 实测**（有界样本 `run-backlog-sweep --fit-batch=10 --max-fit-rounds=1` 等·真库真 crawl·无 sandbox）：首轮冷样本 6 阶段全产出——资格门 10 判/1 match、快事实 10 尝试、信号 4 抓/3 命中、web_watch 注册 4、联系人 5 尝试/1 具名、scored 1040 全量重评；重跑呈**正确幂等**（TTL 新鲜/已注册/已建联系人的行跳过）。**对抗式复审（5 维·14 agent·逐条核验）6 findings**：已修 3 手术刀——队列门 Reachability 硬底补齐**非权威（fitVerdict=null）路径**（此前老路径漏出「联系不上的伪推荐」）、DAT-011 监控注册阶段补 SUSPENDED 守、6 阶段静默 catch→log.warn；🟠 下游 enrich/signal/watch/contact **跨-sweep 游标复位+集不收缩→预算位次后公司饿死**（本 PR 立论 bug 在下游复现）走 fast-follow（根治需 schema 水位列 `lastEnrichedAt/lastSignalAt/lastWatchAt/contactDiscoveryAttemptedAt` + 迁移）。
- **TED 招投标 provider**（2026-07-09，P1+P2+P3，[ted-provider-spec.md](docs/implementation-records/ted-provider-spec.md)）：欧盟采购官方 API（零鉴权 REST，绿事实 CC BY 4.0），归 `public_intelligence` 复用全管线、无需新 SourceClass。**P1 中标发现**（`adapters/ted-api.ts` + `discovery/providers/ted.provider.ts`：expert query/ITERATION 滚动/多语言 eng 优先解包/缺键当 null；中标方 `winner-name`+国别税号 → `ProviderCompanyRecord`，URL 身份安全归属）。**P2 ICP→CPV**（`discovery/icp-to-cpv.ts` `resolveIcpToCpv`=crosswalk 锚定+product 精修**限子树**+country 覆盖门 `icp_fit_warning`；**§8.2** 暴露 taxonomy `crosswalks`（`resolveCpvForProduct` 枚举限子树前缀·去尾零）；**§8.7** `generateQueryPlan` **确定性注入** TED 查询、LLM 不臆造 CPV；CPV 子树种子）。**P3 招标 intent**（`adapters/ted-api.ts` `searchContractNotices` cn-standard 只取绿字段 + 抽共享 `fetchNoticesRaw` 分页；`intent/ted-intent-projection.service.ts` `projectTenders`：**招标=买方需求**，买方 name+alpha-2 归并取最新发布日 → upsert canonical(有则更新/无则建线索) → `attributes.intent.events[{type:'TENDER_PUBLISHED', at:<发布日 ISO>, strength 0.9}]` → 动六维 Intent 维，复用 `mergeIntent`，新 event type 无需改评分）。🔴 合规：CC BY 署名（发现证据 `field_evidence.license` 修，非硬编码 licensed；P3 新建买方另写 `identity` 署名行）+ `winner-email`/`buyer-email` 不入绿库 + `source_policy` **用途门** fail-closed（个人数据源直连前必校验，P3 直连亦过同一 §8.8 门）+ 国别税号身份**按 alpha-2 国别限定**（防跨境同号误并；P3 无国别招标跳过同理）+ ISO-3→alpha-2 归一 + §8.6 发布日 `tedDateToIso` 归一（防 Date.parse NaN 静默 0 分）。**实测**（真库真 API 无 sandbox）：泵+德国 真拉 12~29 家中标（BBA Pumpen/KAESER，真税号）、ICP「pumps+德国」→CPV→buyer_country→TED 闭环；P3 泵+德国近 90 天 24 条开放招标→18 家买方 canonical，Intent 0→0.8657、同参再跑幂等（evidence 36→36）、SUSPENDED→零落地。质量：TDD 261 测 + 3 轮对抗复审（P1 修 1 HIGH、P2 修 3 findings、P3 修 5 findings 含 §8.8 门/幂等/无国别防误并；幂等修复被实测反抓 jsonb 键序 bug）。招标 P3 投影已**上 Temporal Schedule**（见「外部源 intent sweep」P5 · PR #38）。**SAM.gov Sources Sought P4 已落地**（PR #99，默认 DISABLED；获客线当前冻结）。
- **openFDA 认证注册库 provider**（2026-07-09，P1 器械注册发现 + P2 ICP→FDA 产品码映射，[openfda-provider-spec.md](docs/implementation-records/openfda-provider-spec.md)）：美国 FDA 官方开放数据 API（`api.fda.gov`，零鉴权、**CC0 公共领域**）。`device/registrationlisting` = 「正在合规卖进美国」的规管品类活跃公司名单，归 `public_intelligence` 复用全管线、无需新 SourceClass。**P1 发现**（`adapters/openfda-api.ts` + `discovery/providers/openfda.provider.ts`：search 构造/有界分页 skip≤25000/`openfda` 谐调块缺块当 null/判 error.NOT_FOUND 空/429 退避；establishment → `ProviderCompanyRecord`，`name+iso_country_code` 主键、FDA 注册号→`fda-reg` 全局唯一 scheme、externalId 无号退 name:country 防跨国互撞；分类事实取**匹配搜索码**产品、`attributes.products`=device_name 喂 fit 门；无 product code → fail-safe 空）。**§8.1** 美国进口商=`initial_importer_flag:Y`（**非** establishment_type:Importer）。🔴 合规（**与 TED 关键差异**）：CC0 **署名非义务**（`license='CC0-1.0'`，非 TED 强制 CC BY）+ `us_agent`/`owner_operator`/`contact` 具名个人**不入绿库**（CC0≠GDPR 依据）+ **「注册≠核准」文案红线**（`attributes.fda.disclaimer`）+ `source_policy(api.fda.gov, personalData=true)` §8.8 门 + MAUDE/FAERS 不摄入。**实测**（真库真 API 无 sandbox）：LLZ 放射影像美国进口商 27 家（Philips Ultrasound/GE Healthcare/Karl Storz）→ canonical 27 + CC0 证据 108 → 无具名个人 → §8.8 SUSPENDED 零落地。质量：TDD 289 测 + 1 轮对抗复审（4 findings 全修）。**P2 ICP→FDA 产品码映射**（`taxonomy-resolver.resolveFdaProductCode`：产品词精修**枚举限 panel 子树**[`parentCode ∈ panelCodes`，FDA 3 字母码无前缀层级靠显式父维]+ `listFdaProductCodes` 宽网，**复用 parentCode 列零 migration**；`discovery/icp-to-fda.ts resolveIcpToFda`：industry `crosswalk.fdaPanels` 锚定 + 精修 + 宽网 + 直锚码**并集**；`icp.service injectFdaQuery` 注入；**国家维与 TED 反**=全美市场无覆盖门、选**贸易侧** importer/manufacturer；curated 种子 6 panel + 6 放射码 + ISIC 医疗器械节点，实测 ICP「放射器械+进口商」→ RA 码 → 闭环真拉 25 家在美进口商）。质量 TDD 302 测 + 2 轮对抗复审（P1 4 findings、P2 6 findings 含 wikidata QID 错锚[Q12140 药品→Q6554101 器械]/panel 过度声明/贸易侧兜底）。⚠️ fit 门先前受**网关 Gemini 额度耗尽(429)**阻（#35 已改路由 deepseek 恢复）。**P3 510(k)→intent**（`adapters/openfda-api.ts` `search510kClearances`/`build510kSearch`/`map510k`/`fdaDateToIso`/`isClearedDecision`；`intent/openfda-intent-projection.service.ts` `projectClearances`：**510k 具名申请人清关=新品/上市时机**，申请人 name+alpha-2 归并取最新决定日 → upsert canonical(有则更新/无则建线索) → `attributes.intent.events[{type:'FDA_CLEARANCE', at:<决定日 ISO>, strength 0.85}]` → 动六维 Intent 维，复用 `mergeIntent`、新 event type 无需改评分）。🔴 §8.6 gotcha#6 **只对正向清关投**（`isClearedDecision`=SE 家族+SN/ST/PT/SI+DENG；NSE/被拒/撤回排除，绝不给被拒公司误加分）+ §8.6 `fdaDateToIso` 归一(紧凑 YYYYMMDD 防 NaN 静默 0 分) + CC0 **署名非义务**(`license='CC0-1.0'`) +「清关≠核准」`attributes.fda.disclaimer` 恒置 + contact/us_agent 不入绿库 + §8.8 用途门 fail-closed + §6 **高精度**个体户边界(只判头衔/"Surname, Given"，绝不按形状误伤真公司)。DRY：`sameIntent`/`canonicalize` 上移 `intent-projection.service.ts` 供 TED/openFDA 共享，`mergeIntent` 排序比较器改一致(相等 at 保序)。**实测**（真库真 API 无 sandbox，五段全绿）：ICP「AI 放射软件 QAS」近 1 年 16 条清关(Qure.Ai/Aidoc/Ischemaview…IN/TW/US/CA/ES/IL)→ 11 家去重 canonical + 11 FDA_CLEARANCE、disclaimer/CC0/无 PII、幂等(evidence 22→22)、Intent 0→0.0252、§8.8 SUSPENDED 零落地。TDD 339 测 + 对抗复审（3 维·7 agent → 4 findings 全核验，2 条真机制加固：比较器一致性 + 共享幂等基石单测）。510k intent 投影已**上 Temporal Schedule**（见「外部源 intent sweep」P5 · PR #38）。**下一步** P4 `attributes.fda.*` 富集 · monitoring sweep · foiclass 全表种子扩专科。PR #34/#36/#37。
- **外部源 intent sweep 上 Temporal Schedule**（P5，2026-07-09，loop 收口）：把已落地的两 P3 intent 投影（TED 招标 `TENDER_PUBLISHED` + openFDA 510k 清关 `FDA_CLEARANCE`）接进**第 4 个周期 Schedule**（`temporal/external-intent.{activities,workflow}.ts` + `ensure-schedules.ts`，默认 6h、overlap=SKIP、env 可调、worker 启动幂等自愈）——此前只在 verify 脚本活、生产永不触发。`listExternalIntentTargets`（ownerDb 只读枚举**全部** ACTIVE ICP——**无静默截断**防旧 ICP 饿死，稳定序 id asc；+ `ted`/`openfda` data_provider ENABLED kill-switch）→ 逐 ICP `projectExternalIntentForIcp`：ICP `companyAttributes`/`targetMarkets` → **确定性**(`allowLlm:false`，调度不臆造码/可复现/零 LLM 成本) `resolveIcpToCpv` + `resolveIcpToFda` → `projectTenders` + `projectClearances`。各 provider 独立 enabled 门 + 单 provider/ICP 失败 fail-safe；投影写走 `withWorkspace`(RLS)，跨租户枚举走「受信系统扫描器」先例；§8.8 门由两 service 各自守；worker 抽共享 `TaxonomyResolver` 一实例。**实测**（真库真 API 无 sandbox，`verify-external-intent-sweep.mts` 四段全绿·活动级）：pumps+EU→CPV 1 码→**68 招标→54 买方→54 TENDER_PUBLISHED**；radiology+US→6 FDA 码→**82 清关→70 公司→70 FDA_CLEARANCE**；`ted` DISABLED→跳过。340 单测 + 对抗复审（1 finding 加固：去枚举静默截断防饿死）。PR #38。
- **词表归一**：`canonical_taxonomy` + `term_alias`（ISIC + ISO3166 + **CPV 子树**，265 节点），`TaxonomyResolver`（确定性 + LLM 冷路径 + `crosswalks` 暴露供 ICP→CPV）。
- **接口门户** Scalar `/api/portal`；**JWKS 鉴权**（生产禁 dev stub）；helmet+CORS+限流护栏。

## 5. 硬约束 / 决策（别违背）

- **真实数据，不用 sandbox**；要真实测试 + 评判。跑 provider 用 `node --import tsx` 或 `npx tsx`，脚本放 `apps/api` 且手动载 `.env`（ESM 相对 import 按文件位置解析）。
- 🔴 **合规红线**（详见 [trade-fair-intelligence.md §0](docs/implementation-records/trade-fair-intelligence.md)）：**技术能抓 ≠ 合规能用**。RX 官网 ToS 禁爬；用 public key 打 Algolia 撞其 ToS §4.5(h)（灰偏红）；个人数据受 GDPR Art.14（欧盟「公开≠可自由再用」）。**数据分级**：🟢公司事实+GLEIF(CC0) 可商用 / 🟡职能邮箱 走 ePrivacy / 🔴人名邮箱·联系人 默认隔离 + LIA。
- SearXNG 引擎以当前 Ubuntu 真机健康探测为准；旧 Mac 的 SNI 过滤只属迁移历史，不再作为现行选型约束。
- Provider/富集失败 **fail-safe 返回 0/miss**，不阻断其余源；单展会/单源失败不影响整体。

## 6. 当前主线与冻结 backlog

> 🔴 **2026-07-13 起获客侧开发暂停**（用户指示，明确通知才恢复）。当前唯一主线 = **Site Builder**。活文档是 [docs/site-builder/](docs/site-builder/) 00–14 + [ADR-013~019](docs/adr/registry.md)；v3.1/v3.2 与旧 Word/研究稿只作 dated proposal/历史输入，不能覆盖活文档或代码。
>
> **DOC-12 状态**：#119/#120 已把主要设计内容分发入活文档；2026-07-16 truth-sync（#125）已收口项目级状态、00–14 漂移与接入说明，R0 contract（#126）已闭环，不把 DOC-12 重新描述为一项代码能力。**下一关键路径**：R1-safety ①构建隔离已完成，继续 R1-safety ② Crawl/robots 全链 egress/SSRF 收口 → R2-A（拆分 Asset/KB/Profile 正确性状态机）→ MF-0-thin → M1-c 纯 Sharp。R1-min 其余原子预览与未知组件 fail-closed 可并行；严禁把 R2-A 做成 schema/API/Temporal/迁移一体的 mega PR。
>
> 工作流程红线：**先研究对标 → 讨论 → 用户认可 → 再提交**。本节以下保留获客侧冻结 backlog，仅供恢复时参考。

核心反转：从「公司名单」→「可成单线索」（补三缺环：**需求证据/对的人/时机**）。**免费优先**，复用已有基建（diff→网站变更 intent、pgvector→look-alike、name-match→consignee 实体解析、first-seen→新进口商、crawl4ai 抓包→通用 API 逆向）。

- P0 复用四件套 ✅ 全部落地（见 §4）：✅ `digital_footprint` · ✅ `structured_harvest`（下一步主路加**自有 ATS JSON 逆向** Greenhouse/Lever，sitemap 兜底） · ✅ **自建邮箱验证** `smtp_self`（#3） · ✅ **网站变更=intent 引擎** `web_watch`（#4，复用 `source_entity_change` diff）。✅ intent 事件已接进**六维 Intent 维评分**（`lead/scoring.ts`：真实 `attributes.intent.*` 逐事件按新近度衰减(半衰期 60d)取最强 + 关键词代理兜底，压过纯代理；关键词代理排除 intent 命名空间防双重计数）。✅ **从 ICP 短名单自动 `registerWatch`**（`discovery.activities.registerWatchesForRun`：`discoveryWorkflow` 信号富集后，对本 run fit=match+域名公司自动建 web_watch，交 intentSweep 持续盯——loop 收口；best-effort 长活动）。**dev 实测整条链路**（`verify-intent-loop.mts`，真库真 crawl）：TRUMPF supplier 页真实 diff→`SOURCING_OPENED`→投影→**Intent 维 0→1、总分 0.39→0.54**。✅ **管线通脉（2026-07-08，见 §4 存量对账管线）**：存量 900+ 家进漏斗、recommended 加 Reachability 硬底、decision_maker 复活、双 loop 收口——「已建好的东西在存量上真跑」优先于建新能力。下一步主路：六维**加法→乘法门**（Fit^a×(1+Intent)×Reachability×…，让可达/需求=0 不被高 Fit 冲淡；需 backtest 校准阈值）+ TED v3/DLP 提单（需求证据）。
- P1 免费外部源：**招投标 TED v3** ✅ **P1 中标发现 + P2 ICP→CPV + P3 招标 intent 已落地**（见 §4 · PR #30/#31/#33；SAM.gov Sources Sought P4 已落地 #99、默认 DISABLED） · **海关提单**（ImportYeti 免费按公司搜/50 票顶 + **Data Liberation Project FOIA 可再分发基线** + 逆向内部 API 做 HS 反查；美线法定公开 19 USC §1431） · **认证注册库**（openFDA/FCC/EUDAMED 免费官方，注册人=合规卖家；**openFDA P1 器械注册发现 + P2 ICP→FDA 产品码 + P3 510(k)→FDA_CLEARANCE intent 已落地** 见 §4 · PR #34/#36/#37；下一步 P4 富集/P5 monitoring/foiclass 全表种子） · **专利 inventor**（USPTO/EPO 免费=具名工程决策人） · 国家级贸易统计（Comtrade/Census/Eurostat）。
- 付费仅留插槽（Panjiva/多国空运提单等）；决策人具名一律 `personalData=true` 🔴 + LIA。

## 7. 文档索引（单一事实源体系，2026-07-10 重构）

**权威层（先读这四份）**：`docs/product-scope.md`（产品面与边界）· `docs/architecture/current.md`（as-built）· `docs/adr/registry.md`（ADR-001~019 + PDR，唯一承重决策真值）· `docs/status/current.md`（当前主线与完成度）。
**路线**：当前站建施工序看 `docs/roadmap/release-plan.md` + `docs/site-builder/09-m1-implementation-design.md`；获客历史见 `docs/roadmap/changelog.md`。
**基底与归档**：`docs/platform/` 两份 docx 与仓内旧 Word 均是待批准/历史输入，不升级为权威；`docs/research/` 为研究归档；`docs/implementation-records/` 为已实施专题记录。
**仍在 docs/backend/ 的活文档**：`discovery-sources.md` · `vocab-taxonomy.md` · `oss-registry.md` · `ci-merge-automation.md`。

## 8. 团队协作 / PR / 测试流程（团队开发，每次改动照做）

> 这是**团队仓库**（后续与其他成员合并），走 PR + CI + 自动审查，不直推 `main`。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- **分支**：Codex 开发统一使用 `codex/<topic>`，从最新 `main` 切出；**不在 `main` 直接提交**（`main` 复位跟随 origin）。改动性质由 Conventional Commit 的 `feat` / `fix` / `docs` 等 type 表达。
- **worktree 持久性**：正式开发 worktree 只能放在持久目录（当前统一 `/global/wt/<topic>`），**禁止放 `/tmp`、`/private/tmp` 或其他重启/清理会丢失的临时目录**。跨阶段修改及时做 checkpoint commit 并 push；未提交工作区不作为记忆或备份。
- **异常恢复**：重启/中断/目录消失后不得先断言“未提交修改已丢失”或立即重写；先按 [CONTRIBUTING.md「异常恢复审计」](CONTRIBUTING.md#异常恢复审计先取证后重做) 检查 Git、Codex 任务事件日志/UI、附件/子任务和文件系统，再在持久 recovery worktree 重放与三方核对。
- **提交**：Conventional Commits（`feat(scope):` / `fix` / `docs` / `refactor` / `test` / `chore`）；正文说清「为什么 + 实测」；协作提交按实际参与者填写 `Co-Authored-By`，不伪造身份。
- **本地必绿**：`pnpm --filter @global/db generate`（schema 变）→ `pnpm --filter @global/api build`（=tsc 类型检查）→ `pnpm --filter @global/api test`（vitest）。provider/采集/富集类改动**另需真实数据实测**（`cd /global/backend/apps/api && node --import tsx scripts/verify-*.mts`，无 sandbox，§5 硬规矩）。
- **PR**：`gh pr create --base main`，填 `.github/pull_request_template.md`。CI（`.github/workflows/ci.yml`：install→prisma generate→build→test）+ Security（`security.yml`：gitleaks 密钥扫描）绿了才合。
- **代码审查**：仓库启用 **Codex 自动审查**（开 PR/标 ready/评论 `@codex review` 触发）。处置每条 inline 意见后，在该线程回复（`gh api …/comments/{id}/replies`）并 GraphQL `resolveReviewThread` 解决。
- **合并权限**：Codex 负责把 CI、gitleaks、契约门和审查线程收口，并按风险追加真库/真源/对抗验证；**不得自行合并 `main`**。Codex 报告证据后，须由用户明确确认，再由用户或用户当次明确授权的 Codex 执行合并。详见 [docs/backend/ci-merge-automation.md](docs/backend/ci-merge-automation.md)。
- **CI 只跑纯单测**（无 DB/网络）；需 DB/真源的验证走本地 verify 脚本。**依赖更新** dependabot（周更，npm+actions）。

## 9. Codex 分析与取证纪律（用户纠正，跨任务生效）

- **表象不等于状态**：把“看不见目录”“命令失败”“UI 显示完成”等表象拆成存储、可见性、持久化、可恢复性和业务结果分别判断，禁止一步跳到“已丢失/已完成/不可做”。
- **多假设并行**：在采用一个解释前至少检查相互竞争的可能性；先写清已证事实、待证假设和结论门，不把记忆、猜测或单一工具输出当事实源。
- **反证优先**：主动寻找能推翻当前判断的证据。若出现矛盾（例如文件系统目录消失但客户端仍能展示精确 diff），立即停止既定方案，解释矛盾并重建假设，不能沿原计划继续优化。
- **跨层取证**：按问题覆盖 Git/PR、worktree/文件系统、Codex 任务事件/UI、附件与子任务、运行服务/数据库、外部系统等独立证据面；不能因为一个层面失败就宣布整体失败。
- **可逆动作优先**：在删除、覆盖、重做、大规模迁移或高返工操作前，先冻结现场、建隔离快照并做最小判别检查；任何恢复稿先标候选，不冒充原始内容。
- **结论必须有门**：声明“已恢复/已完成/已安全/可合并”前，列出可复核的充分证据和残余不确定性；存在未解释反证时，结论只能是“部分”或“待核验”。
