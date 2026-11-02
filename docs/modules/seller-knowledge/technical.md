# 卖家知识中心 · 模块技术方案

> 文档 ID：`DOC-MODULE-SELLER-KNOWLEDGE-TECH-001`
> 生命周期：`DRAFT`（依据 2026-11-02 已批准方案起草）
> 生命周期依据：承接已批准方案 D7/D8/D9/D11/D16/D17；实现事实以代码与 status 为准。
> 模块产品说明：[product.md](product.md)

## 1. 变更历史

| 日期 | 变更 | 来源 |
| --- | --- | --- |
| 2026-11-02 | 初稿：seller_document/chunk、ingest、search、事实抽取、理解双源、ICP 上下文 | 已批准方案 |

## 2. 技术概览

- 归属：引擎 `/global/backend`（NestJS + Prisma + PostgreSQL + Temporal + MinIO + Docling + BGE-M3 + pgvector）。
- 原则：CompanyProfile/Offering/Claim/Evidence 为卖家事实 SoR；新资料库 `seller_document` 挂公司档案；RLS 按 workspace。
- 复用：`site-builder/chunker.ts`、`embeddings.client.ts`、`docling.client.ts`、`storage.service.ts`、`object-key.ts` 的 MIME/魔数/大小校验、`kb.service.ts` 的 lease/fence/重试模式、`claim.service.ts` 审批/撤销/冲突。

## 3. 数据模型

### 3.1 新表

```prisma
model SellerDocument {
  id, workspaceId, companyId, uploadedBy
  filename, mime, sizeBytes, kind
  objectKey, contentHash, status, processingStage,
  processingAttempt, leaseToken, leaseUntil, retryAt,
  processingErrorCode, parsedMeta, chunkCount,
  understandingBudget, factsExtractedAt,
  deletedAt, deletedBy, cleanupEventId, cleanupCompletedAt
  @@unique([id, workspaceId])
  @@index([workspaceId, companyId, status, createdAt])
}

model SellerDocumentChunk {
  id, workspaceId, documentId, seq, text, meta,
  embedModel, embedVersion, embedding vector(1024),
  text_tsv tsvector generated
  @@unique([documentId, seq]); @@unique([id, workspaceId])
}
```

- 活跃内容唯一索引是**部分唯一索引**（`WHERE deleted_at IS NULL AND content_hash IS NOT NULL`），由迁移持有。
- RLS：两表 ENABLE + FORCE + policy（`workspace_id = current_workspace_id()`）；`app_user` 显式 GRANT；同 PR 更新 `docs/governance/app-user-table-privileges.json`。
- 现有模型扩展：`CompanyProfile.targetMarkets/businessEmail/understandingSources/deletedAt`；`Offering.source`；`KnowledgeSource.sellerDocumentId`；`Evidence.sellerDocumentId/sellerDocumentChunkId`（不重载无 FK 的 `assetId`）。

### 3.2 存储

- 独立 bucket `global-seller-documents`；key：`ws/{workspaceId}/companies/{companyId}/seller-documents/{documentId}/{sha256}.{ext}`；staging `ws/{workspaceId}/seller-documents/staging/{documentId}`。
- bucket 先于代码上线（readiness fail-closed）；staging TTL 1 天，canonical 不自动过期。

## 4. 接口设计

| 方法 | 路径 | scope | Grant | 说明 |
| --- | --- | --- | --- | --- |
| POST | `/api/v1/companies/:id/seller-documents/presign` | acquisition:write | 否 | 校验元数据/配额，返回 presigned PUT |
| POST | `/api/v1/companies/:id/seller-documents/:documentId/commit` | acquisition:write | 是 | HEAD/魔数/sha256、canonical copy、入队 |
| GET | `/api/v1/companies/:id/seller-documents` | acquisition:read | 否 | 列表 + 状态 |
| GET | `/api/v1/seller-documents/:id` | acquisition:read | 否 | 详情 + chunk 数 |
| GET | `/api/v1/seller-documents/:id/download-url` | acquisition:read | 否 | 短时 presigned GET |
| GET | `/api/v1/companies/:id/seller-documents/search` | acquisition:read | 否 | 混合检索 |
| DELETE | `/api/v1/seller-documents/:id` | acquisition:review | 否 | 软删 + 清理事件 |
| POST | `/api/v1/seller-documents/:id/retry` | acquisition:write | 否 | 重试 queued/failed |

## 5. 管线

```text
presign → commit（魔数/大小/hash/配额，advisory lock 复检）
  → Temporal seller-document-ingest（fenced claim → 下载 → Docling/文本直读
  → chunkMarkdown → EmbeddingsClient（批 32）→ 事务写 chunk + ready
  → 创建 CompanyUnderstandingRequest + outbox）
  → 失败：retry_at 指数退避（60s→1h，最多 8 次）→ failed_terminal
```

- 状态机：`pending_upload→committing→queued→processing→ready|failed_terminal|rejected|deleted`。
- 检索 SQL：`0.7 * cosine(embedding::halfvec, query) + 0.3 * ts_rank_cd(text_tsv, query)`，限定 workspace/company/status=ready/deleted_at IS NULL。

## 6. 事实抽取与理解双源

- 新任务 `seller_document.extract_facts`：输出 claims/offerings，evidence 必填（原文片段）、无网络工具、maxCost 25¢、humanGate。
- 证据门：live 文档 + 精确 quote（≥12 字符、命中 chunk）+ contentHash + chunkId；文档删除使关联 Claim 过期。
- 文档 Claim 的 `originKey/factKey` 留空（避免误触 Site bridge 的 `CLAIM_BRIDGE_REQUIRED`）；后续如需跨 run 去重，另建 seller-document bridge。
- 理解工作流：`understanding-dual-source-v1` patch；input 增加 `documentIds?`、`website?`；官网失败但有文档则继续（控制类错误不吞）；请求级 workflowId `understanding-${requestId}`。
- ICP：新增 `icp-context.ts` 组装档案事实、Offering attributes、已批准 Claim、top-8 资料摘录（带出处、标注未审批）；去掉硬性 `NO_APPROVED_CLAIMS`，改为知识充分性门。

## 7. 实现状态与缺口

**已实现**：公司档案/Offering/Claim/Evidence、官网理解、Claim 审批/撤销/冲突；site-builder KB 管线（Docling/BGE-M3/pgvector/lease）。
**缺口**：资料库 API/表/管线（本模块）；文档来源 Claim；ICP 上下文；intake 不发 `CompanyProfileCreated`（P0）；无删除/文档管理端点；卖家事实三处并存。

## 8. 测试与迁移

- 单元：配额/键布局/魔数/lease/重试；证据门（quote 不命中、hash 不符、已删、跨公司/空间）；ICP 上下文。
- 工作流：ingest/recovery；理解双源（仅官网、官网失败+文档、仅文档、无来源）；旧历史 patch 序列。
- 迁移完整性 spec + 真库 RLS（app_user）测试；`docs/governance/app-user-table-privileges.json` 同 PR。
- 迁移前 `pg_dump`；回退=禁用新路由/开关，保留表。
