# 源记分卡（离线只读版，PR-06）

> 文档 ID：`METRICS-SOURCE-SCORECARD-001`
> 版本：`v1.0`（2026-11-09）
> 生命周期：`GUIDE`
> 生命周期依据：ch01 PR-06（源记分卡日任务）在 PR-03 接线前的离线实现说明。
> 状态：`GUIDE`

`scripts/metrics/source-scorecard.mjs` 从引擎库只读计算每个 provider 的产出与质量问题，输出 `source-scorecard-daily/v1` 行（字段对齐 ch01 §3.6.3 的 `source_scorecard_daily` 表），供 PR-03 的日任务与看板接线复用；接线前的基线读数见 [证据](../evidence/2026-11-09-source-scorecard.md)。

## 1. 字段与口径

| 字段 | 口径 | 数据源 |
| --- | --- | --- |
| `rawRecords` | 窗口内 raw 记录数 | `raw_source_record.created_at` ≥ asOf − `--days` |
| `acceptedRecords / rejectedRecords / quarantinedRecords` | 按 `ingest_status` 拆 | 同上 |
| `acceptRate / rejectRate` | accepted（或 rejected）÷ raw | — |
| `rejectReasons` / `rejectReasonsShare` | 被拒+隔离记录按 `disposition_code` 拆分 | 必须命中 [reject-reasons.v1.json](schemas/reject-reasons.v1.json)；未登记码报 `UNKNOWN_DISPOSITION_CODE` 漂移信号 |
| `companiesCreated` | 该 provider 归因到 canonical 公司数 | `identity_link`（全量累计） |
| `uniqueContribution` | 仅该 provider 见过的公司数 | 同上；当前每公司恰 1 个 provider，≈公司数 |
| `domainResolved` | 归因公司中有域名的数 | `canonical_company.domain` |
| `costCents` | 窗口内 `cost_cents` 求和 | `raw_source_record`（工具预算映射待接线） |
| `costPerValidContact` | 成本 ÷ VALID 联系人数 | 当前 VALID=0 → null（不伪造） |
| `freshnessDays` | asOf − 最近 `fetched_at` | — |
| `contentHash` | 行内容 SHA-256 | 供日任务幂等（主键 `(day, provider_key)`） |

## 2. 用法

```bash
node scripts/metrics/source-scorecard.mjs --days 30            # markdown
node scripts/metrics/source-scorecard.mjs --days 30 --json     # source-scorecard-daily/v1
node scripts/metrics/source-scorecard.mjs --days 30 --out sc.json
```

## 3. 验收对照（ch01 PR-06）

- 「至少 5 个源的日行」：2026-11-09 读数 5 个 provider 全部有行 ✅。
- 「目录 74% 拒收能被拆成原因码」：directory 3,266/4,424 = 73.8% 被拒/隔离，拆为 `PROVIDER_PAYLOAD_SCHEMA_INVALID` 70.1% / `SOURCE_POLICY_MISSING` 26.6% / `PROCESSING_KEY_DRIFT` 3.3% ✅。
- 「测试：按 provider 的 yield/accept/reject 计算；空源/新源；幂等」：单测 6 例（聚合、原因拆分、未知码漂移、混合 source_class、幂等哈希、空 provider）✅。
- 未做：`source_scorecard_daily` 写入与看板/告警（PR-03/PR-02 接线）；成本与 provider 的映射；`precision_sample`（金标）。

## 4. 拒收原因码字典

`docs/metrics/schemas/reject-reasons.v1.json` 登记代码、含义、owner 与处置动作（来源：`apps/api/src/discovery/raw-source-ingestion.ts` 与实际线上值）。新增/变更原因码时同步字典，否则记分卡会报漂移信号。
