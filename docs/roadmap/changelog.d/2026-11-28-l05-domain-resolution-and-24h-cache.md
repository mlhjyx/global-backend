---
date: 2026-11-28
pr:
title: "feat(discovery): 补齐 L0.5 缺域补官网、L1→L2 共享页面缓存直出与 API 容器健康检查"
---

- 起因：现网流式寻源中 137 家来自名录/工商注册的候选企业缺少 `domain`，L1 直接跳过抓官网导致 89.9% 的 `weak` 线索停在 61 分；L1 抓完首页与联系页后未写入 `url_content_cache`，且 `http-first-fetch` 对无 ETag 站点仍反复出网/触发渲染；`global-api` 容器缺少 Docker Healthcheck。
- 改动：新增 `domain-resolver.ts` 在 L1 前对 `domain IS NULL` 企业优先从属性或免费自托管 `searxng.search` 解析官网并防唯一冲突落库；`url_content_cache` 返回 `fetchedAt`，`http-first-fetch` 对 6 小时内新鲜缓存直接复用（免重走外网/渲染），L1 `raw-http-extractor` 抓取成功后主动预热 `url_content_cache` 供 L2 复用；`infra/backend-runtime.compose.yml` 为 `api` 补齐 `/api/v1/health/live` 健康检查。
- 测试：新增 `domain-resolver.spec.ts`、扩展 `url-content-cache.spec.ts` 与 `http-first-fetch.spec.ts`，运行 streaming/adapters/deployment 合同单测、构建、文件预算、模块边界、文档漂移与 `gitleaks` 全绿。
- 未做：待随本批次镜像统一发布后在真实寻源中核验缺域补齐率、L2 耗时下降与 `global-api` 容器 `healthy` 状态。
