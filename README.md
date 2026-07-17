# Global — 出海企业 AI 全球客户开发与增长执行平台（后端）

本仓包含两个产品面：

- **买家智能与机会资格后端**：多源发现 → 身份解析 → 证据/权利 → 意向信号 → 决策人与邮箱验证 → 六维评分 → `LeadQualifiedPackage`。边界止于交付包（ADR-001）；身份/Campaign/触达/QGO/归因归外部 SaaS。
- **Site Builder 独立站建设子系统**：注册引导 → 资料/素材/KB → 有界 AI Task + Temporal 固定 DAG → SiteSpec → Astro 静态站。**这是 2026-07-13 起的当前开发主线**；获客侧暂停开发、保留维护，明确通知后才恢复。

2026-07-16 truth-sync（#125）已对齐 Ubuntu/Codex 项目真值；R0 contract closeout（#126）已在 #121/#123/#124 的行为与安全修复之上补齐 intake `Idempotency-Key`、`buildId`、稳定错误码、Temporal 启动证据和 code-first OpenAPI，并移除旧响应 `mode`。2026-07-17 R1-safety、R2-A1–A4、MF0-A/B、M1-c 纯 Sharp 与 R3-A BuildRun 数据库背书均已完成；下一施工顺序为 R3-B → R4-A1 → R4-A2 → R4-B-min，再进入 M1-d 多语种事实受限文案，R1-min 预览安全门在 M1-e 前并行收口。Ubuntu 仅为开发/验证环境，不代表生产部署。

## 文档入口（单一事实源体系）

| 问题 | 看哪里 |
|---|---|
| 产品是什么、边界、决策 | [docs/product-scope.md](docs/product-scope.md) |
| 本仓架构（as-built + 缺口） | [docs/architecture/current.md](docs/architecture/current.md) |
| 架构/产品决策注册表 | [docs/adr/registry.md](docs/adr/registry.md) |
| 当前状态与待拍板 | [docs/status/current.md](docs/status/current.md) |
| 收口 backlog 与路线 | [docs/roadmap/release-plan.md](docs/roadmap/release-plan.md)（历史见 [changelog](docs/roadmap/changelog.md)） |
| Site Builder 活文档与施工图 | [docs/site-builder/](docs/site-builder/) 00–14；施工顺序见 [09](docs/site-builder/09-m1-implementation-design.md) |
| 全平台顶层基底（L0/L1） | [docs/platform/](docs/platform/) 交付包（待批准评审稿） |
| 研究归档 | [docs/research/](docs/research/)（含冻结的 v3.0 相关研究；两份 v3.0 Word 评审稿=研究综合稿，不再是权威基线） |

> 跨会话工程上下文与现行规则只读 [AGENTS.md](AGENTS.md)；[CLAUDE.md](CLAUDE.md) 仅为旧 Claude Code 入口兼容。

## 技术栈（as-built）

NestJS/Nx 模块化单体（`apps/api`，含 Temporal worker 入口）· Astro 站点渲染器（`apps/site-renderer`）· Prisma + PostgreSQL(+pgvector) 多租户 RLS · Redis · Temporal · MinIO · Docling · BGE-M3/Ollama · **new-api 模型中转站**（单一 OpenAI 兼容端点；非 LiteLLM）· Transactional Outbox · ToolBroker/source_policy/field_evidence/suppression。OPA 未上（确定性 PolicyPort 过渡）。API 门户：Scalar `/api/portal`，OpenAPI 由代码生成（`packages/contracts/openapi/openapi.json` 为唯一 REST 真值）。

## 目录结构（as-built）

```
apps/api/            NestJS API + Temporal worker（模块：company/claim/icp/discovery/
                     adapters/acquisition/intent/lead/contact/site-builder/tools/model-gateway/relay/auth…）
apps/site-renderer/  Astro 静态站渲染器（消费 @global/contracts SiteSpec）
packages/db/         Prisma schema + migrations（RLS）
packages/contracts/  OpenAPI 导出 · 事件 envelope · SiteSpec/DQ-1 共享契约
docs/                文档树（见上表）
infra/               searxng 等本地服务配置
docker-compose.yml   8 服务：PG/Redis/new-api/crawl4ai/MinIO/embeddings/Docling/SearXNG
```

## 本地起步

```bash
cd /global/backend
pnpm install
docker compose -p global up -d             # 8 个 global-* 服务
DATABASE_URL=postgresql://global:global@localhost:5432/global_dev pnpm --filter @global/db exec prisma migrate deploy
pnpm --filter @global/db generate
systemctl status temporal-dev              # Ubuntu 26.04：Temporal :7233 由 systemd 托管
pnpm --filter @global/contracts build
pnpm --filter @global/api build
DATABASE_URL=postgresql://global:global@localhost:5432/global_dev node apps/api/scripts/seed-taxonomy.mjs
pnpm --filter @global/api start:dev        # API（含 Outbox relay），门户 /api/portal
pnpm --filter @global/api worker           # Temporal worker（启动时幂等 seed + ensure 4 个 Schedule）
pnpm --filter @global/api test             # vitest；以本次命令输出为准，不在 README 固化计数
```

> 从旧的目录推导项目 `global-backend` 迁移时，先按 [Compose 项目名迁移 runbook](docs/backend/compose-project-migration.md) 核对标签、卷并备份；不要直接 `docker compose down -v`。

Provider/采集/富集类改动**必须真实数据实测**（`cd /global/backend/apps/api && node --import tsx scripts/verify-*.mts`，无 sandbox）。团队流程（PR/CI/审查/合并）见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md §8](AGENTS.md)。

> 当前施工环境为 Ubuntu 26.04 `/global/backend`。需要 Node ≥ 20、pnpm、Docker；Temporal 开发服务由 `temporal-dev.service` 管理。
