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
- **词表归一**：`canonical_taxonomy` + `term_alias`（ISIC + ISO3166，260 节点/1910 别名），`TaxonomyResolver`（确定性 + LLM 冷路径）。
- **接口门户** Scalar `/api/portal`；**JWKS 鉴权**（生产禁 dev stub）；helmet+CORS+限流护栏。

## 5. 硬约束 / 决策（别违背）

- **真实数据，不用 sandbox**；要真实测试 + 评判。跑 provider 用 `node --import tsx` 或 `npx tsx`，脚本放 `apps/api` 且手动载 `.env`（ESM 相对 import 按文件位置解析）。
- 🔴 **合规红线**（详见 [trade-fair-intelligence.md §0](docs/backend/trade-fair-intelligence.md)）：**技术能抓 ≠ 合规能用**。RX 官网 ToS 禁爬；用 public key 打 Algolia 撞其 ToS §4.5(h)（灰偏红）；个人数据受 GDPR Art.14（欧盟「公开≠可自由再用」）。**数据分级**：🟢公司事实+GLEIF(CC0) 可商用 / 🟡职能邮箱 走 ePrivacy / 🔴人名邮箱·联系人 默认隔离 + LIA。
- SearXNG 用**放行侧引擎**（Yandex/Marginalia/Mojeek）——Mac 网络对消费级搜索引擎做 SNI 过滤，WSL 无此问题。
- Provider/富集失败 **fail-safe 返回 0/miss**，不阻断其余源；单展会/单源失败不影响整体。

## 6. 下一步（P0）

- **展会情报子系统 P0**（[trade-fair-intelligence.md](docs/backend/trade-fair-intelligence.md)）：① 5 张平台级表 migration；② 历史届改造（RX/Algolia 单 index 存 3 届，`enumerateEditions` + 可遍历 `eventEditionId`，`organisationGuid` 跨届主键）；③ **MapYourShow handler**（无鉴权公开 JSON，覆盖 150+ 制造业展）。
- **决策人联系层续**：邮箱模式推断 + SMTP 验证、持久化到 `canonical_contact`（加 buying_role/personal_data/lawful_basis）、买家委员会覆盖度、付费源瀑布。

## 7. 文档索引（docs/backend/）

`roadmap-ai-acquisition.md`(全量进度) · `discovery-architecture.md`(四层/Agent/MCP) · `discovery-sources.md`(源→方法→字段→合规蓝图) · `trade-fair-intelligence.md`(展会子系统设计+合规) · `vocab-taxonomy.md`(词表) · `api-management.md`(门户) · `oss-registry.md`。
