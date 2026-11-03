---
date: 2026-11-03
title: Ingest seller documents through Docling, chunking and BGE-M3 embeddings; add hybrid search
---

- 起因：资料库 API（#749）提交后文档停在 queued；需要把「上传→解析→可检索」闭环，替换占位 launcher。
- 改动：
  - 新 Temporal 工作流 `sellerDocumentIngestWorkflow` + `createSellerDocumentActivities`：fenced 租约认领 → 有界下载 → Docling 解析（文本类直读）→ `chunkMarkdown` 结构感知分块（上限 512 块）→ BGE-M3 批量嵌入（32/批）→ 事务写 `seller_document_chunk`（含 `::vector` 字面量与生成列 tsv）→ 置 `ready`；失败按 attempt 指数退避（60s→1h，最多 8 次）回 `queued`，超过即 `failed_terminal`；finalize 以 lease 令牌围栏，不覆盖新持有者。
  - `TemporalSellerDocumentsIngestLauncher` 替换占位实现，workflowId 绑定 documentId；worker 注册新 activities 与工作流导出（`customer-workflows.ts`）。
  - 混合检索 `GET /companies/:companyId/seller-documents/search`：查询词本机嵌入后 `0.7×cosine + 0.3×ts_rank_cd`，限定公司/ready/未删，limit ≤50；附带接口门户说明。
- 测试：activities 规格 6 例（成功/下载失败/空内容/嵌入失败/not_due/gone/丢租约）；workflow 编排规格 2 例；service 规格补混合检索 2 例。
- 未做：软删对象的物理清理（canonical 对象与 chunk 行）留受控清理管线（Phase 6 DSR）；extract_facts 事实抽取（Phase 3）将按其模型 op 引入 Grant。
