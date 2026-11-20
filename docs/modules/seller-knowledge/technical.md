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

本增量依据 `B1-MARKET-CANDIDATE-PERSISTENCE` revision 2 的批准范围（原业务语义不变，仅追加一条 forward 完整性修正迁移），绑定产品 v0.2（SHA256 `51977c60f9538099a8c4eb3657d7dffd5eb07751075b821475048b27e16b5f09`）与技术施工单（`a79996375f070e80cf6124e7fceda8e30085ccf84a51c57f567c52ab2e9704ab`）。本节说明新增源码，不改写上文历史设计状态，也不依赖私有审批文件运行。

初始存储在持有公司锁时不等待 Claim 子锁，采用 `NOWAIT`，仅对 SQLSTATE `55P03` 的已回滚存储事务最多重试三次；耗尽给受控409，其它错误不吞。文档写入前在原租户事务中精确预检 `octet_length(value::jsonb::text)`，避免 canonical 字节帽以内的输入撞数据库表示帽而返回500；文档哈希仍按原 canonical 算法。增量 deferred guard 对每条新增 head/revision/feedback 事件作唯一键定点检查，仅在 feedback 分支展开该条前后两版，不全历史 count/max 或重复解析不可变旧正文；旧迁移字节、FK/唯一约束、单步指针、RLS/ACL及原删除/cascade语义保持。

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


## 10. 受控市场候选生成（B2，源码边界）

本增量只闭合 backend 单仓源码与合成隔离验证，不改上文 B1 纯存储自身的职责，不以代码或测试冒部署、真实市场效果或 SaaS 签发接线。B3 页面/薄投影和 B4 找买家不在本增量。

- 普通用户接口：公司下 `POST market-candidate-generations` 准备明确意图；`POST market-candidate-generations/:generationId/execute` 受精确授权执行；`GET market-candidate-generations/:generationId` 纯持久读；`POST .../recover` 只恢复原结果与保存。prepare/execute/recover 需 `acquisition:write`，GET 需 `acquisition:read`；执行/恢复还限定原请求者。全局写准入不豁免 recover；UUID、quote 和客户端摘要均不是授权。
- 意图使用 workspace/company/requestedBy/intentId 幂等，同体重放、异体409；不可变意图摘要绑定完整材料、选用字段摘要、合同/模板/schema/model-policy 与 B1 当前集合/修订 anchor。三张控制表只保存元数据、单调最新意图与追加账户身份，不复制原始输入、结果、文档、联系方式或用户反馈；租户 RLS、复合 FK、不可变列与最小列 UPDATE 在数据库执行。
- 实际输入是完整 canonical `inputMaterial/v1`，包含 CompanyProfile 已选结构化字段、完整 Offering attributes 和已审批、未过期 Claim 已选字段。去重后来源合计最多200，完整 UTF-8 包装最多262144字节，不截断、摘要替正文或静默 take；显式选中失效项拒绝。CompanyProfile.version 与 Offering 所用字段 hash 独立，声明市场只作卖方偏好。
- `market.candidates.generate` 仅 `WORKSPACE_GRANT/market_candidate_generation`，quote 绑定 generationId 与不可变 intentDigest。沿既有模型 selector，allowedTools 为空、无 cacheable、单任务40美分、输出最多16000 token、180秒超时；既有结构化修复倍率2计入完整逻辑80美分总帽，所有 attempts/accounts 共用该上界。新账户只沿原过期容忍、全部 neverDispatched 与先关闭旧账的安全协议；SETTLED/UNKNOWN/不明预留不能借新意图或账户重买。
- 256 KiB 材料不保证能放入模型上下文：共享结构化 runtime 的纯准备函数同时用于 Grant 前预检与实际执行，完整 required policy/schema/request 包装及转义、输出/推理 reserve 都计入原窗口，不能丢段或放宽旧预算。冻结指纹在入场重建后复核；事务外才 await 原 granted-model/runtime/Router，无第二套 provider 或预算协议。
- 输出闭合为候选假设或合法完成空结果，最多100卡、完整序列化最多65536字节；条件、反证、未知及独立空国家保留。模型不能写权威事实、稳定 ID、actor、版本或反馈，坏卡/伪来源全拒，不过滤凑空成功。旧通用119 KiB typed、128 KiB PG JSONB、4096字段及深度等容量门不变，局部最大值不表示其笛卡尔积合法。
- 入场先执行既有 authority/account 锁协议，随后 company、generation head/row 与排序来源；Claim 沿 B1 `FOR SHARE NOWAIT`。预检、入场、应用只对55P03整事务最多三次，ACK 外层回滚而非只重试 B1 内句。初始 B1 存储提取调用方 tx core，旧入口保留原包裹/重试、哈希与 JSONB 精确字节门。
- 精确消费绑定 `MarketCandidateGenerationService.apply / MarketCandidateGeneration`，key 为 generationId、消费版本为1。B1 set/revision、generation PERSISTED 与可信 ACK 必须同事务。确定被新意图/反馈 anchor 或来源改变拒绝时，合法 NOT_APPLIED 与 ACK 同事务、set_id 必空；真正存储/控制面失败不是丢弃，原 SETTLED 留 RESULT_READY/SAVE_PENDING。已准入在途调用遇公司软删仅可在原内部消费上下文完成拒绝审计，对外仍404，不复活/暴露资料。
- 恢复只按原 scope/authority/account/generation/operation/schema 读账；复用唯一 receipt validator 与完整 project/restore/reproject 校验，不 open/reserve/attest 续权或调用模型。终态先读域决定，不依赖投影正文；PERSISTED 再做 B1 初始修订权威冷读，NOT_APPLIED 永无可用集合。ACK REPLAYED 的 value 为空，必须核既有匹配终态；孤立 ACK、错误元组或缺投影不能造成功。ACK 不表示 typed 投影已物理擦除，本增量不加 purge/reaper 或旧账本 DML 权限。
- 验证是显式自建 loopback `global_test`、真实非 superuser/non-BYPASSRLS app_user 与合成 provider，通过原 Router、预算函数、ACK 和域表执行。覆盖并发、来源/反馈竞争、完整回滚、闭账/过期恢复、账户族总帽、UNKNOWN 不重发及真实普通用户/全局准入 HTTP。原模型与工程研究工具分离，本包不运行真实模型、embedding、搜索、抓取、发送、迁移业务库或部署，不声称真实市场判断或转化已验收。
