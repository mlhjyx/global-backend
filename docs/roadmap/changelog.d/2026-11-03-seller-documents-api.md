---
date: 2026-11-03
title: Add the seller document library API with presigned upload, commit validation and quota
---

- 起因：资料库表已就位（#747），但没有上传/管理入口；Phase 2 需要 presign/commit/列表/下载/重试/软删，并保证 bucket 先于代码上线。
- 改动：
  - 新增 \`SellerKnowledgeModule\`（模块 02）与 7 个端点：\`POST /companies/:id/seller-documents/presign\`、\`POST …/:documentId/commit\`、\`GET /companies/:id/seller-documents\`、\`GET /seller-documents/:id\`、\`GET /seller-documents/:id/download-url\`、\`POST /seller-documents/:id/retry\`、\`DELETE /seller-documents/:id\`。scope：写 = \`acquisition:write\`，读 = \`acquisition:read\`，删除 = \`acquisition:review\`。
  - 独立 bucket 客户端 \`SellerDocumentsStorage\`（\`SELLER_DOCUMENTS_S3_BUCKET\`，默认 \`global-seller-documents\`）：presigned PUT 带 1 天过期的 staging 生命周期 tag；canonical 换空 tag 永不自动过期。
  - commit：CAS 认领（attempt + 租约）→ HEAD/流式 sha256/魔数（复用 site-builder 嗅探）→ canonical 转存 → queued 并入队 ingest；同公司活跃内容重复撞部分唯一索引返回 409 并清理副本；未上传完成回到 pending_upload。
  - 配额：每空间 500 份/2 GiB、每公司 200 份（env 可调），presign 时 409。
  - 部署：\`docker-compose\` 与 \`infra/minio/bootstrap.sh\` 增加资料库 bucket 与生命周期断言；\`runtime-deployment-contract\` 规格同步。
- 测试：service 规格 8 例（类型/配额/成功/魔数/重复/未完成/软删）；OpenAPI 由 code-first 导出。
- 未做：ingest 工作流（2b，本块的 launcher 为占位，文档停在 queued）；混合检索端点（2b）；commit 暂不要求 Execution Budget Grant——docling/embeddings 为自托管零成本，Phase 3 的 \`extract_facts\` 模型调用再按其自身 op 引入 Grant。
