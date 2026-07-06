# Global — 出海企业 AI 全球客户开发与增长执行平台（后端）

面向中国出海企业的 AI 全球客户开发与增长执行平台的**后端**。前端由独立团队开发，前后端通过接口（OpenAPI / AsyncAPI）对接。

产品文档（权威基线，v3.0）：
- `出海企业AI全球客户开发与增长执行平台_产品总纲与产品手册_v3.0_完整评审稿.docx` — 上游权威（定位 / 宪章 / QGO / 边界）
- `出海企业AI全球客户开发与增长执行平台_产品总体PRD_v3.0_完整评审稿.docx` — 实现基线（流程 / 状态机 / 数据 / API / ADR）

后端路线图见 [`docs/backend/roadmap-ai-acquisition.md`](docs/backend/roadmap-ai-acquisition.md)。

## 技术栈

NestJS/Nx 模块化单体 · PostgreSQL(+pgvector) · Redis · Temporal · LiteLLM 模型网关 · OPA 策略 · Transactional Outbox。详见 PRD 第 11 部分与已锁定 ADR。

## 目录结构（PRD 11.5）

```
apps/
  api/                 NestJS BFF/API（当前：/health）
  worker-ai/           AI tasks & retrieval（P1+）
  worker-data/         provider / identity / crawling（P3+）
packages/
  contracts/           OpenAPI · AsyncAPI events · JSON Schemas
  domain-*/            领域模型与应用服务（P1+，不依赖 Provider SDK）
  adapters-*/          Provider 反腐层（P3+）
docs/backend/          路线图与设计
docker-compose.yml     本地 PG + Redis
```

## 本地起步

```bash
pnpm install                              # 安装依赖
pnpm infra:up                             # 起 PostgreSQL(+pgvector) 与 Redis
pnpm --filter @global/db exec prisma migrate deploy   # 建表 + RLS
temporal server start-dev --ip 127.0.0.1  # 起 Temporal dev server（UI :8233）

# 两个进程：
pnpm --filter @global/api build && pnpm --filter @global/api worker   # 理解工作流 worker
pnpm api:dev                              # API（含 Outbox relay），/api/v1/health、文档 /api/docs
```

冒烟：`pnpm --filter @global/db rls:check`（租户隔离）、`pnpm --filter @global/api mg:check`（模型网关）。

> 需要 Node ≥ 20、pnpm、Docker、Temporal CLI（`curl -sSf https://temporal.download/cli.sh | sh`）。
