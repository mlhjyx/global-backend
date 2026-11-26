---
date: 2026-11-26
pr:
title: "fix(discovery,crawler): 修复意大利 P.IVA 页脚与 JSON-LD 税号预捕及 Crawl4AI raw 模式"
---

- 起因：Batch 1.7B 现网验证（`main@660ec261`）发现存量重判编排与收敛均已跑通，但 8 家意大利光伏买家在 Pre-Readability 与 Crawl4AI 阶段出现 3 处上游截断（`footer-contact-capture.ts` 旧正则硬性要求 `IT` 前缀且剥离 `<script>` 丢失 JSON-LD `vatID`、`linkedom` `.textContent` 将 `P.IVA IT02390660039<br /><a>Termini` 粘连破坏 `\b`、`web-crawler.ts` 调用 Crawl4AI `POST /md` 未传 `f: "raw"` 导致默认 `fit` 剪掉 `<footer>`），致使意大利 `P.IVA` 无法到达 `extractEuVat()` 并触发 EU VIES T1 核验。
- 改动：
  1. **单一事实源税号识别与页脚/JSON-LD 预捕修复**：在 `apps/api/src/discovery/website-profile/eu-vat.ts` 新增 `extractAllEuVats` 与 `normalizeEuVatWithHint` 并补全意大利常见 `Codice Fiscale` / `nr.` 标签变体；重构 `apps/api/src/adapters/footer-contact-capture.ts` 移除旧 `VAT_ID_RE` 全面复用 `eu-vat.ts`，修复 `cleanElementText` 在 `<br>` / 块级元素 / `<a>` / 相邻布局 `<span>` 边界插入空格避免粘连，在剥离 `<script>` 前有界安全遍历非 `Person` 节点的 `script[type="application/ld+json"]` 提取合法 `vatID` / `taxID`（零个人 PII），并放行 `extractFooterContactsFromHtml` 快速预判对 `application/ld+json` 的匹配。
  2. **HTTP-first 缓存配方升级**：将 `apps/api/src/adapters/company-navigation.ts` 的 `COMPANY_NAVIGATION_RECIPE` 从 `company-navigation/v1` 升为 `company-navigation/v2`，避免修复前写入 `url_content_cache` 的旧版无税号 Markdown 在 24 小时 TTL 内因 `304 Not Modified` 被回放（保持 `http-first/2` 不变，零数据库迁移）。
  3. **Crawl4AI `/md` 显式 raw 模式**：按本地 `global-crawl4ai:local` 的 `MarkdownRequest` / `FilterType` 契约，在 `apps/api/src/adapters/web-crawler.ts` 的 `crawlUrl` 请求体显式传入 `f: "raw"`（导出 `CRAWL4AI_MD_FILTER_MODE`），避免默认 `fit` 剪枝丢弃 `<footer>`。
  4. **官网画像解析版本升至 `website-profile/v3`**：升级 `WEBSITE_PROFILE_PARSER_VERSION`（`website-profile.provider.ts`）并同步 `icp-rejudge.dto.ts`、`packages/contracts/openapi/openapi.json` 与 `docs/backend/judgment-rejudge-batch.md`，确保存量已标 `v2` 且缺 `vat_id` 的意大利买家在 `POST /api/v1/icps/:icpId/rejudge`（`refreshWebsiteProfile: true`）中自动重抓并收敛。
- 测试：完成 `pnpm --filter @global/api build`、受影响与新增回归单测全绿（15 个套件全绿；全量 `@global/api` Vitest 除本地 Node `22.23.1 < 22.23.4` 触发的 2 个 Astro 渲染器单测外其余 1069 套件 / 15843 用例全绿，`footer-contact-capture.spec.ts` 更新原两处非合法校验和占位号为真实校验和 EU 税号并补齐 `<br /><a>` 粘连、裸 `P.IVA`、JSON-LD `vatID`/`taxID` 与零 PII 防护回归，`web-crawler.spec.ts` 校验 `f: "raw"`），以及 OpenAPI 导出零漂移、Spectral lint、`governance-changelog-fragments`、`governance-document-drift`、`check-file-budgets`、`governance-module-boundaries`、`pnpm docs:verify` 与 `gitleaks` 门禁均通过。
- 未做：本 PR 为零数据库迁移热修代码提交，尚未合并部署到活体容器，也尚未在生产/开发库重新触发 `POST /api/v1/icps/:icpId/rejudge` 复测现网 VIES T1 命中率（待合并发版后执行）。
