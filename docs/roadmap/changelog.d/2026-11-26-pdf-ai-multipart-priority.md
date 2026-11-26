---
date: 2026-11-26
pr:
title: "feat(seller-knowledge): 支持资料分片断点续传、前15页优先解析与L2/L3 AI产品要点提取"
---

- 起因：大体积印刷级 PDF 画册（30–50MB）在内网穿透或弱网下整文件单次上传易中断，整份送入 Docling 易内存打满导致重启并拖慢数据库事务触发建档 500 报错；同时画册解析后缺少结构化产品回填与扫描件视觉兜底，导致无官网或图文型画册无法快速呈现可选产品。
- 改动：
  1. 在 `SellerDocumentsStorage`、`SellerDocumentsService`、`SellerCompanyDocumentsController` 与 `main.ts` 新增 S3 Multipart 分片上传三接口（`multipart/init`、`parts/:partNumber`、`multipart/complete`，5 MiB 协议分片、单片 6 MiB raw 上限）并在 `presign` 返回 `uploadMode` / `directUploadSupported` / `partSizeBytes`。
  2. 新增纯 JS `pdf-page-utils.ts` 与扩展 `DoclingClient`（支持 `page_range`、`force_ocr`、`include_page_images`、`returnPageCount`），实现大页数 PDF 首阶段前 15 页优先解析立即置 `ready`、阶段二工作流后台按 15 页安全批次补全尾页。
  3. 注册受治理模型任务 `seller_document.analyze`（`seller-document-analyze/v1`）并新增 `seller-document-ai-analyzer.ts`，支持 L2 轻量文本 AI 提取产品（`source: 'seller_document'`，保留人工勾选标记）与字节原句核验要点建议，以及稀疏扫描 PDF 的 OCR + L3 多模态视觉兜底；旧执行预算未开通账户时优雅降级不阻塞文档 `ready`。
  4. 放宽 `onboarding-facts.service.ts` 与 `understanding-preview.service.ts` 的 `withWorkspace` 事务超时至 15 秒；`understanding-preview` 暴露 `documents.items[].parsedMeta` 并过滤未提交的 `pending_upload` 噪声记录。
- 测试：新增并跑通 `pdf-page-utils.spec.ts`、`docling.client.spec.ts`、`seller-document-ai-analyzer.spec.ts`，补全 `seller-documents.{storage,service}.spec.ts`、`seller-document.activities.spec.ts`、`seller-document-ingest.workflow.spec.ts`、`understanding-preview.service.spec.ts` 以及治理脚本验证（`execution-authority-policy`、`governance-workflow-constants`、`docs:verify`、`gitleaks`）。
- 未做：不涉及数据库迁移；`gain-saas` 侧 BFF 分片透传与 `TenantGuard` 软化门禁将在配套 PR 交付，前端全局传输浮窗与工作台启航清单已交由前端架构会话设计落地。
