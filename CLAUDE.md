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
- **词表归一**：`canonical_taxonomy` + `term_alias`（ISIC + ISO3166，260 节点/1910 别名），`TaxonomyResolver`（确定性 + LLM 冷路径）。
- **接口门户** Scalar `/api/portal`；**JWKS 鉴权**（生产禁 dev stub）；helmet+CORS+限流护栏。

## 5. 硬约束 / 决策（别违背）

- **真实数据，不用 sandbox**；要真实测试 + 评判。跑 provider 用 `node --import tsx` 或 `npx tsx`，脚本放 `apps/api` 且手动载 `.env`（ESM 相对 import 按文件位置解析）。
- 🔴 **合规红线**（详见 [trade-fair-intelligence.md §0](docs/backend/trade-fair-intelligence.md)）：**技术能抓 ≠ 合规能用**。RX 官网 ToS 禁爬；用 public key 打 Algolia 撞其 ToS §4.5(h)（灰偏红）；个人数据受 GDPR Art.14（欧盟「公开≠可自由再用」）。**数据分级**：🟢公司事实+GLEIF(CC0) 可商用 / 🟡职能邮箱 走 ePrivacy / 🔴人名邮箱·联系人 默认隔离 + LIA。
- SearXNG 用**放行侧引擎**（Yandex/Marginalia/Mojeek）——Mac 网络对消费级搜索引擎做 SNI 过滤，WSL 无此问题。
- Provider/富集失败 **fail-safe 返回 0/miss**，不阻断其余源；单展会/单源失败不影响整体。

## 6. 下一步（v3.0 买家智能 P0，[buyer-intelligence-v3.md](docs/backend/buyer-intelligence-v3.md)）

核心反转：从「公司名单」→「可成单线索」（补三缺环：**需求证据/对的人/时机**）。**免费优先**，复用已有基建（diff→网站变更 intent、pgvector→look-alike、name-match→consignee 实体解析、first-seen→新进口商、crawl4ai 抓包→通用 API 逆向）。

- P0 复用四件套：✅ `digital_footprint` · ✅ `structured_harvest`（下一步主路加**自有 ATS JSON 逆向** Greenhouse/Lever，sitemap 兜底） · ⬜ **自建邮箱验证**（MX+SMTP RCPT；Gmail/M365/catch-all 不可标 VALID，走 RISKY+旁证） · ⬜ **网站变更=intent 引擎**（复用 `source_entity_change` diff）。
- P1 免费外部源：**海关提单**（ImportYeti 免费按公司搜/50 票顶 + **Data Liberation Project FOIA 可再分发基线** + 逆向内部 API 做 HS 反查；美线法定公开 19 USC §1431） · **招投标**（TED v3 零鉴权 API + SAM.gov Sources Sought=早数月意图） · **认证注册库**（openFDA/FCC/EUDAMED 免费官方，注册人=合规卖家） · **专利 inventor**（USPTO/EPO 免费=具名工程决策人） · 国家级贸易统计（Comtrade/Census/Eurostat）。
- 付费仅留插槽（Panjiva/多国空运提单等）；决策人具名一律 `personalData=true` 🔴 + LIA。

## 7. 文档索引（docs/backend/）

`roadmap-ai-acquisition.md`(全量进度) · `discovery-architecture.md`(四层/Agent/MCP) · `discovery-sources.md`(源→方法→字段→合规蓝图) · **`buyer-intelligence-v3.md`(v3.0 买家智能:海关提单/决策人/意图/合规,免费优先,10 支柱深研+对抗核验)** · `trade-fair-intelligence.md`(展会子系统设计+合规) · `vocab-taxonomy.md`(词表) · `api-management.md`(门户) · `oss-registry.md`。

## 8. 团队协作 / PR / 测试流程（团队开发，每次改动照做）

> 这是**团队仓库**（后续与其他成员合并），走 PR + CI + 自动审查，不直推 `main`。详见 [CONTRIBUTING.md](CONTRIBUTING.md)。

- **分支**：功能分支 `feat/<topic>` / `fix/` / `docs/`，从最新 `main` 切出；**不在 `main` 直接提交**（`main` 复位跟随 origin）。
- **提交**：Conventional Commits（`feat(scope):` / `fix` / `docs` / `refactor` / `test` / `chore`）；正文说清「为什么 + 实测」；末行 `Co-Authored-By: Claude …`。
- **本地必绿**：`pnpm --filter @global/db generate`（schema 变）→ `pnpm --filter @global/api build`（=tsc 类型检查）→ `pnpm --filter @global/api test`（vitest）。provider/采集/富集类改动**另需真实数据实测**（`node --import tsx scripts/verify-*.mts`，无 sandbox，§5 硬规矩）。
- **PR**：`gh pr create --base main`，填 `.github/pull_request_template.md`。CI（`.github/workflows/ci.yml`：install→prisma generate→build→test）+ Security（`security.yml`：gitleaks 密钥扫描）绿了才合。
- **代码审查**：仓库启用 **Codex 自动审查**（开 PR/标 ready/评论 `@codex review` 触发）。处置每条 inline 意见后，在该线程回复（`gh api …/comments/{id}/replies`）并 GraphQL `resolveReviewThread` 解决。
- **CI 只跑纯单测**（无 DB/网络）；需 DB/真源的验证走本地 verify 脚本。**依赖更新** dependabot（周更，npm+actions）。
