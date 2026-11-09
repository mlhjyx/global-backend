/**
 * ch01 PR-03：首批 10 个核心指标的 SQL 定义（只读查询，按目标日计算）。
 *
 * 每条 SQL 返回行：{ stratum, numerator, denominator }——
 * stratum 是维度对象（jsonb），计数为整数；置信区间在 rollup.ts 用 Wilson /
 * 参数化 bootstrap 计算（SQL 只出原始计数，便于对账与重算）。
 *
 * 两类窗口：
 *  - snapshot（T0/T2）：窗口 = 目标日当天；查询取当前状态（快照口径）。
 *  - rolling（T1-008/T1-009，7 天）：窗口 = [dayStart-6d, dayEnd]。
 * T2-002 / T2-009 登记但不计算（无已裁决分母 / VALID=0），运行结果显式 skipped。
 */
import { Prisma } from "@prisma/client";

export type MetricCiMethod = "wilson" | "bootstrap";

export interface MetricQueryDefinition {
  metricId: string;
  metricVersion: number;
  windowMode: "snapshot" | "rolling";
  rollingDays?: number;
  ciMethod: MetricCiMethod;
  /** 登记但暂不可计算的原因；有值时运行器跳过且不执行 SQL。 */
  skipReason?: string;
  buildSql: (dayStart: Date, dayEnd: Date) => Prisma.Sql;
}

const EMAIL_OK = Prisma.sql`cp.type = 'email' and cp.status = 'VALID' and cp.catch_all = 'not_catch_all'
        and cp.verification_method in ('smtp_rcpt', 'provider_reported', 'operator')
        and coalesce(cp.email_type, 'other') not in
            ('role', 'generic_sales', 'procurement', 'finance', 'support')`;

const COUNTRY_NORM = Prisma.sql`case
      when c.country is null or btrim(c.country) = '' then 'UNKNOWN'
      when btrim(c.country) in ('德国', 'Deutschland', 'GERMANY', 'Germany') then 'DE'
      when btrim(c.country) ~ '^[A-Za-z]{2}$' then upper(btrim(c.country))
      else upper(btrim(c.country))
    end`;

/** Accounts where the given ICP lead exists (fit=match) — shared by T0/T2. */
const MATCH_ACCOUNTS = Prisma.sql`
  select c.workspace_id, c.id cid, ${COUNTRY_NORM} country
  from canonical_company c
  where exists (
    select 1 from lead l
    where l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
      and l.fit_verdict = 'match'
  )`;

export interface MetricQueryRow {
  stratum: Record<string, unknown>;
  numerator: number;
  denominator: number;
}

export const METRIC_QUERIES: readonly MetricQueryDefinition[] = [
  {
    metricId: "T0-001",
    metricVersion: 1,
    windowMode: "snapshot",
    ciMethod: "wilson",
    buildSql: (dayStart, dayEnd) => Prisma.sql`
      /* metric:T0-001 */
      with acc as (
        select c.workspace_id, c.id cid
        from canonical_company c
        join lead l on l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
        where l.fit_verdict = 'match' and l.status <> 'REJECTED'
          and c.status in ('NEW', 'ENRICHED')
      ),
      people as (
        select distinct ct.workspace_id, ct.dedupe_key
        from canonical_contact ct
        join acc a on a.cid = ct.company_id and a.workspace_id = ct.workspace_id
        join contact_point cp on cp.contact_id = ct.id and cp.workspace_id = ct.workspace_id
        where ${EMAIL_OK}
          and cp.verified_at >= ${dayEnd}::timestamptz - interval '180 days'
          and ct.seniority in ('c_level', 'vp', 'director', 'manager')
      )
      select jsonb_build_object('workspace_id', a.workspace_id::text) stratum,
             a.denominator::int denominator,
             coalesce(p.numerator, 0)::int numerator
      from (select workspace_id, count(distinct cid)::int denominator from acc group by 1) a
      left join (select workspace_id, count(*)::int numerator from people group by 1) p
        using (workspace_id)
      union all
      select jsonb_build_object('workspace_id', 'ALL'),
             (select count(distinct cid)::int from acc),
             (select count(*)::int from people)`,
  },
  {
    metricId: "T0-002",
    metricVersion: 1,
    windowMode: "snapshot",
    ciMethod: "wilson",
    buildSql: (dayStart, dayEnd) => Prisma.sql`
      /* metric:T0-002 */
      with acc as (
        select c.workspace_id, c.id cid
        from canonical_company c
        join lead l on l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
        where l.fit_verdict = 'match' and l.status <> 'REJECTED'
          and c.status in ('NEW', 'ENRICHED')
      ),
      people as (
        select distinct ct.workspace_id, ct.dedupe_key
        from canonical_contact ct
        join acc a on a.cid = ct.company_id and a.workspace_id = ct.workspace_id
        join contact_point cp on cp.contact_id = ct.id and cp.workspace_id = ct.workspace_id
        where (
          (${EMAIL_OK} and cp.verified_at >= ${dayEnd}::timestamptz - interval '180 days')
          or (cp.type = 'phone' and cp.status = 'VALID'
              and cp.verified_at >= ${dayEnd}::timestamptz - interval '90 days')
        )
        and ct.seniority in ('c_level', 'vp', 'director', 'manager')
      )
      select jsonb_build_object('workspace_id', a.workspace_id::text) stratum,
             a.denominator::int denominator,
             coalesce(p.numerator, 0)::int numerator
      from (select workspace_id, count(distinct cid)::int denominator from acc group by 1) a
      left join (select workspace_id, count(*)::int numerator from people group by 1) p
        using (workspace_id)
      union all
      select jsonb_build_object('workspace_id', 'ALL'),
             (select count(distinct cid)::int from acc),
             (select count(*)::int from people)`,
  },
  {
    metricId: "T1-008",
    metricVersion: 1,
    windowMode: "rolling",
    rollingDays: 7,
    ciMethod: "wilson",
    buildSql: (dayStart, dayEnd) => Prisma.sql`
      /* metric:T1-008 */
      select jsonb_build_object('provider_key', provider_key) stratum,
             count(*)::int denominator,
             count(*) filter (where ingest_status = 'ACCEPTED')::int numerator
      from raw_source_record
      where created_at >= ${dayStart}::timestamptz - interval '6 days'
        and created_at <= ${dayEnd}::timestamptz
      group by 1
      union all
      select jsonb_build_object('provider_key', 'ALL'),
             count(*)::int,
             count(*) filter (where ingest_status = 'ACCEPTED')::int
      from raw_source_record
      where created_at >= ${dayStart}::timestamptz - interval '6 days'
        and created_at <= ${dayEnd}::timestamptz`,
  },
  {
    metricId: "T1-009",
    metricVersion: 1,
    windowMode: "rolling",
    rollingDays: 7,
    ciMethod: "wilson",
    buildSql: (dayStart, dayEnd) => Prisma.sql`
      /* metric:T1-009 */
      select jsonb_build_object('disposition_code', disposition_code) stratum,
             (select count(*)::int from raw_source_record
              where disposition_code is not null
                and created_at >= ${dayStart}::timestamptz - interval '6 days'
                and created_at <= ${dayEnd}::timestamptz) denominator,
             count(*)::int numerator
      from raw_source_record
      where disposition_code is not null
        and created_at >= ${dayStart}::timestamptz - interval '6 days'
        and created_at <= ${dayEnd}::timestamptz
      group by disposition_code`,
  },
  {
    metricId: "T2-001",
    metricVersion: 1,
    windowMode: "snapshot",
    ciMethod: "wilson",
    buildSql: () => Prisma.sql`
      /* metric:T2-001 */
      with co as (${MATCH_ACCOUNTS}),
      em as (
        select distinct ct.workspace_id, ct.company_id cid
        from contact_point cp
        join canonical_contact ct on ct.id = cp.contact_id
        where cp.type = 'email'
      )
      select jsonb_build_object('workspace_id', co.workspace_id::text, 'country', co.country) stratum,
             count(*)::int denominator,
             count(em.cid)::int numerator
      from co
      left join em on em.workspace_id = co.workspace_id and em.cid = co.cid
      group by 1
      union all
      select jsonb_build_object('workspace_id', 'ALL', 'country', 'ALL'),
             count(*)::int,
             count(em.cid)::int
      from co
      left join em on em.workspace_id = co.workspace_id and em.cid = co.cid`,
  },
  {
    metricId: "T2-005",
    metricVersion: 1,
    windowMode: "snapshot",
    ciMethod: "wilson",
    buildSql: () => Prisma.sql`
      /* metric:T2-005 */
      with co as (${MATCH_ACCOUNTS}),
      ph as (
        select distinct ct.workspace_id, ct.company_id cid
        from contact_point cp
        join canonical_contact ct on ct.id = cp.contact_id
        where cp.type = 'phone'
      )
      select jsonb_build_object('workspace_id', co.workspace_id::text, 'country', co.country) stratum,
             count(*)::int denominator,
             count(ph.cid)::int numerator
      from co
      left join ph on ph.workspace_id = co.workspace_id and ph.cid = co.cid
      group by 1
      union all
      select jsonb_build_object('workspace_id', 'ALL', 'country', 'ALL'),
             count(*)::int,
             count(ph.cid)::int
      from co
      left join ph on ph.workspace_id = co.workspace_id and ph.cid = co.cid`,
  },
  {
    metricId: "T2-007",
    metricVersion: 1,
    windowMode: "snapshot",
    ciMethod: "wilson",
    buildSql: () => Prisma.sql`
      /* metric:T2-007 */
      with co as (${MATCH_ACCOUNTS}),
      dm as (
        select distinct ct.workspace_id, ct.company_id cid
        from canonical_contact ct
        where ct.seniority in ('c_level', 'vp', 'director', 'manager')
      )
      select jsonb_build_object('workspace_id', co.workspace_id::text, 'country', co.country) stratum,
             count(*)::int denominator,
             count(dm.cid)::int numerator
      from co
      left join dm on dm.workspace_id = co.workspace_id and dm.cid = co.cid
      group by 1
      union all
      select jsonb_build_object('workspace_id', 'ALL', 'country', 'ALL'),
             count(*)::int,
             count(dm.cid)::int
      from co
      left join dm on dm.workspace_id = co.workspace_id and dm.cid = co.cid`,
  },
  {
    metricId: "T2-008",
    metricVersion: 1,
    windowMode: "snapshot",
    ciMethod: "bootstrap",
    buildSql: () => Prisma.sql`
      /* metric:T2-008 */
      with co as (${MATCH_ACCOUNTS}),
      contacts as (
        select ct.workspace_id, ct.company_id cid, count(*)::int n
        from canonical_contact ct
        group by 1, 2
      )
      select jsonb_build_object('workspace_id', co.workspace_id::text, 'country', co.country) stratum,
             count(*)::int denominator,
             coalesce(sum(ct.n), 0)::int numerator
      from co
      left join contacts ct on ct.workspace_id = co.workspace_id and ct.cid = co.cid
      group by 1
      union all
      select jsonb_build_object('workspace_id', 'ALL', 'country', 'ALL'),
             count(*)::int,
             coalesce(sum(ct.n), 0)::int
      from co
      left join contacts ct on ct.workspace_id = co.workspace_id and ct.cid = co.cid`,
  },
  {
    metricId: "T2-002",
    metricVersion: 1,
    windowMode: "snapshot",
    ciMethod: "wilson",
    skipReason: "NO_ADJUDICATED_VERDICTS",
    buildSql: () => Prisma.sql`select null::jsonb stratum, 0::int numerator, 0::int denominator where false`,
  },
  {
    metricId: "T2-009",
    metricVersion: 1,
    windowMode: "snapshot",
    ciMethod: "wilson",
    skipReason: "EMPTY_VALID_DENOMINATOR",
    buildSql: () => Prisma.sql`select null::jsonb stratum, 0::int numerator, 0::int denominator where false`,
  },
];
