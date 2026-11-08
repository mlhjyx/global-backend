---
date: 2026-11-09
title: Two-phase channel run accounting preserves fetched pages on failure and adds PARTIAL status
---

- 起因：v3.0 第 6 章 CH-6 / CP-G7——渠道运行失败或取消时 workflow 拿不到 activity 的中间结果，`source_channel_run.pages_fetched` 一律落 0：日页帽被失败 run 系统性低估，首页失败之外的坏轮无法如实归因。
- 改动：
  - 迁移 `20261109140000_channel_run_dimensions`：`source_channel_run` 增加两段式落账与运行维度列（mode/manifest_sha256/plan_digest/requests/bytes_fetched/http_4xx/http_5xx/http_429/duration_ms/circuit_state/operator_note），status 词表加入 `PARTIAL`；历史 10 行 1 页试跑回填 `mode='preview'`。
  - `runChannelCrawl` 开始即写 RUNNING 行（crawl_run_id 幂等），逐页用 `GREATEST` 单调更新 `pages_fetched`/`requests`（进度写失败不阻断抓取）。
  - `finalizeChannelCrawl` 的 FAILED/取消分支以 RUNNING 行已记录的实际页数为准（不再写 0）；成功分支回填 mode/requests/duration 维度。
  - `PARTIAL` 语义：被页帽/日配额截断但已有产出时落 PARTIAL——不计失败率坏轮、按成功信号清零失败连击并刷新 last_success_at；recorder 的 finalize 重放判定改为「既有行非 RUNNING 才算重放」，两段式行首次收敛仍正常推进 streak。
- 测试：活动级（RUNNING 行、逐页进度、失败保留页数、PARTIAL 结局）、workflow（PARTIAL 透传）、recorder（RUNNING 非重放、PARTIAL 非坏轮+成功信号）、迁移静态契约与 schema 同步；一次性库重放 + Prisma drift 门见 PR。
- 未做：`bytes_fetched`/`http_4xx/5xx/429`/`circuit_state` 列已建但本波 crawl 路径无数据源（留给 api 渠道执行链 CH-5 回填）；未部署。
