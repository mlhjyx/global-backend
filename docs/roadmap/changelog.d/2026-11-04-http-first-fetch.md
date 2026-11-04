---
date: 2026-11-04
title: HTTP-first page fetching with readability extraction and env-tunable crawl settings
---

- 起因：抓取层三处浪费（主计划 §3.5b / Q34）——每个页面无条件走 Crawl4AI 浏览器 `/md` 渲染（超时 75s）、渲染请求硬编码 `delay_before_return_html: 3.0`（每页固定等 3 秒）+ `cache_mode: BYPASS`（从不用缓存）、抓取限速与并发写死无 env；独立基准显示无浏览器抽取质量更高（F1 0.955 vs 0.790）且快 24–35 倍。
- 改动：
  - 新增 `adapters/http-first-fetch.ts`：受治理的普通 HTTP 抓取（复用 requestPublicHttp 逐跳 IP 钉扎与 physical-wire 观测）→ readability + linkedom 抽正文 → turndown 转 Markdown；薄页/非 HTML/失败返回 null 触发回落。
  - `crawl4ai.fetch` 工具：先走 HTTP-first（env `HTTP_FIRST_FETCH` 默认 on，仅显式 off 才回纯渲染），40 行渲染路径保留为 fail-safe 兜底；渲染 429 单次重试（`CRAWLER_429_RETRY_DELAY_MS`）。
  - 渲染参数 env 化：`CRAWLER_RENDER_DELAY_MS`（默认 500ms，原硬编码 3000）与 `CRAWLER_CACHE_MODE`（默认 ENABLED，原 BYPASS）。
  - 限速/并发 env 化：`CRAWL4AI_FETCH_RPS`（默认 4）、`CRAWL4AI_FETCH_CONCURRENCY`（默认 6）、`CRAWL4AI_FETCH_DOMAIN_DELAY_MS`（默认 2000）。
  - 新增依赖 `@mozilla/readability`、`linkedom`、`turndown`；Copy 回执重签与漏洞基线重绑随本 PR。
- 测试：新增 http-first/工具分级/参数 env 三组用例（30 用例）；`vitest related` 491 passed；`nest build` 通过。真实效果以 golden mini-run 验收（静态页 p50 ≤0.5s、渲染占比 <30%、同集合召回不降）。
- 未做：ETag/304 与 LLM 抽取缓存（PR-B）；trafilatura sidecar 与自适应域延迟（PR-C）；Crawl4AI 0.9.5 安全升级（独立 PR）。
