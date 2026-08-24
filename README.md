# Global — 出海企业 AI 全球客户开发与增长执行平台（后端）

本仓包含两个产品面：

- **买家智能与机会资格后端**：多源发现 → 身份解析 → 证据/权利 → 意向信号 → 决策人与邮箱验证 → 六维评分 → `LeadQualifiedPackage`。边界止于交付包（ADR-001）；身份/Campaign/触达/QGO/归因归外部 SaaS。
- **Site Builder 独立站建设子系统**：注册引导 → 资料/素材/KB → 有界 AI Task + Temporal 固定 DAG → SiteSpec → Astro 静态站。Site Builder M1 已完成阶段收口；获客侧新增开发冻结已解除。下一项施工必须以当前状态、owner、合规/成本门和验收证据重新选择，不能从历史路线自动继承授权。

当前源码中 `site_builder.copy` 的 active route 为 `claude-sonnet-5` / Anthropic Messages（`anthropic-messages`）/ `medium` / no fallback；只有 `SITE_BUILDER_MODEL_ROLLBACK_COPY=true` 才改走 `deepseek-v4-pro → glm-5.2` / `low`。此处描述的是 source-level route，不证明当前进程已采用该提交，也不证明生产部署、fresh RuntimeEvidence 或 Release Bundle。精确提交、在途事项和下一门只看 [当前状态](docs/status/current.md)，历史过程只看 [changelog](docs/roadmap/changelog.md) 与 evidence。

## 文档入口（单一事实源体系）

| 问题                          | 看哪里                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 产品是什么、边界、决策        | [docs/product-scope.md](docs/product-scope.md)                                                                     |
| 本仓架构（as-built + 缺口）   | [docs/architecture/current.md](docs/architecture/current.md)                                                       |
| 架构/产品决策注册表           | [docs/adr/registry.md](docs/adr/registry.md)                                                                       |
| 当前状态与待拍板              | [docs/status/current.md](docs/status/current.md)                                                                   |
| 当前门与路线                  | [docs/roadmap/release-plan.md](docs/roadmap/release-plan.md)（历史见 [changelog](docs/roadmap/changelog.md)）      |
| Site Builder 域文档与历史设计 | [docs/site-builder/](docs/site-builder/) 00–14；当前施工选择仍以 status/release-plan 为准                          |
| 全平台顶层基底（L0/L1）       | [docs/platform/](docs/platform/) 交付包（待批准评审稿）                                                            |
| 研究归档                      | [docs/research/](docs/research/)（含冻结期保留的 v3.0 相关研究；两份 v3.0 Word 评审稿=研究综合稿，不再是权威基线） |

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
docker-compose.yml   10 服务：PG/Redis/new-api/openox-video-compat/crawl4ai/MinIO/MinIO bootstrap/embeddings/Docling/SearXNG
```

## 本地起步

```bash
cd /global/backend
pnpm install --frozen-lockfile
docker compose -p global up -d             # 10 个 global-* 服务（含一次性 MinIO bootstrap）
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
