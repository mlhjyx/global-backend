# 漏斗基线（2026-11-09 只读快照）

> 文档 ID：`EVIDENCE-FUNNEL-BASELINE-20261109`
> 类型：只读基线证据（时点快照，不可改写；数字会随运行漂移，引用前重跑）
> 数据源：`docker exec global-postgres psql -U global -d global_dev`（`PGOPTIONS=-c default_transaction_read_only=on` 只读会话）
> 采集时间：2026-11-09 01:21（Asia/Shanghai）= 2026-11-08T17:21Z（UTC）
> 复算：`node scripts/metrics/funnel-baseline.mjs`（`--json` / `--show-sql` 可选）
> 对应计划：ch01（测量与真值）E2 之「可触达率」基线；PR-01/PR-16 的只读数据支撑。召回率（frame 抽样）与金标 precision 不在本证据范围。

## 1. 结论（TLDR）

- 全库 2,423 家公司 → lead fit=match 403 家（16.6%）→ match 有域名 302（74.9%）→ match 有邮箱 73（18.1%，Wilson 95% CI [14.7%, 22.2%]）→ match 有电话 4（1.0%）→ **邮箱 VALID 0 → VRIC_1000_STRICT = 0**。
- 主租户（`c3584cf9-…`，唯一真实业务租户）：787 家 → match 128（16.3% [13.9%, 19.0%]）→ match 有邮箱 9（7.0% [3.7%, 12.8%]）→ match 有电话 0 → 邮箱 VALID 0。
- 「有邮箱」18.1% 相对行业单供应商 40–65%、瀑布 85–95% 的基准低一个数量级以上，且这 73 条没有一条通过邮箱级验证——**0 VALID 是管线缺口（从未验证 + 写入缺溯源），不是市场判决**（详见同日 `2026-11-09-risky-inventory.md`）。
- 目录源（directory）556 家公司的域名覆盖为 0（99 家 fit=match 也一样），是「match 有域名 74.9%」一节漏损的主要结构性原因：不解析域名就永远没有联系人。
- 国家字段 `DE` 与「德国」并存（72 行非 ISO 写法），已在查询内归一（归一后 DE 918 家），入库归一仍属 P2 数据治理。

## 2. 方法与口径

- 漏斗定义（公司级去重，按 `canonical_company.id`）：公司池 → lead（status/queue）→ `lead.fit_verdict='match'` → 有域名（`domain` 非空）→ 有邮箱（任一 `contact_point.type='email'`，任意状态，人级归属经 `canonical_contact.company_id`）→ 有电话（`type='phone'`）→ 邮箱 VALID（`status='VALID'`）→ 电话 VALID。
- 「有邮箱」与「邮箱 VALID」分母不同（字典 §1.2）；本证据两者并列，不混用。
- 主租户常量：`c3584cf9-1a6b-4e7e-9b0c-c1bdcc8258e5`（ch01 审计口径：库内 12 个 workspace 中仅此一个是真实业务租户，其余为 E2E/验收夹具）。`--main-workspace` 可覆盖。
- 来源归因：`identity_link`（`canonical_type='company'`）→ `raw_source_record.provider_key`；当前每家公司恰 1 个 provider，120 家未挂接记 `(unattributed)`。
- 比例指标一律给 Wilson 95% CI（z=1.96）；n<30 只当量级参考（字典 §1.7）。
- **PII 纪律**：`contact_point.value` 是加密列，全流程只读元数据（type/status/时间戳/分类列）与公司级 `domain`，不解密、不输出任何地址明文。
- 只读保护：所有查询在 `default_transaction_read_only=on` 会话内执行，服务端拒绝任何写语句（已实测 `INSERT` 被拒：`ERROR: cannot execute INSERT in a read-only transaction`）。

## 3. 真实读数

### 3.1 全库漏斗（2026-11-09）

| 阶段 | 数量 | 相对上一级 | Wilson 95% CI |
| --- | --- | --- | --- |
| 公司池 | 2,423 | — | — |
| 有域名 | 1,845 | 76.1% | — |
| lead fit=match 公司 | 403 | 16.6% | — |
| match 有域名 | 302 | 74.9% of match | [70.5%, 78.9%] |
| match 有邮箱（任意状态） | 73 | 18.1% of match | [14.7%, 22.2%] |
| match 有电话 | 4 | 1.0% of match | [0.4%, 2.5%] |
| match 有 VALID 邮箱 | **0** | 0.0% | [0.0%, 1.4%]（分母=274 条邮箱） |
| match 有 VALID 电话 | 0 | — | — |

补充：lead 总数 12,060（REVIEW 7,575 / REJECTED 4,090 / DISCOVERED 372 / QUALIFIED 23）；QUALIFIED 23 条全部落在测试 workspace（`33fe8b32` 11、`982c2a12` 10、`d46d2170` 2），**真实租户 0**。

### 3.2 主租户漏斗

| 阶段 | 数量 | 相对上一级 | Wilson 95% CI |
| --- | --- | --- | --- |
| 公司池 | 787 | — | — |
| fit=match 公司 | 128 | 16.3% | [13.9%, 19.0%] |
| match 有邮箱（任意状态） | 9 | 7.0% of match | [3.7%, 12.8%] |
| match 有电话 | 0 | 0.0% | [0.0%, 2.9%] |
| match 有 VALID 邮箱 | 0 | 0.0% | — |

主租户 lead 3,495 条（REVIEW 2,803 / REJECTED 491 / DISCOVERED 201；队列 recommended 8 / needs_review 2,873 / rejected 601 / sanctions_hold 13）。

### 3.3 按来源（provider_key，全库）

| provider | 公司 | 有域名 | fit=match | match 有邮箱 | match 有电话 |
| --- | --- | --- | --- | --- | --- |
| public_web | 1,622 | 1,622（100%） | 260 | 71（27.3%） | 4 |
| directory | 556 | **0（0%）** | 99 | **0（0%）** | 0 |
| (unattributed) | 120 | 120（100%） | 29 | 0 | 0 |
| wikidata | 100 | 100（100%） | 13 | 2（15.4%） | 0 |
| openfda | 20 | 0（0%） | 0 | 0 | 0 |
| ted | 5 | 3（60%） | 2 | 0 | 0 |

主租户口径同构：directory 556 家 / match 99 / 邮箱 0；public_web 181 家 / match 28 / 邮箱 9（32.1%）；wikidata 30 / match 1 / 0；openfda 20 / 0 / 0。

### 3.4 按国家（归一后，全库）

| 国家 | 公司 | fit=match | match 有域名 | match 有邮箱 | match 有电话 |
| --- | --- | --- | --- | --- | --- |
| (null) | 1,169 | 195 | 96（49.2%） | 22（11.3%） | 0 |
| DE（含「德国」72 行） | 918 | 173 | 171（98.8%） | 43（24.9%） | 4 |
| AT | 78 | 14 | 14 | 5（35.7%） | 0 |
| CN | 76 | 6 | 6 | 0 | 0 |
| CH | 68 | 7 | 7 | 1（14.3%） | 0 |
| US | 61 | 3 | 3 | 2（66.7%） | 0 |
| IT | 36 | 3 | 3 | 0 | 0 |
| FR / IN | 9 / 8 | 2 / 0 | 2 / 0 | 0 | 0 |

### 3.5 VRIC（引擎侧部分）

按字典 §1.3 的账户集合（match lead、非 REJECTED、公司 NEW/ENRICHED、按公司去重）与「决策人 + email/phone VALID + 新鲜度 + 非职能邮箱」条件计算：

| 范围 | ICP 账户 | VRIC_STRICT | VRIC_PLUS |
| --- | --- | --- | --- |
| 全库 | 403 | 0（0.0/千账户） | 0 |
| 主租户 | 128 | 0（0.0/千账户） | 0 |

注：suppression / OPT_OUT / 合法依据在 gain-saas 库与执行层，本库不可验（字典 §5.1）；因 VALID=0，结果与完整口径一致为 0。电话 VALID 的 `line_type` 校验在 Twilio/SaaS 侧，未接入。

### 3.6 联系点元数据（不解密 value）

| type | status | 数量 |
| --- | --- | --- |
| email | RISKY | 270 |
| email | UNVERIFIED | 3 |
| email | INVALID | 1 |
| linkedin | UNVERIFIED | 78 |
| phone | UNVERIFIED | 30 |

`company_contact_channel` 0 行（A1 #888 未发车，Impressum 公司通道尚未入库）。

## 4. SQL（关键片段，与脚本一致）

公司池数据质量：

```sql
select
  count(*) companies,
  count(*) filter (where domain is not null and btrim(domain) <> '') with_domain,
  count(*) filter (where industry is not null and btrim(industry) <> '') with_industry,
  count(*) filter (where country is not null and btrim(country) <> '') with_country,
  count(*) filter (where country in ('德国', 'Deutschland', 'GERMANY', 'Germany')) legacy_country
from canonical_company;
```

公司级漏斗（按维度分组；`dimension` 替换为 workspace/country/provider，排除项与 join 不变）：

```sql
with co as (
  select c.workspace_id, c.id cid,
         (c.domain is not null and btrim(c.domain) <> '') has_domain,
         case
           when c.country is null or btrim(c.country) = '' then '(null)'
           when btrim(c.country) in ('德国','Deutschland','GERMANY','Germany') then 'DE'
           when btrim(c.country) ~ '^[A-Za-z]{2}$' then upper(btrim(c.country))
           else btrim(c.country)
         end country_norm
  from canonical_company c
),
lead_agg as (
  select l.workspace_id, l.canonical_company_id cid, bool_or(l.fit_verdict = 'match') is_match
  from lead l group by 1, 2
),
em as (
  select distinct ct.workspace_id, ct.company_id cid
  from contact_point cp join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'email'
),
ph as (
  select distinct ct.workspace_id, ct.company_id cid
  from contact_point cp join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'phone'
),
ve as (
  select distinct ct.workspace_id, ct.company_id cid
  from contact_point cp join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'email' and cp.status = 'VALID'
)
select co.country_norm dim,
       count(*) companies,
       count(*) filter (where co.has_domain) with_domain,
       count(*) filter (where la.is_match) match_companies,
       count(*) filter (where la.is_match and em.cid is not null) match_with_email,
       count(*) filter (where la.is_match and ph.cid is not null) match_with_phone,
       count(*) filter (where la.is_match and ve.cid is not null) match_with_valid_email
from co
left join lead_agg la on la.workspace_id = co.workspace_id and la.cid = co.cid
left join em on em.workspace_id = co.workspace_id and em.cid = co.cid
left join ph on ph.workspace_id = co.workspace_id and ph.cid = co.cid
left join ve on ve.workspace_id = co.workspace_id and ve.cid = co.cid
group by 1 order by companies desc;
```

VRIC（引擎侧）：

```sql
with acc as (
  select distinct c.workspace_id, c.id cid
  from canonical_company c
  join lead l on l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
  where l.fit_verdict = 'match' and l.status <> 'REJECTED'
    and c.status in ('NEW','ENRICHED')
),
people_email as (
  select distinct ct.workspace_id, ct.dedupe_key
  from canonical_contact ct
  join acc a on a.cid = ct.company_id and a.workspace_id = ct.workspace_id
  join contact_point cp on cp.contact_id = ct.id and cp.workspace_id = ct.workspace_id
  where cp.type = 'email' and cp.status = 'VALID' and cp.catch_all = 'not_catch_all'
    and cp.verification_method in ('smtp_rcpt','provider_reported','operator')
    and cp.verified_at >= now() - interval '180 days'
    and coalesce(cp.email_type,'other') not in ('role','generic_sales','procurement','finance','support')
    and ct.seniority in ('c_level','vp','director','manager')
)
select (select count(*) from acc) accounts, (select count(*) from people_email) vric_strict;
```

完整 SQL（含 workspace/country/source/queue 全部变体）由 `node scripts/metrics/funnel-baseline.mjs --show-sql` 输出。

## 5. 与 2026-11-08 审计的差异

| 项 | 11-08 审计 | 11-09 复核 | 说明 |
| --- | --- | --- | --- |
| canonical_company | 2,423 | 2,423 | 不变 |
| lead | 12,060 | 12,060 | 不变 |
| contact_point 总数 | 274（仅邮箱语境） | 382（email 274 + phone 30 + linkedin 78） | 总数口径首次完整列出 |
| 邮箱四态 | VALID 0 / RISKY 270 / UNVERIFIED 3 / INVALID 1 | 同 | 不变 |
| match 公司 403（有邮箱 73 / 有电话 4 / VALID 0） | 同 | 同 | 精确复现 |
| 主租户 128 match / 9 邮箱 / 0 VALID | 同 | 同 | 精确复现 |
| QUALIFIED 23 全在测试租户 | 同 | 同 | 不变 |
| company_contact_channel | — | 0 行 | A1 #888 未发车 |

## 6. 限制与下一步

1. **单时点**：所有计数会随 run 漂移；任何对外引用必须重跑本脚本并注明日期。
2. **召回与 precision 未测**：本证据只覆盖库内漏斗（T0/T2 的账户侧）；`company_recall_vs_frame`（E2-①）与 `fit_precision_golden`（E2-②）依赖 frame 抽样与金标集，属后续波次。
3. **测试租户**：11 个非主租户合计 1,636 家公司，其邮箱/电话覆盖偏高（E2E 夹具通常直接带域名与联系人），不得混入业务结论。
4. **来源归因近似**：`identity_link` 目前每公司恰 1 个 provider；多源公司、source_unique_contribution 需要 P2 帧矩阵接入后再精确化。
5. **国家未归一入库**：72 行「德国」在查询层归一；入库归一与 industry 覆盖（5.0%）属 P2 数据治理。
6. **下一步（P0 剩余）**：金标集（E3）→ frame 抽样召回（E2-①）→ CR 试点（E4，脚手架已就位：`scripts/metrics/capture-recapture.mjs`）。
