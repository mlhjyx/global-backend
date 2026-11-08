# B5 落地设计 · 活动心跳 / 取消传播 / 超时对齐（2026-11-08）

> 生命周期：`APPROVED`
> 生命周期依据：交接总纲 WP B5（产品负责人 2026-11-08 批准 Phase 1 顺序）与协调计划 §0.7-H 审计 PERF-02。

## 1. 问题（审计 PERF-02）

- understanding 的模型活动 `startToCloseTimeout=3 分钟` < 网关自身的模型请求上限
  `MAX_MODEL_GATEWAY_REQUEST_TIMEOUT_MS=300s`：活动先超时、HTTP 请求仍在后台跑；Temporal 重试
  会再发一次付费调用（B2 之后重试会撞 remnant 快速失败，但首次白花钱）。
- 模型/抓取活动没有心跳：worker 进程死掉后要等整段 startToCloseTimeout 才被发现。
- 活动取消不会传播到模型 HTTP 请求：RequestCancel/超时后请求继续跑。

## 2. 改动

1. **超时对齐**（`understanding.workflow.ts`）：模型活动 3m→**6m**（300s 上限 + 1m 余量）；
   抓取活动 3m→**5m**（并发多页 × 60s 抓取上限 + 渲染/排队）。
2. **心跳**：模型/抓取活动加 `heartbeatTimeout: '2 minutes'`；`understanding.activities.ts` 的
   长活动（crawlPages / extractClaims / extractOfferings）包 `withActivityHeartbeat(30s)`
   周期上报。worker 死亡 → 2 分钟内被 Temporal 发现并重试，不再等满 startToClose。
3. **取消传播（AbortSignal 贯通）**：`activityCancellationSignal()`（非活动环境返回 undefined，
   单测安全）取 `Context.current().cancellationSignal`，传入两个抽取活动的网关调用
   （`GenerateStructuredInput.signal` 本就支持）；网关/传输层把 signal 传进 HTTP 请求。
4. **不重复付费**：超时重试撞上一条 RESERVED 时，B2 的 remnant 分类让它**只尝试一次**即失败终态
   （而非再发一次付费调用）——本 PR 与 B2 组合覆盖该场景，并在设计/变更记录中明示。

## 3. 非目标 / 后续

- ToolBroker 的 `ToolContext` 没有 signal 字段；把取消信号贯通到全部工具（抓取/搜索/SMTP）
  需要给上下文加字段并逐个适配器接线，超出本 WP，登记为后续小步（B12 PERF 群一并评估）。
- 其余 workflow 的活动时限是否都 ≥ 底层超时：本 PR 修 understanding（审计点名的 PERF-02）；
  新增源文本断言钉住「模型活动 ≥ 6 分钟 + 心跳 + signal 传入」，防止回退。

## 4. 测试

- 源文本断言 3 例（超时/心跳常量、signal 传入两处、心跳包装 ≥3 处）——运行期看不见的契约。
- 既有 understanding workflow/activities spec 全绿（心跳与 signal 在单测环境为 no-op）。
- 部署后可选观测：活动 heartbeat 计数、RequestCancel 后网关请求 abort 的日志。

## 5. 回退

纯代码；回退=revert。proxyActivities 的选项变更不进入历史（每次调度独立记录），不存在重放风险。
