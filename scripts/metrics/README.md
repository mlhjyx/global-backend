# scripts/metrics — 只读度量脚手架（P0 首波）

配套文档：`docs/metrics/metric-dictionary.md`（指标口径唯一来源）、`docs/evidence/2026-11-09-funnel-baseline.md`、`docs/evidence/2026-11-09-risky-inventory.md`。

| 脚本 | 用途 | 依赖 |
| --- | --- | --- |
| `funnel-baseline.mjs` | 公司池 → lead → fit=match → 域名 → 邮箱 → 电话 → VALID 漏斗；按 workspace/国家/来源拆分；Wilson 95% CI | Node 内置 + `docker exec global-postgres psql`（只读会话） |
| `risky-inventory.mjs` | 联系点元数据盘点：status × catch_all × verification_method × source_type × email_type；公司/域名级汇总；SMTP 探测聚合 | 同上 |
| `capture-recapture.mjs` | 两 frame（CSV）确定性键匹配 + Chapman 估计量与诊断门；三源 log-linear 属 ch01 PR-13 | 纯 Node 内置（无网络/无数据库） |
| `lib/psql.mjs` | 只读 psql 执行器（`PGOPTIONS=-c default_transaction_read_only=on`）与 Wilson/比率工具 | Node 内置 |

## 用法

```bash
node scripts/metrics/funnel-baseline.mjs [--json] [--show-sql] [--main-workspace <uuid>]
node scripts/metrics/risky-inventory.mjs  [--json] [--show-sql] [--top-domains N]
node scripts/metrics/capture-recapture.mjs --a frameA.csv --b frameB.csv [--keys domain,registry_id,name_country] [--json]
```

`capture-recapture` 的 CSV 需表头，可用列：`name`、`country`、`domain`、`registry_id`（至少一列）。匹配是 ch01 §3.4.3 Splink 流水线的确定性第一段；`m11 < 5` 时按计划不出 N̂。

## 测试

```bash
node --test 'scripts/metrics/**/*.test.mjs'
# 等价（在 Node 测试运行器支持目录参数的版本上）：node --test scripts/metrics/
cd scripts/metrics && node --test
```

本机 Node v22.23.1 的 `node --test` 不接受目录参数（会当作模块加载而报 MODULE_NOT_FOUND）；用上面两条等价命令。测试同时被 `scripts/governance-contracts.spec.mjs` 导入，随 `pnpm docs:verify` 在 CI 执行。

## 纪律

- **只读**：SQL 一律经 `lib/psql.mjs`，会话级 `default_transaction_read_only=on`，写语句会被服务端拒绝。
- **PII**：`contact_point.value` 是加密列，任何脚本不得 select 它；只用元数据列与公司级 `domain`。
- **快照会漂移**：输出是单时点读数；引用前重跑并注明日期。
