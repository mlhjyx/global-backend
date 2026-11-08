-- 金标联系人候选池导出（只读；ch01 §3.2.2 / PR-08）
--
-- 用法：docker exec -e PGOPTIONS='-c default_transaction_read_only=on' \
--   global-postgres psql -U global -d global_dev -X -A -t -F, -c "$(cat scripts/metrics/sql/golden-pool-contacts.sql)" \
--   > contacts-pool.csv
--
-- 输出列：ref,layer,stratum
--   ref     = canonical_contact.dedupe_key（HMAC 盲化键；与脚本/金标里的 contactRef 同源）
--   layer   = rolling（v1 首抽全部 rolling）
--   stratum = country|seniority|channel
--   channel = both（有 email 且有 phone）| phone（仅 phone）| email（仅 email）
--
-- 约束（PII 纪律）：
--   - 绝不 select contact_point.value（加密列）；channel 只看 type 的集合。
--   - 只取主租户、只取有姓名的联系人（full_name 非空）、只取有 email/phone 联系点的人。
--   - 输出里的 dedupe_key 是盲化键，不是邮箱/电话/姓名明文。
with base as (
  select ct.id,
         ct.dedupe_key,
         ct.seniority,
         case
           when c.country is null or btrim(c.country) = '' then 'UNKNOWN'
           when btrim(c.country) in ('德国', 'Deutschland', 'GERMANY', 'Germany') then 'DE'
           when btrim(c.country) ~ '^[A-Za-z]{2}$' then upper(btrim(c.country))
           else upper(btrim(c.country))
         end as country
  from canonical_contact ct
  join canonical_company c
    on c.id = ct.company_id and c.workspace_id = ct.workspace_id
  where ct.workspace_id = 'c3584cf9-1a6b-4e7e-9b0c-c1bdcc8258e5'
    and btrim(coalesce(ct.full_name, '')) <> ''
),
channels as (
  select cp.contact_id,
         case
           when bool_or(cp.type = 'email') and bool_or(cp.type = 'phone') then 'both'
           when bool_or(cp.type = 'phone') then 'phone'
           else 'email'
         end as channel
  from contact_point cp
  where cp.type in ('email', 'phone')
  group by cp.contact_id
)
select b.dedupe_key as ref,
       'rolling' as layer,
       b.country || '|' || coalesce(nullif(btrim(b.seniority), ''), 'UNKNOWN') || '|' || ch.channel as stratum
from base b
join channels ch on ch.contact_id = b.id
order by ref;
