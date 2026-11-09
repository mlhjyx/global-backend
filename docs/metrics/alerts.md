# 度量告警：阈值与新鲜度（ch01 PR-05）

> 文档 ID：`METRICS-ALERTS-001`
> 生命周期：`GUIDE`
> 生命周期依据：GainOS 深化计划 v3.0 第 1 章 PR-05（看板告警）；规则文件与评估器是唯一实现。
> 状态：`GUIDE`

告警分两类，都只读现有度量表、只由引擎侧评估：

- **阈值（threshold）**：某指标在指定粒度（daily/weekly）的 rollup 桶跌破/超过边界。
- **新鲜度（freshness）**：某指标的最新数据（观测 `window_end` 或 rollup 桶结束时刻）距今超过上限，说明聚合/采集停摆。

规则文件：[`alerts/rules.v1.json`](alerts/rules.v1.json)（`measurement-alerts/v1`），随 PR 变更、经
`scripts/metrics/metrics-lint.mjs` 提交期校验。评估器：`apps/api/src/measurement/alerts.ts`（纯函数）；
命令：`apps/api/scripts/measurement-alerts.mts`。

**非目标**：不落库、不发送任何通知（邮件/IM/站内信）、不在请求路径上运行。告警的持久化与渠道投递
是后续切片/运维接线的事；在那之前，本命令的 JSON 输出就是看板与脚本的取数面。

## 规则字段

每条规则的公共字段（未知字段会被 lint 拒绝，防拼写漂移）：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | `AL-###`，文件内唯一 |
| `metricId` | 是 | 必须存在于[机器字典](dictionary/)（lint 校验 `ALERT_METRIC_UNKNOWN`） |
| `severity` | 是 | `WARNING` / `CRITICAL` |
| `kind` | 是 | `threshold` / `freshness` |
| `owner` | 是 | 与字典同一套 owner 词表 |
| `description` | 是 | 告警含义与第一处置动作（运行时输出会带上） |

`kind: threshold` 追加：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `comparison` | 是 | `below` / `above`；**严格不等号**，等于边界不告警 |
| `bound` | 是 | 有限数值 |
| `granularity` | 是 | `daily` / `weekly`（读 `metric_rollup_daily` / `metric_rollup_weekly`） |
| `aggregation` | 否 | `latest`（默认，取最新一个已观测桶）/ `mean` |
| `lookbackBuckets` | mean 必填 | 取最近 N 个**已观测**桶求算术平均；`1..90` |
| `minSample` | 否 | 分母下限；所选样本（mean 时取桶分母最小值）低于它 → `INSUFFICIENT_DATA` |
| `stratumEquals` | 是 | 对象，逐键按字符串相等匹配 stratum（如 `{"workspace_id":"ALL"}`） |

`kind: freshness` 追加：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `source` | 是 | `observation`（读 `metric_observation.window_end` 最大值）/ `rollup` |
| `granularity` | rollup 必填 | `daily` / `weekly`；桶的新鲜度按桶**结束时刻**算（day+1 天、week+7 天） |
| `maxAgeHours` | 是 | `1..8760`；`asOf - latestDataAt` 超过即 `FIRING` |

## 评估语义（会影响你对输出的解读）

- **数据缺失不是健康**：没有匹配桶/没有任何数据是 `NO_DATA`，分母不足是 `INSUFFICIENT_DATA`，两者都不
  算 `FIRING`，退出码不因此变红——但它们会出现在输出里，看板必须显式呈现，不能折叠成绿色。
- 阈值只评估 `asOf` 当天及以前的桶；同一桶有多个 `metric_version` 时取最高版本。
- `lookbackBuckets` 数的是**已观测桶**而不是日历槽位；中间断档由 freshness 规则负责。
- stratum 匹配是「规则里列出的键都存在且字符串相等」，不要求样本只有这些键。阈值规则必须显式给出
  `stratumEquals`：不同分层的数值不可混在一起比。
- 新鲜度规则不按 stratum 过滤：任何一行的最新数据都算数（平台行与租户行取最大值）。

## 运行

```bash
# 默认规则文件、asOf=now
node --import tsx apps/api/scripts/measurement-alerts.mts

# 机器可读输出（看板/脚本取数面）
node --import tsx apps/api/scripts/measurement-alerts.mts --json

# 指定评估时点（复盘/补跑）
node --import tsx apps/api/scripts/measurement-alerts.mts --as-of 2026-11-09T02:00:00Z

# 指定规则文件
node --import tsx apps/api/scripts/measurement-alerts.mts --rules docs/metrics/alerts/rules.v1.json
```

连接用 owner（`DATABASE_URL`），全部是只读 `SELECT`。退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 无 FIRING（OK / NO_DATA / INSUFFICIENT_DATA 的混合也算 0） |
| `10` | 至少一条 WARNING 在 FIRING |
| `20` | 至少一条 CRITICAL 在 FIRING |
| `1` | 运行错误（规则文件不合法、数据库连不上） |

`NO_DATA` 一律映射为 0 是刻意选择：告警命令不替运维决定「缺数据算不算故障」，避免新部署尚未产出
数据时整条巡检链爆红；看板侧应把 `no_data > 0` 单列显示。

## 首发规则

| 规则 | 指标 | 类型 | 阈值 | 依据 |
| --- | --- | --- | --- | --- |
| AL-001 CRITICAL | T1-008 `source_accept_rate`（`provider_key=public_web`） | 阈值 | 7 日均值 < 50%（分母 ≥ 100） | 基线 91.8%，跌破一半即视为源质量/幂等键回归（[源记分卡证据](../evidence/2026-11-09-source-scorecard.md)） |
| AL-002 WARNING | T2-001 `email_coverage_rate`（全员行） | 阈值 | 7 日均值 < 10%（分母 ≥ 50） | 覆盖率崩塌级下限；基线见[漏斗基线证据](../evidence/2026-11-09-funnel-baseline.md) |
| AL-003 WARNING | T0-001 `vric_1000_strict` | 新鲜度 | 观测 `window_end` 超 36h | 日运行错过一次即超过 36h（正常次日凌晨运行后 age ≈ 1h） |
| AL-004 CRITICAL | T2-001 `email_coverage_rate` | 新鲜度 | 周桶结束超 192h（8 天） | 周聚合刷新停摆两周即报警 |

这些是**首发运维值**，不是产品口径：调阈值＝改规则文件＋跑 lint＋走 PR，由规则 `owner` 复核。
`G-007 metric_freshness_hours` 指标本身仍是 DRAFT（未计算），所以新鲜度告警直接基于原始表时间戳，
不依赖该指标。

## 与门禁的关系

- `scripts/metrics/metrics-lint.mjs` 校验规则文件：schema、id 唯一、指标存在、owner/severity 词表、
  kind 专属字段与取值域；阈值规则缺 `stratumEquals`、mean 缺 `lookbackBuckets`、rollup 新鲜度缺
  `granularity` 都会被拒。
- `apps/api/src/measurement/alerts.spec.ts` 覆盖评估语义（阈值严格比较、版本选择、均值、样本下限、
  分层过滤、新鲜度、退出码），并断言 checked-in 规则引用的指标都在字典里——规则文件变的时候测试会咬。
