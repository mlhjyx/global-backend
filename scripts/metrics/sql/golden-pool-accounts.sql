-- 金标账户候选池导出（只读；ch01 §3.2.2 / PR-08）
--
-- 用法：docker exec -e PGOPTIONS='-c default_transaction_read_only=on' \
--   global-postgres psql -U global -d global_dev -X -A -t -F, -c "$(cat scripts/metrics/sql/golden-pool-accounts.sql)" \
--   > accounts-pool.csv
--
-- 输出列：ref,layer,stratum（与 scripts/metrics/golden-sampling.mjs 的输入契约一致）
--   ref     = canonical_company.id（公司 UUID，不是个人信息）
--   layer   = rolling（v1 首抽全部 rolling；anchor/challenge 由后续人工清单覆盖）
--   stratum = country|industry|employee_band|source_class
--
-- 约束：
--   - 排除 11 个非生产 workspace（只保留主租户 c3584cf9）。
--   - 只选有 lead 的公司（有判定可复核）；不读任何联系点 value。
--   - industry 覆盖率当前仅 5%，UNKNOWN 显式保留（字典 §1.6：禁止默认丢弃）。
with co as (
  select c.id,
         c.workspace_id,
         case
           when c.country is null or btrim(c.country) = '' then 'UNKNOWN'
           when btrim(c.country) in ('德国', 'Deutschland', 'GERMANY', 'Germany') then 'DE'
           when btrim(c.country) ~ '^[A-Za-z]{2}$' then upper(btrim(c.country))
           else upper(btrim(c.country))
         end country,
         coalesce(nullif(btrim(c.industry), ''), 'UNKNOWN') industry,
         case
           when c.employee_count is null then 'UNKNOWN'
           when c.employee_count <= 10 then '1-10'
           when c.employee_count <= 50 then '11-50'
           when c.employee_count <= 200 then '51-200'
           when c.employee_count <= 500 then '201-500'
           when c.employee_count <= 1000 then '501-1000'
           when c.employee_count <= 5000 then '1001-5000'
           else '5000+'
         end employee_band,
         coalesce(src.provider, 'unattributed') source_class
  from canonical_company c
  left join lateral (
    select min(r.provider_key) provider
    from identity_link il
    join raw_source_record r on r.id = il.raw_record_id
    where il.canonical_type = 'company' and il.canonical_id = c.id
  ) src on true
  where c.workspace_id = 'c3584cf9-1a6b-4e7e-9b0c-c1bdcc8258e5'
    and exists (select 1 from lead l where l.canonical_company_id = c.id and l.workspace_id = c.workspace_id)
)
select id as ref,
       'rolling' as layer,
       country || '|' || industry || '|' || employee_band || '|' || source_class as stratum
from co
order by ref;
