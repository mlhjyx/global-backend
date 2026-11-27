---
date: 2026-11-27
pr:
title: Enable compliant trade fairs via generic extraction and route exhibitor PDFs to Docling
---

- 起因：`trade-fair-manifests.ts` 原先硬要求逐站手写 CSS 选择器（`VERIFIED_LIST_SELECTORS`），导致 4 个光伏旗舰展与其余 13 个 `needs_adapter` 展会全部停用；同时线上 `DirectoryDiscoveryProvider` 抓取 `Ausstellerverzeichnis-Solartage-2026.pdf` 等展商 PDF 时，因 `http-first-fetch` 拒收非 HTML 后回落 Crawl4AI 无头浏览器 `/md`，持续触发 `crawler 502`。
- 改动：
  - 完成全部 17 个 `needs_adapter` 展会的逐站 robots.txt / ToS / 公开可读性与平台实测核查：启用 13 个合规展会（含修复 404 路径后的 `intersolar-europe`、`re-plus-north-america`、`intersolar-south-america` 及 `cfia-rennes-2027`、`gulfood-manufacturing-2026` 等，并尊重 `southern-manufacturing-electronics-se27` 的 `Crawl-delay: 10`）；将 CloudFront 403 阻断的 `key-energy-rimini`、阿里云滑块验证码反爬的 `chinaplas-2027`、`robots.txt Disallow: /` 的 `pharmapack-europe-2026` 以及 RX Global WebsiteTC §8 明文禁爬的 `nepcon-japan` / `plastic-japan-osaka` 诚实标为 `blocked`（绝不绕过反爬/验证码，仅保留 L0 搜索引擎公开索引召回）。
  - 将 `trade-fair-manifests.ts` 的 `verifiedAdapter` / 启用门禁收敛为合规审核（`status === 'enabled'` + `robotsPolicy === 'A'` + 明确 `license` / `tosUrl` + 有效 `https` 展商网址），专用 CSS 选择器（`propak-asia-2026`、`fespa-brasil-2027`、`plast-2026`）改为可选提速优化（`extractionMode: 'selector' | 'generic_llm'`）；`channel-crawler.ts` 支持可选的 `extractGenericRecords` 通用回退并在列表页模式剥离个人联系点 PII。
  - `DirectoryDiscoveryProvider` 为匹配的非中文查询直接注入至多 2 个合规已启用展会 `exhibitorUrl` 走 `crawl4ai.fetch` + 翻页（跳过已访问页）+ `discovery.extract_list` 通用抽取，全程继续走 `source_policy` 与 robots 门禁。
  - 新增 `adapters/docling-pdf-fetch.ts` 并在 `http-first-fetch.ts` 与 `tools/builtin-tools.ts`（`crawl4ai.fetch`）打通展商 PDF 专用路径：命中 `.pdf` URL、`application/pdf` 响应头或 `%PDF-` 魔数时经受治理公网 HTTP 下载并交 Docling 解析前 15 页，解析失败或 Docling 不可用时按 `$0` `degraded: true` 诚实降级，绝不再回落 Crawl4AI Chromium `/md` 触发 502。
- 测试：新增 `docling-pdf-fetch.spec.ts`，补齐 `builtin-tools.crawl4ai-http-first.spec.ts`、`trade-fair-catalog.spec.ts`、`trade-fair-manifests.spec.ts`、`channel-crawler.spec.ts`、`directory.provider.spec.ts`、`directory-source-policy.spec.ts` 与 `f11-f15-channels-shared-signals.e2e.ts` 回归用例；通过定向 vitest、`pnpm --filter @global/api build` 及仓内治理门禁。
- 未做：未新增生产库 `source_channel` 数据迁移（线上既有 `source_channel` 种子行需后续按需同步；运行时 `DirectoryDiscoveryProvider` 直接读取更新后的 `TRADE_FAIR_CATALOG` 生效）；未在现网触发完整寻源 run 或合并/发布镜像。
