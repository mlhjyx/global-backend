---
date: 2026-11-04
pr:
title: Add the Run 2.0 quick-scan stage (pool-first prefilter, batched quick judgment, provisional leads)
---

- 起因：完整设计（2026-11-04）把寻源 run 拆成快扫/深挖两档；快扫要用公司池先出名单（≤8 分钟），只有池子不够才搜索兜底（R3/R4）。
- 改动：
  - 新活动 `prefilterPool`（规则预筛，写 `discovery_company_job`）、`quickJudgeBatch`（8 家/次 flash 粗判，解析失败逐家降级，模型不可用规则兜底出 weak，Q20）、`materializeProvisionalLeads`（幂等 upsert，queue=needs_review，fitReasons.source=quick_scan）；进度写 `run_event`（seq 单调、并发撞号重试）。
  - `discoveryWorkflow` 增加 `discovery-run2-quick-scan-v1` patch + 启动参数 `run2QuickScan`：候选 ≥20 家时跳过整轮搜索，否则跑一次有界搜索再预筛；结束直接 finalize（空池 PARTIAL、全部失败 FAILED）。
  - relay 按部署开关 `DISCOVERY_RUN2_QUICK_SCAN`（默认关）写入启动参数；旧历史无该字段 → 原编排不变。
- 测试：预筛/批量解析/降级/兜底/幂等物化单测，seq 并发重试单测，工作流编排单测（快路径/搜索兜底/开关关闭/全失败）；全量 API 单测通过。
- 未做：真默认开启（等 M0④ 深挖与 M0⑥ 影子两轮召回不降）；与 taskRef 的联动只在 M0② 的输入字段上。
