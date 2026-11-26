---
date: 2026-11-26
pr:
title: "feat(seller-knowledge): 文档解析就绪后自动抽取原句核验要点草稿并增强批嵌入与工作流退避重试"
---

- 起因：现网上传 40MB 级企业 PDF 画册后存在三个断点：(1) Docling 解析置 `ready` 后未自动触发已实现的 S2 确定性原句核验要点抽取，导致建档第 2 步 `understanding-preview.documents.extractedClaims` 为空、用户看不到画册提取结果；(2) `EMBED_BATCH` 固定 32 段在 CPU 本机 `bge-m3` 下单批易超 2 分钟触发 `DOCUMENT_EMBEDDING_UNAVAILABLE`；(3) `sellerDocumentIngestWorkflow` 遇到瞬态失败回 `queued` 后直接结束，没有在工作流内按退避窗口自动重跑。
- 改动：
  1. 在 `apps/api/src/seller-knowledge/seller-document.activities.ts` 将默认嵌入批大小从 32 降至 8（支持 `SELLER_DOCUMENTS_EMBED_BATCH` 1–32 覆盖），在解析各关键阶段同步刷新 `processing_stage` 与租约，并在事务发布 `ready` 后尽力调用 `SellerDocumentClaimsService.createAssistedDrafts`（零模型费用、严格 UTF-8 字节原句定位、仅生成 `NEEDS_REVIEW` 草稿且异常不回滚 `ready`）；`fail()` 返回 `retryAfterSeconds`。
  2. 在 `apps/api/src/seller-knowledge/seller-document-ingest.workflow.ts` 通过 `patched('seller-document-queued-retry-v1')` 版本闸在 `outcome === 'queued'` 时按 `retryAfterSeconds` 休眠自动重试（最多 3 次），保持旧历史 replay 确定性。
  3. 在 `apps/api/src/temporal/worker.ts` 注入 `SellerDocumentClaimsService` 到 `createSellerDocumentActivities`。
  4. 在 `seller-document.activities.spec.ts` 与 `seller-document-ingest.workflow.spec.ts` 补齐自动要点抽取、异常兜底、退避重试与 `patched=false` replay 单测。
- 测试：`pnpm --filter @global/api build`、`seller-document.activities.spec.ts`、`seller-document-ingest.workflow.spec.ts`、`seller-document-claim-extractor.spec.ts`、`governance-changelog-fragments`、`governance-document-drift.spec.mjs`、`pnpm docs:verify` 与 `gitleaks` 全绿。
- 未做：不改数据库表结构与 HTTP 路由，暂未接入大模型文本/视觉二次抽取（待产品确认后单开 PR）。
