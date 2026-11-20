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

## 9. 市场候选持久化边界（B1）

本增量依据 `B1-MARKET-CANDIDATE-PERSISTENCE` revision 1 的批准范围，绑定产品 v0.2（SHA256 `51977c60f9538099a8c4eb3657d7dffd5eb07751075b821475048b27e16b5f09`）与技术施工单（`a79996375f070e80cf6124e7fceda8e30085ccf84a51c57f567c52ab2e9704ab`）。本节说明新增源码，不改写上文历史设计状态，也不依赖私有审批文件运行。

- 引擎唯一主存：`market_candidate_set` 仅保头指针/初始操作幂等身份；`market_candidate_set_revision` 保不可变 `MarketCandidateSetV1`；`market_candidate_feedback` 只追加 before/after 用户覆盖层。CompanyProfile/Offering/Claim/Evidence 不被候选或反馈反向覆盖。稳定候选 UUID 与集合 revision 分开，同国不同应用/采购组织角色互不合并；组织国、项目国各自可空。
- 文档校验与 DTO 位于 `apps/api/src/market-candidates/`；原 proposal、双边冲突/反证、资料事实/卖方声明/推断/未知与用户 corrections 分层。确认不升级事实核验等级；纠正必须有实质内容变化，保 ID/旧版并标 `needsReassessment=true`、`impactScope=UNKNOWN`，不自动重评估其他卡。每次独立四反馈形成集合新修订，原文理由保留，缺省/null/空白理由记 null。
- 事务使用真实 `app_user` + `withWorkspace` + transaction-local `set_config` + FORCE RLS。先锁公司、再锁集合；先查已提交幂等意图，再核最新集合及 expectedRevision CAS。同 key 同意图（含丢响应后的旧修订重试）返回原 recordedRevision；同 key 异意图或独立旧版本竞争返回409，三表任一失败全部回滚。数据库复合 FK、延迟完整性约束与单步指针触发器保证不能留下孤立修订或半条反馈；历史行对 app_user 无 UPDATE/DELETE/TRUNCATE 权限。
- 依据快照只保存版本化引用、规范摘要和受控定位：CompanyProfile.version；Offering 所用字段 digest（不虚构 Offering.version）；Claim.version/status/digest；Evidence 的源内容 hash/摘录位置；SellerDocument.contentHash；chunk 的文档 hash、原稳定 ID、seq、原始 UTF-8 文本 digest。缺值明确 unknown/null，不复制 PDF、chunk 全文、对象 key、签名下载 URL 或联系方式。可变来源按稳定顺序锁取，append-only Evidence 在已锁 Claim 下读取，不新增其 UPDATE 权限。
- documentHash 只绑定不可变文档；逐次计算的 `basisAvailability` 独立标 CURRENT/CHANGED/UNAVAILABLE/UNKNOWN。来源删改、Claim 撤销/到期、文档重解析或 chunk 重建均不回挂到同 seq 新内容；幂等重放也重算可用性，不缓存旧下载链接。公司软删或跨租户时 current/history/detail/feedback 均404。普通软删与法定物理擦除分层，本包没有新增原文副本或另建擦除系统。
- 生成合同仅来自 code-first：`MarketCandidateSetsController_getLatest_v1`、`getCurrent_v1`、`listRevisions_v1`、`getRevision_v1`、`recordFeedback_v1`（后四项同控制器前缀）。GET 需 acquisition:read，反馈需 acquisition:review 并继承全局写入准入；小写 idempotency-key 必填 UUID。历史摘要默认20、最多100、修订游标降序，不无界加载所有正文；未知/深层额外字段400拒绝，不静默裁剪。
- 初始 `persistInitial` 仅是内部存储 port，operationIdentity 只作持久幂等身份，不能证明生成授权；产品 composition root 没有 producer 或初始 HTTP/导入/fixture 入口。生产无文档返回 NOT_ANALYZED，仅指本能力无可读文档；合法内部完成空结果为 AVAILABLE + COMPLETED_EMPTY。读/反馈均零模型、embedding、搜索、抓取、Grant、激活、计划、run、发送、Outbox/Temporal。
- 验证入口：本域 document/service/controller/OpenAPI/module suites 与显式 CI opt-in 的 `market-candidate-sets.postgres.spec.ts`；一次性 loopback 数据库必须同时提供 owner/app_user URL，拒绝 global_dev、URL 覆盖参数与缺失配对。owner 只建/清合成 fixture；RLS、不可变、幂等并发、回滚、冷读与删源实际以 app_user 执行。
- 容量是资源护栏，不是质量分或业务最低卡数：最多100卡、200来源引用，短文本/理由2000字符，canonical UTF-8 文档最多256 KiB；数据库对 JSONB 文本另有256 KiB保守存储限额。无排名、业务评分/权重或转化阈值。
- 后继：B2 单独闭合授权/预算、真实 producer、模型合同/receipt/ACK 与生成状态；B3 从确知版本导出合同生成 SaaS pin/薄投影与反馈页面，409保留未提交输入；B4 另起带候选身份/版本的找买家操作。反馈不替代执行授权。本包未部署、无真实市场生成、SaaS 页面或商业效果验收；回退为撤回本模块接线/接口，保留追加历史，不通过回退源码抹掉资料或反馈。
