# 源记分卡基线（2026-11-09 只读离线版）

> 文档 ID：`EVIDENCE-SOURCE-SCORECARD-20261109`
> 类型：只读基线证据（时点快照，不可改写；数字会漂移，引用前重跑）
> 数据源：`docker exec global-postgres psql -U global -d global_dev`（`default_transaction_read_only=on` 只读会话）
> 采集时间：2026-11-09 07:20（Asia/Shanghai）= 2026-11-08T23:20Z（UTC）；窗口：最近 30 天
> 复算：`node scripts/metrics/source-scorecard.mjs --days 30`（`--json` 输出 `source-scorecard-daily/v1`）
> 对应计划：ch01 PR-06（源记分卡）的脚本侧；`source_scorecard_daily` 表与日任务属 PR-03 接线。

## 1. 结论（TLDR）

- 5 个 provider 全部有读数（≥5 源验收）：directory、public_web、wikidata、ted、openfda。
- **「目录约 74% 拒收」首次被拆成原因码**：directory 4,424 条 raw 中 3,266 条被拒/隔离（73.8%），其中 `PROVIDER_PAYLOAD_SCHEMA_INVALID` 2,290（占被拒 70.1%）、`SOURCE_POLICY_MISSING` 868（26.6%）、`PROCESSING_KEY_DRIFT` 108（3.3%）。最大单一原因是供应商载荷 schema 不合法，不是「目录源质量差」这一笼统判断。
- public_web 接受率 91.8%，但隔离 267 条全部是 `PROCESSING_KEY_DRIFT`（98.9%）——这是引擎侧幂等键问题，不是数据质量问题。
- wikidata 接受率 95.7%（12 条 key drift）；ted 26.3%、openfda 45.5%，被拒全是 `PROVIDER_PAYLOAD_SCHEMA_INVALID`。
- 唯一贡献：directory 556/556、public_web 1,600/1,622、wikidata 100/100、ted 5/5、openfda 20/20（当前每公司恰 1 个 provider，唯一贡献≈公司数）。
- 成本：全部 provider 的 `cost_cents` 为 0（本轮数据未记成本）；`cost_per_valid_contact` 因 VALID=0 不可算（不伪造）。
- 新鲜度：全部 provider 最近抓取在 0.7–0.9 天内。

## 2. 真实读数

| provider | class | raw | accepted | rejected | quarantined | 接受率 | 拒收率 | 公司数 | 唯一贡献 | 有域名 | 成本(cents) | 新鲜度(天) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| directory | industry_data | 4,424 | 1,158 | 2,290 | 976 | 26.2% | 51.8% | 556 | 556 | 0 | 0 | 0.8 |
| public_web | public_intelligence（混合 industry_data） | 3,285 | 3,015 | 3 | 267 | 91.8% | 0.1% | 1,622 | 1,600 | 1,622 | 0 | 0.7 |
| wikidata | company_registry | 279 | 267 | 0 | 12 | 95.7% | 0.0% | 100 | 100 | 100 | 0 | 0.7 |
| ted | public_intelligence | 95 | 25 | 70 | 0 | 26.3% | 73.7% | 5 | 5 | 3 | 0 | 0.9 |
| openfda | public_intelligence | 44 | 20 | 24 | 0 | 45.5% | 54.5% | 20 | 20 | 0 | 0 | 0.8 |

拒收原因拆分（占该 provider 被拒+隔离）：

| provider | 原因码 | 数量 | 占比 |
| --- | --- | --- | --- |
| directory | `PROVIDER_PAYLOAD_SCHEMA_INVALID` | 2,290 | 70.1% |
| directory | `SOURCE_POLICY_MISSING` | 868 | 26.6% |
| directory | `PROCESSING_KEY_DRIFT` | 108 | 3.3% |
| public_web | `PROCESSING_KEY_DRIFT` | 267 | 98.9% |
| public_web | `PROVIDER_PAYLOAD_SCHEMA_INVALID` | 3 | 1.1% |
| wikidata | `PROCESSING_KEY_DRIFT` | 12 | 100.0% |
| ted | `PROVIDER_PAYLOAD_SCHEMA_INVALID` | 70 | 100.0% |
| openfda | `PROVIDER_PAYLOAD_SCHEMA_INVALID` | 24 | 100.0% |

未登记原因码：0（全部命中 `docs/metrics/schemas/reject-reasons.v1.json`）。

## 3. SQL（与脚本一致）

按 provider × source_class × ingest_status × disposition_code 聚合（窗口内）：

```sql
select provider_key,
       source_class,
       ingest_status,
       coalesce(disposition_code, '') disposition_code,
       count(*) n,
       coalesce(sum(cost_cents), 0) cost_cents,
       max(fetched_at) last_seen
from raw_source_record
where created_at >= now() - interval '30 days'
group by 1, 2, 3, 4;
```

公司归因与唯一贡献（全量）：

```sql
with cp as (
  select il.canonical_id cid, array_agg(distinct r.provider_key) providers
  from identity_link il
  join raw_source_record r on r.id = il.raw_record_id
  where il.canonical_type = 'company'
  group by 1
)
select p provider,
       count(*) companies,
       count(*) filter (where only_one) unique_companies,
       count(*) filter (where has_domain) domain_resolved
from (
  select unnest(providers) p,
         (cardinality(providers) = 1) only_one,
         (c.domain is not null and btrim(c.domain) <> '') has_domain
  from cp join canonical_company c on c.id = cp.cid
) t
group by 1;
```

## 4. 限制与下一步

1. 窗口口径：raw 计数是最近 30 天（`created_at`）；公司归因是全量累计（`identity_link` 无时间分区）。接线 `source_scorecard_daily` 后按日窗口重算。
2. 成本未记（`cost_cents=0`）：工具预算在 `tool_budget_operation`，与 provider 的映射要在 PR-03/PR-06 接线时建立。
3. `cost_per_valid_contact` 与 `precision_sample` 不可算：VALID=0、金标未标注。
4. 过渡口径：本脚本先替代 `source_scorecard_daily` 的离线视图；接线后本脚本保留为对账工具（结果应与日任务一致，差异 >1% 视为 SQL bug）。
