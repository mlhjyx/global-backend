# 工作流编排单测地基（hermetic proxyActivities-mock）

> 状态：**已落地**（pilot = `externalIntentSweepWorkflow`，2026-07-12）。后续 6 个 workflow 复用同一 harness，各一 spec（fast-follow PR）。

## 背景 / 动机

`apps/api/src/temporal` 有 7 个 Temporal workflow（understanding / discovery / qualify /
acquisition / intent / backlog / external-intent），但**编排层此前零 CI 单测**——无
`@temporalio/testing` 谐调，全靠本地真库 `verify-*.mts` 脚本（不进 CI，§8 CI 只跑纯单测）。
活动层（activity）有单测，编排层（activity 调用顺序 / 入参穿线 / fail-safe try-catch 分支）无守。

**触发缺口**（PR #70 对抗复审）：`externalIntentSweepWorkflow` 现每 sweep 只调
`liveProviderState()` 一次，把 `live` 快照 thread 进每个 `projectExternalIntentForIcp({...,live})`。
此接线无 CI 守：

- 未来重构若从穿线入参里漏掉 `live` → 静默退回「每 ICP 一次 owner-DB 读」（投影活动的
  `?? await liveEnabled()` 兜底保住**正确性**，掩盖了**性能**回归）→ CI 全绿。
- 穿线快照被写反 / 陈旧（如恒 `{ted:false,openfda:false}`）→ 过度跳过所有投影，**正确性**回归，
  仅本地 verify 脚本能抓。

## 方案抉择（评估结论）

任务原提「加 `@temporalio/testing`」。评估后**不用**它，改用 **mock `proxyActivities`**：

| 维度 | `@temporalio/testing`（TestWorkflowEnvironment） | **mock proxyActivities（采用）** |
|------|--------------------------------------------------|----------------------------------|
| 保真度 | 真 Temporal 运行时（determinism / sandbox / retry / replay） | 纯 JS 编排，无运行时语义 |
| 出网/二进制 | 需 test-server 二进制（首用下载）+ webpack bundle workflow | **零**：无二进制、无子进程、无出网 |
| CI 契合 | 与 §8「无 DB/网络」CI test job **冲突**（要 vendoring 体操） | 跑在**既有** `vitest run` job，不改 CI |
| 新依赖 | 重量级 devDep | **零**（vitest 已在） |
| 契合目标 | 过度（目标只要 call order + 穿线 + try/catch） | 精准命中 |

**决定性事实**：7 个 workflow 全是纯编排函数，唯一运行时依赖是 `@temporalio/workflow` 的
`proxyActivities()`（backlog 另用 `log`）；**无** `sleep`/`condition`/signal/child-workflow/timer/
非确定性 API（`Date.now`/`Math.random`/`uuid4`）。故 mock 掉这一个模块即可让编排以纯 JS 运行，
activity 返回值逐个可控、调用顺序/入参可观测。

**权衡（明示）**：不覆盖真 Temporal 运行时（determinism/sandbox/retry/replay）。缓释：
sandbox 安全性已由 `Worker.create` bundle 期 + `nest build` 守；这些 workflow 用零非确定性 API。
**升级路径**：若将来引入 `sleep`/signal/child-workflow/timer，届时 `@temporalio/testing` 才值其重量。

## 组件（只新增，无生产代码改动）

1. `apps/api/src/temporal/testing/temporal-workflow.mock.ts` — 复用 harness。导出：
   - `acts`：单例 `Proxy`（`Record<string, Mock>`），首次访问某 activity 名即 memoize 一个 `vi.fn()`。
   - `proxyActivities()` / `log`：被 mock 的 `@temporalio/workflow` 表面。
   - `resetActivities()`：`beforeEach` 清注册表 + logger。
2. `apps/api/src/temporal/external-intent.workflow.spec.ts` — pilot。两行接线：
   ```ts
   vi.mock('@temporalio/workflow', () => import('./testing/temporal-workflow.mock'));
   import { acts, resetActivities } from './testing/temporal-workflow.mock';
   ```
   静态 import 与工厂的动态 import 解析到**同一模块实例** → 同一注册表。
3. `apps/api/tsconfig.build.json` — `exclude` 加 `src/temporal/testing`（把 import vitest 的
   harness 挡在 `dist` 外；`**/*.spec.ts` 已被排除）。

## pilot 断言（= PR #70 缺口 + 各 fail-safe 分支的 CI 守）

| # | 场景 | 断言 |
|---|------|------|
| 1 | happy path，2 目标 | `liveProviderState` **恰调 1 次**；**每个** `projectExternalIntentForIcp` 调用的 `.live` === 同一 `liveProviderState` 返回（反回归 + 同引用穿线）；调用**顺序** list→expire→resolve→ingest→**live**→project（live 读在 ingest 后、所有投影前） |
| 2 | `liveProviderState` reject | workflow 仍完成；每个投影调用拿到 `live: undefined`（try/catch→undefined 兜底） |
| 3 | 两 provider 全 disabled | 早返：expire/live/project **均不调**；结果 = 零 agg |
| 4 | 一个投影 reject | `results` 2 条（一 `error` 一正常）；`swept===2`；聚合只计成功者（逐 ICP fail-safe） |
| 5 | `resolveExternalIntentTarget` reject 一次 | fail-safe 桩（`cpvCodes:[]`+`error`）仍进 `ingest.targets`；workflow 完成 |
| 6 | `ingestExternalSignals` reject | `ingest.errors` 非空；投影仍跑（吃前窗已落库信号） |
| 7 | `limit` 透传 | `listExternalIntentTargets` 收 `{limit:5}`；缺省收 `{}` |

## 非空校验（对抗式）

每个守由 mutation 反证：把对应回归注入 workflow 副本、只该守的测试转红、其余仍绿，则证明测试非
vacuous（详见 PR 描述）。
