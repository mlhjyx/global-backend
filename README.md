# Global — 出海企业 AI 全球客户开发与增长执行平台（获客后端）

面向中国出海企业的 AI 全球客户开发与增长执行平台的**获客情报后端**（买家智能与机会资格引擎）：多源发现 → 身份解析 → 证据/权利 → 意向信号 → 决策人与邮箱验证 → 六维评分 → 合格线索交付。边界止于 `LeadQualifiedPackage`（ADR-001）；身份/Campaign/触达/QGO/归因归外部 SaaS 平台（另一团队开发，接口对接）。

## 文档入口（单一事实源体系）

| 问题 | 看哪里 |
|---|---|
| 产品是什么、边界、决策 | [docs/product-scope.md](docs/product-scope.md) |
| 本仓架构（as-built + 缺口） | [docs/architecture/current.md](docs/architecture/current.md) |
| 架构/产品决策注册表 | [docs/adr/registry.md](docs/adr/registry.md) |
| 当前状态与待拍板 | [docs/status/current.md](docs/status/current.md) |
| 收口 backlog 与路线 | [docs/roadmap/release-plan.md](docs/roadmap/release-plan.md)（历史见 [changelog](docs/roadmap/changelog.md)） |
| 全平台顶层基底（L0/L1） | [docs/platform/](docs/platform/) 交付包（待批准评审稿） |
| 研究归档 | [docs/research/](docs/research/)（含冻结的 v3.0 相关研究；两份 v3.0 Word 评审稿=研究综合稿，不再是权威基线） |

> 跨会话工程上下文：[CLAUDE.md](CLAUDE.md)（Claude）/ [AGENTS.md](AGENTS.md)（Codex）。

## 技术栈（as-built）

NestJS/Nx 模块化单体（单 `apps/api`，含 Temporal worker 入口）· Prisma + PostgreSQL(+pgvector) 多租户 RLS · Redis · Temporal（3 workflow + 4 Schedule）· **new-api 模型中转站**（单一 OpenAI 兼容端点；非 LiteLLM）· Transactional Outbox · ToolBroker/source_policy/field_evidence/suppression。OPA 未上（确定性 PolicyPort 过渡）。API 门户：Scalar `/api/portal`，OpenAPI 由代码生成（`packages/contracts/openapi/openapi.json` 为唯一 REST 真值）。

## 目录结构（as-built）

```
apps/api/            NestJS API + Temporal worker（模块：company/claim/icp/discovery/
                     adapters/acquisition/intent/lead/contact/tools/model-gateway/relay/auth…）
packages/db/         Prisma schema + migrations（RLS）
packages/contracts/  OpenAPI 导出（openapi.json）· 事件 envelope · 通用约定
docs/                文档树（见上表）
infra/               searxng 等本地服务配置
docker-compose.yml   PG + Redis + new-api + crawl4ai + searxng
```

## 本地起步

```bash
pnpm install
docker compose up -d                       # PG(pgvector) / Redis / new-api:3001 / crawl4ai:11235 / searxng:8081
cd packages/db && DATABASE_URL=postgresql://global:global@localhost:5432/global_dev \
  pnpm exec prisma migrate deploy && pnpm exec prisma generate
DATABASE_URL=... node apps/api/scripts/seed-taxonomy.mjs   # 词表种子（先 build）
~/.temporalio/bin/temporal server start-dev --db-filename ~/temporal.db &   # :7233
pnpm --filter @global/api build
pnpm --filter @global/api start:dev        # API（含 Outbox relay），门户 /api/portal
pnpm --filter @global/api worker           # Temporal worker（启动时幂等 seed + ensure 4 个 Schedule）
cd apps/api && pnpm test                   # vitest（340+ 单测）
```

Provider/采集/富集类改动**必须真实数据实测**（`node --import tsx scripts/verify-*.mts`，无 sandbox）。团队流程（PR/CI/审查/合并）见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 CLAUDE.md §8。

> 需要 Node ≥ 20、pnpm、Docker、Temporal CLI。
