# 度量聚合工作流（PR-03）

> 文档 ID：`METRICS-ROLLUP-001`
> 版本：`v1.0`（2026-11-09）
> 生命周期：`GUIDE`
> 生命周期依据：ch01 §3.6.4「日聚合工作流与回填」在 PR-02 四表之上的首个实现切片。
> 状态：`GUIDE`

`measurementRollupWorkflow`（`apps/api/src/temporal/measurement.workflow.ts`）按 UTC 日运行：
采集首批核心指标 → 写 `metric_observation`（append-only、`computation_hash` 幂等）→ 刷新
`metric_rollup_daily` / `metric_rollup_weekly`（按主键 upsert）。活动实现只有一处
（`apps/api/src/measurement/run.ts`），工作流与本地命令共用，保证「回填与实时一致」。

## 1. 首批指标（10 个登记，8 个当日常算）

| 指标 | 窗口 | CI | 备注 |
| --- | --- | --- | --- |
| T0-001 vric_1000_strict | snapshot | Wilson | 按 workspace + 平台 ALL 行 |
| T0-002 vric_1000_plus | snapshot | Wilson | email/phone 任一 VALID；另出 email_only / phone_only / both 通道拆分行（字典 §1.3.1 要求） |
| T1-008 source_accept_rate | rolling 7d | Wilson | 按 provider + ALL |
| T1-009 rejection_reason_distribution | rolling 7d | Wilson | 按 disposition_code（分母=窗口内有码记录） |
| T2-001 email_coverage_rate | snapshot | Wilson | workspace × country + 平台 ALL |
| T2-005 phone_fill_rate | snapshot | Wilson | 同上 |
| T2-007 contact_role_coverage | snapshot | Wilson | 同上 |
| T2-008 contacts_per_matched_account | snapshot | 参数化 bootstrap | 比率型计数 |
| T2-002 email_valid_rate | — | — | 登记但跳过：`NO_ADJUDICATED_VERDICTS`（无邮箱级裁决） |
| T2-009 verification_freshness_ratio | — | — | 登记但跳过：`EMPTY_VALID_DENOMINATOR`（VALID=0） |

跳过是**显式结果**（运行结果 `skipped[]`），不是静默缺行；分母补齐后去掉 `skipReason` 即自动纳入。

## 2. 幂等与迟到/乱序

- 观测唯一键 = `(metric_id, metric_version, stratum_key, window_start, window_end, computation_hash)`；
  `INSERT … ON CONFLICT DO NOTHING`，同一输入重跑不重复插入。
- 重跑历史日：写入该日自己的 window 行（append-only 不覆盖历史）；该日的日/周 rollup 按主键
  upsert 重算。迟到数据由「重跑该日」修正归因，不回写更早的观测行。
- rollup 口径：取截止该日 `window_end ≤ dayEnd` 的「每 (metric, version, stratum) 最新一条观测」，
  桶 = `date_trunc('day'|'week', window_end)`（ISO 周、周一起，UTC）。

## 3. 运行与回填

```bash
# 最近一个完整日（UTC 昨天）
node --import tsx apps/api/scripts/measurement-rollup.mts
# 指定单日
node --import tsx apps/api/scripts/measurement-rollup.mts --day 2026-11-08
# 回填最近 N 天（截至 UTC 昨天，逐日调用同一实现）
node --import tsx apps/api/scripts/measurement-rollup.mts --backfill-days 180
```

连接用 owner（`DATABASE_URL`）：度量作业是平台级服务写者（ch01 §3.6.9），平台行
（`workspace_id IS NULL`）只有 owner 能写；租户侧对 `metric_observation`/rollup 只读
（RLS 只放行自己的行，见 PR-02 的权限负向测试）。

## 4. 触发与排期

- 工作流已在 worker 注册（`createMeasurementActivities({ ownerDb })`，`customer-workflows` 导出）。
- **每日 Schedule 暂未注册**：平台级 Schedule 需走平台执行合同与运维窗口（参考
  `ensure-acquisition-schedule.mts` 的模式与 R4 治理），属后续运维批次；期间用上面的命令
  手动运行或回填。手工触发可直接在 Temporal UI/客户端以 `measurementRollupWorkflow` +
  `{ day: 'YYYY-MM-DD' }` 启动。

## 5. 与 PR-04/05 的衔接

度量 API（PR-04）将读取 `metric_observation`/`metric_rollup_*` 提供 `/metrics/*`；看板（PR-05）
只消费 API，不再重算。源记分卡日任务（PR-06 余量）落地后，T1-008/T1-009 的滚动窗口实现
可与 `source_scorecard_daily` 对账（差异 >1% 视为 SQL bug）。
