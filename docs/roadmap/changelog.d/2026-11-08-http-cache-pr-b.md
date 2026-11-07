---
date: 2026-11-08
title: Add the PR-B fetch caches (ETag/304 page cache + content-hash LLM extraction cache)
---

- 起因：主计划 §0.2 步 5 / §3.5b PR-B——重复页面重复抓、重复花 LLM 抽取钱。设计见 `docs/superpowers/plans/2026-11-04-http-cache-pr-b.md`（产品负责人 2026-11-08 批准 D-a~D-f）。
- 改动：
  - 新表 `url_content_cache`（FORCE RLS 租户表）：HTTP-first 路径带 `If-None-Match`/`If-Modified-Since`；304 直接复用缓存 markdown（不读 body、不重做抽取），200 写回 ETag/Last-Modified；24h TTL。
  - 新表 `llm_extraction_cache`（FORCE RLS 租户表）：结构化任务结果缓存，键=workspace + task + 契约/prompt 版本 + 注册模型 + 输入全文 digest + schema digest + reasoning；命中跳过网关调用（不计费、不落 ai_trace）；`ACQ_LLM_CACHE=off` 全关断。
  - 缓存只对任务契约声明 `cacheable: true` 的 8 个抽取/判定任务生效；缓存读写失败一律退化为原行为。
  - 过期清理：写入路径按 workspace 清 + `purge_expired_*_v1`（SECURITY DEFINER，只删过期行）+ worker 启动/每 6h 调度；DSR `eraseSubject` 按 workspace 擦除两表。
  - `crawl4ai.fetch` provenance 新增 `cache: miss | conditional-304`（未启用缓存时不出现）；`URL_CONTENT_CACHE=off` 回退无条件请求。
- 测试：http-first 三态与降级、LLM 缓存命中/键隔离/脏数据/env 关断、维护批量与失败降级单测；app_user 权限矩阵新增两表与跨 workspace/purge 真库用例。
- 未做：平台渠道抓取（workspaceId='platform'）不启用缓存（另立项）；PR-C trafilatura sidecar 按设计降级为观察项。
