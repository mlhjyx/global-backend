---
date: 2026-11-24
title: Harden crawler rate-limit/lease decoupling, charset/decompression, SSRF ports, robots groups, and Chromium probe caching
---

- 起因：生产爬虫与 worker 探针存在 6 类高发稳定性与安全缺口——每域延迟排队占住全局并发租约（且默认租约 30s 短于 45s 浏览器抓取、无最大排队上限、结算后 Redis 释放抖动丢弃已结算结果）；`guarded-http` 未解压 `gzip/deflate/br` 且重定向每跳重置超时、`url-guard` 未限制非 80/443 端口；`http.get` 仅认严格 UTF-8 导致非 UTF-8 海外站点失败；`http-first` 吞掉 `EgressBlockedError` 回落浏览器且跨源重定向不复查 `robots.txt`；`robots.txt` 解析器在 RFC 9309 多 `User-agent` 组下覆盖通配段且缓存无界；runtime 每 10 秒重启 Chromium 探针且心跳无并发互斥。
- 改动：
  - 限流与租约解耦（`tool-broker.ts`、`redis-rate-limit-store.ts`、`durable-result-strategies.json`）：将 `respectDomainDelay` 移到 `limiter.acquire` 之前，结算后 `releaseLimiterSafely` 容错不丢已结算结果，更新 `tool-broker.ts` sha256 钉扎；Redis 并发租约默认从 30s 提至 60s，每域排队等待设置 15s 上限（超限快失败且不污染排队键）。
  - 网络安全与编码解码（`bounded-fetch-response.ts`、`guarded-http.ts`、`url-guard.ts`、`source-tools.ts`、`http-first-fetch.ts`、`builtin-tools.ts`）：新增受限 `gzip/deflate/br` 解压（防压缩炸弹，遵守 `maxBytes`）与跨重定向总墙钟超时；`url-guard` 仅放行默认/80/443 端口；支持 `Content-Type`/`<meta charset>`/`<?xml encoding>` 多字符集解码（保留无声明二进制 `http.get` fail-closed）；`http-first` 与 `crawl4ai.fetch` 不再吞掉 `EgressBlockedError`/动作拒绝错误，跨源重定向在入缓存前复查 `robots.txt`。
  - `robots.txt` 与探针加固（`robots.ts`、`browser-readiness-probe.ts`、`worker-dependency-heartbeat.ts`）：修复 RFC 9309 多 `User-agent` 组解析并将缓存封顶 2,000 条 FIFO；为 `createBrowserReadinessProbe` 增加可选 `cacheTtlMs`（默认 0 保持单测/OCI 冒烟不变，运行时单例 `probeBrowserReadiness` 开启 60s TTL 缓存）；为 `startWorkerDependencyHeartbeat` 周期探针加 `inFlight` 互斥锁防止慢探针重入叠加。
- 测试：新增并全绿运行 `text-charset.spec.ts`、`guarded-http.spec.ts`、`robots.spec.ts`、`http-first-fetch.spec.ts`、`tool-broker.spec.ts`、`redis-rate-limit-store.spec.ts`、`source-tools-http-artifact.spec.ts`、`source-tools-egress.spec.ts`、`builtin-tools.social-fetch.spec.ts`、`browser-readiness-probe.spec.ts`、`browser-readiness-wiring.spec.ts`、`worker-dependency-heartbeat.spec.ts`；`nest build`、`eslint`、G9/G15/G16/G17、`execution-authority-policy`、`docs:verify`、`governance-verify`、`gitleaks` 全绿。
- 未做：不改动宿主机运行中容器（随 Batch 1.1 全部子 PR 合入后统一部署验收）。
