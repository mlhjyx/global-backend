---
date: 2026-10-19
title: Wait minutes, not seconds, before retrying a discovery query or fit pass the model upstream could not answer
---

- 起因：RL1 验收 run `097593b7`（xin，2026-10-19 11:33–12:03 UTC）跑完 14 条查询中的 9 条，已接受 45 条原始记录。12:03 openox 先回 521、再回 523，约 28 分钟后恢复。public_web 挖一个域名时模型调用失败，executeQuery 的 3 次尝试按默认退避（1 秒、2 秒）全部挤在 6 秒内（12:03:19 → :21 → :25），run 按 #653 判 `FAILED`，停在 query。物化没跑，45 条记录产出 0 家公司、0 条线索。预算账本早已按 D13 把每次失败的预留释放，所以等待本来不花钱，只是没人等。
- 改动：
  - 新增 `apps/api/src/temporal/upstream-unavailable-retry.ts`：对 `definiteModelFailureCode` 判定的确定失败（网关 429、除 504/524 以外的 5xx、连接没建立），活动抛出时带 `nextRetryDelay` 的可重试 `ApplicationFailure`。第 2 次尝试前等 5 分钟，第 3 次前等 25 分钟，合计约 30 分钟，远在发现 run 3 小时准入租约之内。其余错误原样抛出（504/524 超时、4xx、截断流、控制错误、无法重放的操作），不改变它们今天的行为。
  - `discovery.activities.ts` 的两处重抛（executeQuery 的数据源控制错误、qualifyFitForRun 停止 fit 的错误）改用它。尝试次数仍是 3（等于账本对同一操作键的预留上限），workflow 与重试策略都没改，重放不受影响。#653 的停止语义不变：超过约半小时的故障照旧以 `FAILED` 停在当时的阶段。
  - `packages/contracts/INTEGRATION.md`：run 状态补上 `FAILED`；写明模型上游不可用会让整条查询失败（不是只跳过那个域名），以及新的等待间隔；更正「计划保持 READY 可以重跑」——同一计划再执行会得到 409 `EXECUTION_BUDGET_GRANT_REUSED`（xin 2026-10-19 实测）。
- 测试：新增 `upstream-unavailable-retry.spec.ts`（22 例）：7 种确定失败都转成带等待的可重试失败，8 种其他错误原样返回；入参不被修改；仓库失败转换器序列化后保留 `nextRetryDelay`（300 秒）且其余字段与不加等待时相同；用尽尝试后 `describeDiscoveryRunFailure` 仍是 `{stage:'query', errorType:'ProviderHttpError', control:false}`；executeQuery 与 qualifyFitForRun 的重试次数等于 `durable-result-strategies.json` 的 `maxReservationAttempts`，总等待 30 分钟。`discovery.activities.spec.ts` 加 4 例（executeQuery 遇 521、fit 遇 523 抛带等待的失败；504、401 仍原样立即失败）。先 RED 后 GREEN。
- 未做：
  - 没有改成「一条查询失败时 run 判 PARTIAL、物化已成功查询的记录」：这要动物化准入「每条计划查询一份回执」的完整性不变量（#653 的理由），是另一件需要产品负责人拍板的事。
  - 扛不过数小时以上的上游故障：那要靠备用上游（PRD4-D14）。
  - 合并后要在 dev Temporal 上实测服务端按 `nextRetryDelay` 排下一次尝试（不被默认 `maximumInterval` 100 秒截断），并在下次换镜像后观察。
