# scripts/metrics — 只读度量脚手架（P0 第一、二波）

配套文档：`docs/metrics/metric-dictionary.md`（指标口径唯一来源）、`docs/metrics/frame-registry.md`（19 法域 frame 矩阵）、`evals/golden-discovery/README.md`（金标抽样与登记）、`docs/evidence/2026-11-09-funnel-baseline.md` / `2026-11-09-risky-inventory.md`（时点证据）。

| 脚本 | 用途 | 依赖 |
| --- | --- | --- |
| `funnel-baseline.mjs` | 公司池 → lead → fit=match → 域名 → 邮箱 → 电话 → VALID 漏斗；按 workspace/国家/来源拆分；VRIC STRICT/PLUS（含 email_only/phone_only/both 通道拆分）；Wilson 95% CI | Node 内置 + `docker exec global-postgres psql`（只读会话） |
| `risky-inventory.mjs` | 联系点元数据盘点：status × catch_all × verification_method × source_type × email_type；公司/域名级汇总；SMTP 探测聚合 | 同上 |
| `capture-recapture.mjs` | 两 frame：确定性键匹配 + Chapman；三 frame：键簇捕获矩阵 + 8 个 log-linear 模型（G²+AIC）+ 参数化 bootstrap + Chao 下界 + 留一法敏感性 + 可选概率匹配（`--probabilistic`，blocking+固定权重评分+人工复核队列） | 纯 Node 内置（无网络/无数据库） |
| `golden-sampling.mjs` | 金标集确定性分层抽样（seed 固定、按层配额、欠采样如实报告） | 纯 Node 内置 |
| `frame-registry.mjs` | 校验 `docs/metrics/frames/frame-registry.v1.json`：唯一键、许可、枚举、ACTIVE 需 license | 纯 Node 内置 |
| `metrics-lint.mjs` | 校验 `docs/metrics/dictionary/*.json`：`metric-definition/v1` 字段/词表、ID 唯一、tier 前缀一致、来源必须登记（ACTIVE 只许 existing 源）、changelog 1..version 连续 | 纯 Node 内置 |
| `metrics-snapshot.mjs` | 从引擎库只读计算第一批指标（T0-001/002、T1-008/009、T2-001/005/007/008），输出 `metric-observation/v1` 行（含 computationHash，供 PR-03 落表）；无裁决分母的指标显式 SKIPPED | Node 内置 + psql 只读 |
| `report.mjs` | 由快照渲染固定周报/月报模板（北极星→覆盖→可触达→质量门→源→风险）；未接线/不可测/缺失三种状态显式留白，禁止手写数字；`--kind weekly|monthly` | 纯 Node 内置 |
| `reply-rate.mjs` | RR1/RR3 成对计算与声明校验（`unknown>0` 无 `ê` 拒绝出数；`--check` 拒绝单口径） | 纯 Node 内置 |
| `lib/psql.mjs` | 只读 psql 执行器（`PGOPTIONS=-c default_transaction_read_only=on`）与 Wilson/比率工具 | Node 内置 |
| `lib/prng.mjs` | 固定 seed 的 PRNG / Poisson / 分位数（抽样与 bootstrap） | Node 内置 |
| `sql/golden-pool-*.sql` | 金标候选池只读导出模板（账户/联系人；联系人 ref 为盲化 dedupe_key） | psql 只读 |

## 用法

```bash
node scripts/metrics/funnel-baseline.mjs [--json] [--show-sql] [--main-workspace <uuid>]
node scripts/metrics/risky-inventory.mjs  [--json] [--show-sql] [--top-domains N]
node scripts/metrics/capture-recapture.mjs --a frameA.csv --b frameB.csv [--keys domain,registry_id,name_country] [--json]
node scripts/metrics/capture-recapture.mjs --frame A=a.csv --frame B=b.csv --frame C=c.csv [--bootstrap 1000] [--seed 20261108] [--json]
node scripts/metrics/golden-sampling.mjs --manifest evals/golden-discovery/v1/manifest.template.json --dataset accounts --pool pool.csv --out sampled.csv [--report report.json]
node scripts/metrics/frame-registry.mjs [--json]
node scripts/metrics/metrics-lint.mjs [--json] [--dir docs/metrics/dictionary]
node scripts/metrics/metrics-snapshot.mjs [--json] [--workspace <uuid>] [--out observations.json]
node scripts/metrics/report.mjs --kind weekly|monthly --snapshot observations.json [--period <label>] [--out report.md] [--out-json report.json]
node scripts/metrics/reply-rate.mjs --input counts.json [--json]
node scripts/metrics/reply-rate.mjs --check statement.txt
```

`capture-recapture` 的 CSV 需表头，可用列：`name`、`country`、`domain`、`registry_id`（至少一列）。匹配是 ch01 §3.4.3 Splink 流水线的确定性第一段；两 frame 用 Chapman（`m11 < 5` 不出 N̂），三 frame 用 log-linear（两两交集 < 5 阻断、< 25 警告、模型跨度 > 30% 只报范围）。

## 测试

```bash
node --test 'scripts/metrics/**/*.test.mjs'
# 等价（在 Node 测试运行器支持目录参数的版本上）：node --test scripts/metrics/
cd scripts/metrics && node --test
```

本机 Node v22.23.1 的 `node --test` 不接受目录参数（会当作模块加载而报 MODULE_NOT_FOUND）；用上面两条等价命令。测试同时被 `scripts/governance-contracts.spec.mjs` 导入，随 `pnpm docs:verify` 在 CI 执行。

## 纪律

- **只读**：SQL 一律经 `lib/psql.mjs`，会话级 `default_transaction_read_only=on`，写语句会被服务端拒绝。
- **PII**：`contact_point.value` 是加密列，任何脚本不得 select 它；只用元数据列与公司级 `domain`；金标联系人 ref 用盲化 `dedupe_key`。
- **固定 seed**：抽样与 bootstrap 必须可从 manifest/参数复现（ch01 §6.3）。
- **快照会漂移**：输出是单时点读数；引用前重跑并注明日期。
