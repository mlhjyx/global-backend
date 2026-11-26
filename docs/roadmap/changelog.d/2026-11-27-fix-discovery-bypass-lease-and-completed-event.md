---
date: 2026-11-27
pr:
title: "fix(discovery): 修复旧预算旁路模式寻源租约报错及流式收尾漏发完成事件"
---

- 起因：流式寻源在旧预算旁路模式下仍读取 `execution_budget_authority`，由此在搜索企业阶段触发 `EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE`。流式收尾只更新引擎终态，缺少 SaaS 用来同步任务终态的 `DiscoveryRunCompleted`，任务详情无法显示重试入口。
- 改动：
  - 旁路模式下活动读取租约时取得有限的 3 小时时间窗，省去旧表查询。整个工作流沿用 215 分钟硬超时。默认和受控模式继续按 workspace、授权 ID 和数据库时钟校验租约。
  - 流式收尾锁定 run 行，在同一事务里写入终态和 `DiscoveryRunCompleted`，重试复用已落库事件。事件按账本账户键汇总成本，附带可选的 `taskRef`，排除 `queryDiagnostics`。匹配数按已落库的公司判定去重汇总。
- 测试：覆盖旁路和受控租约、四种流式终态、重复收尾、方案状态、成本归属、任务引用和去重后的匹配数。
- 未做：历史卡单对账、生产发布和真实寻源验收。SaaS 启动响应晚于完成事件时覆盖终态的问题待单独处理。
