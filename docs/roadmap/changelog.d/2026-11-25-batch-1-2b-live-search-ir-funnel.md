---
date: 2026-11-25
pr: 1093
title: "feat(discovery): Batch 1.2-B 实时多引擎搜索工具、IR 四段漏斗与 Pre-Readability 页脚捕获"
---

- 起因：获客 L0 阶段仅依赖自建 SearXNG，海外 B2B 搜索召回与垂直展会/生态覆盖受限；存量候选公司 42.6% 缺失 `country` 导致 L1 规则预筛漏筛；`Readability` 抽取正文前清除 `<footer>`/`<address>`，丢失大量海外官网的职能邮箱、总机电话、公开商务 WhatsApp 与税号线索。
- 改动：
  - 新增受 ToolBroker 与执行权威契约管控的 `serper.search`（过滤 `google.com/goto?url=` 跳转噪声）、`exa.search`（支持语义搜索与 `find_similar` Lookalike）与 `google_places.search`（遵循 D4 §3.2.3 仅在持久回放保留 `placeId`），并同步更新 `durable-result-strategies.json`、`catalog-result-projections.ts`、`domain-ack-consumer-bindings.ts`、`task-registry.ts` 与预算包络（上限 \$574.96 < \$600）；
  - 接入多引擎 L0 融合检索（`public-web.provider.ts` / `model-web-search.provider.ts` / `directory.provider.ts`，无 key 时零成本诚实降级），新增 20 场全球展会目录种子（16 场归档真实展会 + 4 场光伏/储能旗舰展）、竞品替换与互补生态狙击器、CWE-1236 安全的客户种子 CSV 解析与光伏 Tier-1 品牌词典；
  - 新增 L1 确定性预推断模块 `prefilter-country.ts` 并接入 `quick-scan.ts`（按权威列 → GLEIF/VAT → 单国 ccTLD 排除 `.ai/.io/.co` → 单国法定后缀 → 单国国际区号推断国家）；
  - 新增 `footer-contact-capture.ts` 在 Readability 前捕获 `<footer>`/`<address>` 内的同域职能邮箱、电话、显式公开 `wa.me`、税号与供应商入口，并同步接入 `http-first-fetch.ts`、`contact-extractor.ts` 与 `collect-company-channels.ts`（零个人邮箱泄漏、无信号页面零哈希扰动）。
- 测试：新增并全量通过 `search-providers.spec.ts`、`search-provider-tools.spec.ts`、`trade-fair-catalog.spec.ts`、`ecosystem-sniper.spec.ts`、`prefilter-country.spec.ts`、`footer-contact-capture.spec.ts` 及全部 ToolBroker / 投影 / 预算包络 / 执行权威策略 / 发现回归套件，通过 `nest build`、`G9/G15/G16/G17`、`docs:verify`、`lint`、`benchmark:discovery` 与 `gitleaks`。
- 未做：S2 PDF 辅助 Claim 抽取与 `document-claim-basis.ts` N+1 修复（归入下一个原子 PR 1.2-C）；宿主机线上 env 迁移与镜像发布留待 Batch 1.2 代码合并后统一执行。
