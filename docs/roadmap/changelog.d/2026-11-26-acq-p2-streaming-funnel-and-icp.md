---
date: 2026-11-26
pr:
title: Phase 2A Plan B streaming discovery funnel, three-layer ICP decoupling, multimodal cold-start, and Comtrade market recommendations
---

- 起因：Phase 1 止血合入后，获客链路仍存在四大结构性瓶颈：单公司多活动重复抓取与高昂 Crawl4AI 占比、ICP 中卖方工艺参数与买家要求混写导致误杀及德国工业泵场景硬编码、1 公司仅能单活一个 ICP、无官网卖家冷启动缺少 1688/阿里国际站店铺与产品描述/画册统一预览及 UN Comtrade 选国推荐。
- 改动：
  1. 新增方案 B Raw HTTP 优先单活动抽取器（`apps/api/src/discovery/streaming/raw-html-parser.ts`、`raw-http-extractor.ts`），吸收实测三条铁律（DOM 去噪可见正文 `<200` 字才回落 Crawl4AI、`ERR_TLS_CERT_ALTNAME_INVALID`/`UND_ERR_SOCKET` 自动 `www.` 重试一次、URL+正文双层 PDF 护栏），全量出网严格经 `ExecutionBroker.invoke('http.get' | 'crawl4ai.render')`。
  2. 新增 `discoveryStreamingWorkflow`（零历史 `patched()` 债务，由 `DISCOVERY_STREAMING_WORKFLOW=on` 门控路由）、`discovery.streaming.activities.ts`、统一两层买家准入 `fit-v3`（含 `"Ordina ora"` 等常规商业 CTA 防 R0 误报，复用既有 `discovery.qualify_fit` 契约）以及只读进度端点 `GET /api/v1/discovery-runs/:runId/streaming-progress`，L0 先落 `canonical_company` 满足 `SUBJECT_BINDING_HOLD`，取消/中断在 `CancellationScope.nonCancellable` 内保存部分结果并触发 `QualifyRequested`。
  3. 落地三层画像解耦（`seller_profile` / `buyer_spec` / `peer_exclusions`）、1 公司多 ICP 生成与并行激活（`keepExistingActive`）以及全行业/全市场泛化的 `buyer-procurement-scenarios.ts`。
  4. 新增卖家专属 1688 / 阿里国际站店铺 URL 白名单（严格隔离买家 `NOISE_DOMAINS`）、`productDescription` 冷启动与待审 Claim 草稿、`UnderstandingPreview` 溯源隔离的 PDF 画册/事实汇总，以及只读 `GET /api/v1/companies/:companyId/market-recommendations`（UN Comtrade HS 贸易流推荐，`isRecommendationOnly: true`）。
- 测试：新增并跑通 Raw HTTP 抽取、fit-v3、流式工作流与活动、三层 ICP、卖家白名单、多模态冷启动与 Comtrade 推荐等单测，同步回归 `icp.service.spec.ts`、`company.service.spec.ts`、`outbox-routing.spec.ts`、`buyer-procurement-scenarios.spec.ts`，完成 `@global/api build`、`openapi.json` 重导与全套治理门禁（G9 / execution-authority / copy-fixed-source / docs:verify / governance:verify / code-intelligence:check / gitleaks）。
- 未做：未修改 `schema.prisma` 与 4 个 SHA-256 锁定核心文件，未触碰 Track 2B 专属安全/预算/运行时模块；当前仅单测与本地治理快门通过，尚未部署上线或在线上环境开启 `DISCOVERY_STREAMING_WORKFLOW=on` 灰度验收。
