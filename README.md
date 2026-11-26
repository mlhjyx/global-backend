# Global — 出海企业 AI 全球客户开发与增长执行平台（后端）

本仓包含两个产品面：

- **买家智能与机会资格后端**：多源发现 → 身份解析 → 证据/权利 → 意向信号 → 决策人与邮箱验证 → 六维评分 → `LeadQualifiedPackage`。边界止于交付包（ADR-001）；身份/Campaign/触达/QGO/归因归外部 SaaS。
- **Site Builder 独立站建设子系统**：注册引导 → 资料/素材/KB → 有界 AI Task + Temporal 固定 DAG → SiteSpec → Astro 静态站。Site Builder M1 已完成阶段收口；获客侧新增开发冻结已解除。下一项施工必须以当前状态、owner、合规/成本门和验收证据重新选择，不能从历史路线自动继承授权。

先从 [项目文档门户](docs/README.md) 选择任务。源码接线、模型策略和运行开关见 [当前架构](docs/architecture/current.md)，部署与验收证据见 [当前状态](docs/status/current.md)。

## 文档入口（单一事实源体系）

| 问题                          | 看哪里                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 产品是什么、边界、决策        | [docs/product-scope.md](docs/product-scope.md)                                                                     |
| 本仓架构（as-built + 缺口）   | [docs/architecture/current.md](docs/architecture/current.md)                                                       |
| 架构/产品决策注册表           | [docs/adr/registry.md](docs/adr/registry.md)                                                                       |
| 当前状态与待拍板              | [docs/status/current.md](docs/status/current.md)                                                                   |
| 当前门与路线                  | [docs/status/release-plan.md](docs/status/release-plan.md)（历史见 [changelog](docs/roadmap/changelog.md)）      |
| Site Builder 域文档与历史设计 | [docs/site-builder/](docs/site-builder/) 00–14；当前施工选择仍以 status/release-plan 为准                          |
| 全平台顶层基底（L0/L1）       | [docs/platform/](docs/platform/) 交付包（待批准评审稿）                                                            |
| 研究归档                      | [docs/research/](docs/research/)（含冻结期保留的 v3.0 相关研究；两份 v3.0 Word 评审稿=研究综合稿，不再是权威基线） |

> 跨会话工程上下文与现行规则只读 [AGENTS.md](AGENTS.md)；[CLAUDE.md](CLAUDE.md) 仅为旧 Claude Code 入口兼容。

## 技术栈（as-built）

NestJS/Nx 模块化单体（`apps/api`，含 Temporal worker 入口）· Astro 站点渲染器（`apps/site-renderer`）· Prisma + PostgreSQL(+pgvector) 多租户 RLS · Redis · Temporal · MinIO · Docling · BGE-M3/Ollama · **new-api 模型中转站**（统一网络出口；按任务合同使用对应原生协议）· Transactional Outbox · ToolBroker/source_policy/field_evidence/suppression。OPA 未上（确定性 PolicyPort 过渡）。API 门户：Scalar `/api/portal`，OpenAPI 由代码生成（`packages/contracts/openapi/openapi.json` 为唯一 REST 真值）。

## 目录结构（as-built）

```
apps/api/            NestJS API + Temporal worker（模块：company/claim/icp/discovery/
                     adapters/acquisition/intent/lead/enrichment/outreach/site-builder/tools/model-gateway/relay/auth…）
apps/site-renderer/  Astro 静态站渲染器（消费 @global/contracts SiteSpec）
packages/db/         Prisma schema + migrations（RLS）
packages/contracts/  OpenAPI 导出 · 事件 envelope · SiteSpec/DQ-1 共享契约
docs/                文档树（见上表）
infra/               searxng 等本地服务配置
docker-compose.yml   10 服务：PG/Redis/new-api/openox-video-compat/crawl4ai/MinIO/MinIO bootstrap/embeddings/Docling/SearXNG
```

## 本地起步

宿主是 xin（原生 Ubuntu 26.04），WSL 已于 2026-09-23 停用，xin 是唯一开发与运行机器。本机起停服务、密钥位置与已知陷阱以 `/global/CLAUDE.md` 为准；其中的工作区工具 `gctl`（`/global/local-config/bin/gctl`）封装了下面各档所需的 launcher 与 `--env-file` 注入 —— **裸跑 `docker compose -p global up -d` 会因缺少必需变量失败**。

工具链：Node 22、pnpm 9.15.9（由 `package.json` 的 `packageManager` 锁定，`corepack enable` 即可）、Docker（本机工具用 `DOCKER_CONTEXT=default`），与 CI 一致。

在 xin 开发时，先按 [worktree 手册](docs/backend/worktree-management.md) 创建 `/global/.agy-worktrees/backend/<topic>` 下的隔离工作树。下面的数据库与 API 构建步骤只在任务需要时执行。通过 `gctl link-env` 准备本机已授权的开发配置；新克隆参照仓内 `.env.example`。

```bash
gctl link-env "$PWD"
pnpm install --frozen-lockfile
pnpm --filter @global/db generate
pnpm --filter @global/contracts build
pnpm --filter @global/api build          # 部分单测加载编译产物（apps/api/dist），先 build 再测
```

### 开发循环三档

按任务需要的**最小一档**起，不必常驻全部容器：

| 档 | 用途 | 命令 | 需要的容器 |
| --- | --- | --- | --- |
| 单测 | 日常 TDD | `APP_DATABASE_URL= pnpm --filter @global/api test` | 无 |
| 源码热重载 | 开发 API 端点 | `gctl up core` 后 `pnpm api:dev` | postgres · redis · minio · temporal |
| managed runtime | RuntimeEvidence / UAT / 三方旅程 | `gctl up all` | 全部（依当前运行模式） |

- **单测**：`APP_DATABASE_URL` 一旦可见（含 Prisma 自动加载的 `packages/db/.env`），PostgreSQL JSONB 字节门等少量只读集成用例就会连库；库不在时它们失败而不是跳过。零容器跑时显式置空，`gctl up core` 后直接跑即可多覆盖这部分。计数以本次命令输出为准，不在 README 固化。
- **源码热重载**：`start:dev` 是 `nest start --watch`，交互门户在 `/api/portal`。源码运行不持有 runtime lease，`/api/v1/health/ready` 为 503、outbox relay 报 admission closed 是设计如此；读写接口可正常调试。
- **常规 Worker 使用受证制品**（平台目录初始化和调度以[当前运行架构](docs/architecture/current.md#运行模式与开关)及实际启动配置为准）：`apps/api/src/runtime/` 对 `test` 以外的所有模式（含 `development`）强制 `BUILD_ATTESTATION_REQUIRED`，源码 `pnpm --filter @global/api worker` 会停在该门。除已登记的[开发快速通道](docs/backend/dev-fast-lane.md)外，Worker 与 managed API 使用已发布镜像（`infra/backend-runtime.compose.yml`，镜像按 digest 钉住）。
- Temporal 由容器 `global-temporal-dev` 提供，定义在仓外 `/global/local-config/global/infra.local.yaml`，不在仓库 `docker-compose.yml` 中；旧 `temporal-dev.service` 已 disable 并停止。核心基础设施容器（`postgres`/`redis`/`minio`/`temporal`）与 API/Worker 的 `restart` 策略为 `unless-stopped`，其余按需容器为 `no`；宿主重启后按 `/global/local-config/RUNBOOK.md` §8 顺序核验恢复。

首次建库（全新数据卷）：

```bash
gctl up core
pnpm --filter @global/db exec prisma migrate deploy        # 读 packages/db/.env 的 DATABASE_URL
pnpm --filter @global/api build && (cd apps/api && node scripts/seed-taxonomy.mjs)   # dotenv 读 apps/api/.env
# 平台目录初始化按部署入口核对，见 apps/api/package.json 的 seed:platform-catalogs
```

> 从旧的目录推导项目 `global-backend` 迁移时，先按 [Compose 项目名迁移 runbook](docs/backend/compose-project-migration.md) 核对标签、卷并备份；不要直接 `docker compose down -v`。

Provider/采集/富集类改动交付真实验证证据，调用前核对数据、成本与独立授权（`cd apps/api && node --import tsx scripts/verify-*.mts`，无 sandbox）。团队流程（PR/CI/审查/合并）见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [AGENTS.md §5 / §9](AGENTS.md)。
