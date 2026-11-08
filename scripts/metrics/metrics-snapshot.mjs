#!/usr/bin/env node
// metrics-snapshot — compute the first batch of dictionary metrics from the
// engine database and emit metric-observation/v1 rows (read-only).
//
//   node scripts/metrics/metrics-snapshot.mjs [--json] [--workspace <uuid>] [--out observations.json]
//
// Implemented metrics (account-side, existing tables only):
//   T0-001 vric_1000_strict / T0-002 vric_1000_plus   (by workspace)
//   T1-008 source_accept_rate                          (by provider)
//   T1-009 rejection_reason_distribution               (by disposition_code)
//   T2-001 email_coverage_rate                         (by country)
//   T2-005 phone_fill_rate                             (by country)
//   T2-007 contact_role_coverage                       (by country)
//   T2-008 contacts_per_matched_account                (by country, bootstrap CI)
//
// Explicitly skipped (no adjudicated denominator yet): T2-002/003/004/009 — a
// zero VALID count must never be reported as a measured rate; the runner emits
// a SKIPPED observation with the reason instead.
//
// Every observation carries metric_id + version + stratum + window + counts +
// value + Wilson/bootstrap CI + computation_hash, matching the
// metric_observation shape defined in ch01 §3.6.3 so the rollup work (PR-03)
// can persist them unchanged. contact_point.value is never selected.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { createRng, quantile } from "./lib/prng.mjs";
import { assertUuid, parseArgs, queryRows, toInt, utcStamp, wilson } from "./lib/psql.mjs";

const METRIC_VERSIONS = {
  "T0-001": 1,
  "T0-002": 1,
  "T1-008": 1,
  "T1-009": 1,
  "T2-001": 1,
  "T2-005": 1,
  "T2-007": 1,
  "T2-008": 1,
};

const COUNTRY_NORM = (alias) => `case
    when ${alias}.country is null or btrim(${alias}.country) = '' then 'UNKNOWN'
    when btrim(${alias}.country) in ('德国', 'Deutschland', 'GERMANY', 'Germany') then 'DE'
    when btrim(${alias}.country) ~ '^[A-Za-z]{2}$' then upper(btrim(${alias}.country))
    else upper(btrim(${alias}.country))
  end`;

function scopeClause(workspace, alias = "c") {
  return workspace ? `and ${alias}.workspace_id = '${workspace}'` : "";
}

// Each query returns rows: {"dim","numerator","denominator"}.
const QUERIES = {
  "T0-001": (workspace) => `with acc as (
  select distinct c.workspace_id, c.id cid
  from canonical_company c
  join lead l on l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
  where l.fit_verdict = 'match' and l.status <> 'REJECTED'
    and c.status in ('NEW', 'ENRICHED') ${scopeClause(workspace)}
),
people as (
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
select coalesce(a.workspace_id::text, 'ALL') dim,
       (select count(*) from people p where p.workspace_id = a.workspace_id)::text numerator,
       count(*)::text denominator
from acc a group by a.workspace_id
union all
select 'ALL',
       (select count(*) from people)::text,
       (select count(*) from acc)::text`,
  "T0-002": (workspace) => `with acc as (
  select distinct c.workspace_id, c.id cid
  from canonical_company c
  join lead l on l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
  where l.fit_verdict = 'match' and l.status <> 'REJECTED'
    and c.status in ('NEW', 'ENRICHED') ${scopeClause(workspace)}
),
people as (
  select distinct ct.workspace_id, ct.dedupe_key
  from canonical_contact ct
  join acc a on a.cid = ct.company_id and a.workspace_id = ct.workspace_id
  join contact_point cp on cp.contact_id = ct.id and cp.workspace_id = ct.workspace_id
  where cp.status = 'VALID'
    and (
      (cp.type = 'email' and cp.catch_all = 'not_catch_all'
       and cp.verification_method in ('smtp_rcpt','provider_reported','operator')
       and cp.verified_at >= now() - interval '180 days'
       and coalesce(cp.email_type,'other') not in ('role','generic_sales','procurement','finance','support'))
      or (cp.type = 'phone' and cp.verified_at >= now() - interval '90 days')
    )
    and ct.seniority in ('c_level','vp','director','manager')
)
select coalesce(a.workspace_id::text, 'ALL') dim,
       (select count(*) from people p where p.workspace_id = a.workspace_id)::text numerator,
       count(*)::text denominator
from acc a group by a.workspace_id
union all
select 'ALL',
       (select count(*) from people)::text,
       (select count(*) from acc)::text`,
  "T1-008": () => `select provider_key dim,
       count(*) filter (where ingest_status = 'ACCEPTED')::text numerator,
       count(*)::text denominator
from raw_source_record
group by 1
union all
select 'ALL',
       count(*) filter (where ingest_status = 'ACCEPTED')::text,
       count(*)::text
from raw_source_record`,
  "T1-009": () => `select disposition_code dim,
       count(*)::text numerator,
       (select count(*) from raw_source_record where disposition_code is not null)::text denominator
from raw_source_record
where disposition_code is not null
group by 1
union all
select 'ALL',
       count(*)::text,
       count(*)::text
from raw_source_record where disposition_code is not null`,
  "T2-001": (workspace) => `with co as (
  select c.workspace_id, c.id cid, ${COUNTRY_NORM("c")} country
  from canonical_company c
  where exists (
    select 1 from lead l
    where l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
      and l.fit_verdict = 'match'
  ) ${scopeClause(workspace)}
),
em as (
  select distinct ct.workspace_id, ct.company_id cid
  from contact_point cp
  join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'email'
)
select co.country dim,
       count(*) filter (where em.cid is not null)::text numerator,
       count(*)::text denominator
from co
left join em on em.workspace_id = co.workspace_id and em.cid = co.cid
group by 1
union all
select 'ALL',
       count(*) filter (where em.cid is not null)::text,
       count(*)::text
from co
left join em on em.workspace_id = co.workspace_id and em.cid = co.cid`,
  "T2-005": (workspace) => `with co as (
  select c.workspace_id, c.id cid, ${COUNTRY_NORM("c")} country
  from canonical_company c
  where exists (
    select 1 from lead l
    where l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
      and l.fit_verdict = 'match'
  ) ${scopeClause(workspace)}
),
ph as (
  select distinct ct.workspace_id, ct.company_id cid
  from contact_point cp
  join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'phone'
)
select co.country dim,
       count(*) filter (where ph.cid is not null)::text numerator,
       count(*)::text denominator
from co
left join ph on ph.workspace_id = co.workspace_id and ph.cid = co.cid
group by 1
union all
select 'ALL',
       count(*) filter (where ph.cid is not null)::text,
       count(*)::text
from co
left join ph on ph.workspace_id = co.workspace_id and ph.cid = co.cid`,
  "T2-007": (workspace) => `with co as (
  select c.workspace_id, c.id cid, ${COUNTRY_NORM("c")} country
  from canonical_company c
  where exists (
    select 1 from lead l
    where l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
      and l.fit_verdict = 'match'
  ) ${scopeClause(workspace)}
),
dm as (
  select distinct ct.workspace_id, ct.company_id cid
  from canonical_contact ct
  where ct.seniority in ('c_level','vp','director','manager')
)
select co.country dim,
       count(*) filter (where dm.cid is not null)::text numerator,
       count(*)::text denominator
from co
left join dm on dm.workspace_id = co.workspace_id and dm.cid = co.cid
group by 1
union all
select 'ALL',
       count(*) filter (where dm.cid is not null)::text,
       count(*)::text
from co
left join dm on dm.workspace_id = co.workspace_id and dm.cid = co.cid`,
  "T2-008": (workspace) => `with co as (
  select c.workspace_id, c.id cid, ${COUNTRY_NORM("c")} country
  from canonical_company c
  where exists (
    select 1 from lead l
    where l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
      and l.fit_verdict = 'match'
  ) ${scopeClause(workspace)}
),
contacts as (
  select ct.workspace_id, ct.company_id cid, count(*) n
  from canonical_contact ct
  group by 1, 2
)
select co.country dim,
       coalesce(sum(ct.n), 0)::text numerator,
       count(*)::text denominator
from co
left join contacts ct on ct.workspace_id = co.workspace_id and ct.cid = co.cid
group by 1
union all
select 'ALL',
       coalesce(sum(ct.n), 0)::text,
       count(*)::text
from co
left join contacts ct on ct.workspace_id = co.workspace_id and ct.cid = co.cid`,
};

export const QUERY_METRICS = Object.freeze(Object.keys(QUERIES));

export const SKIPPED = Object.freeze([
  { metricId: "T2-002", reason: "NO_ADJUDICATED_VERDICTS", detail: "0 条邮箱级验证裁决；0 VALID 不是测得率" },
  { metricId: "T2-003", reason: "NO_ADJUDICATED_VERDICTS", detail: "catch-all 判定从未发生" },
  { metricId: "T2-004", reason: "NO_ADJUDICATED_VERDICTS", detail: "UNKNOWN 无从谈起（无裁决）" },
  { metricId: "T2-009", reason: "EMPTY_DENOMINATOR", detail: "VALID 联系点为 0" },
]);

const RATIO_METRICS = new Set(["T0-001", "T0-002", "T2-001", "T2-005", "T2-007"]);
const BOOTSTRAP_METRICS = new Set(["T2-008"]);
const DIMENSION_KEY = {
  "T0-001": "workspace",
  "T0-002": "workspace",
  "T1-008": "provider_key",
  "T1-009": "disposition_code",
  "T2-001": "country",
  "T2-005": "country",
  "T2-007": "country",
  "T2-008": "country",
};

/** Stable hash over the observation identity + counts (idempotency key). */
export function computationHash(metricId, version, dim, numerator, denominator) {
  return createHash("sha256")
    .update(`${metricId}|${version}|${dim}|${numerator}|${denominator}`)
    .digest("hex");
}

function makeObservation({ metricId, dim, numerator, denominator, window, seed, dimensionKey }) {
  const version = METRIC_VERSIONS[metricId];
  const base = {
    schemaVersion: "metric-observation/v1",
    metricId,
    metricVersion: version,
    stratum: { [dimensionKey]: dim },
    window,
    numerator,
    denominator,
    computedAt: utcStamp(),
    computationHash: computationHash(metricId, version, dim, numerator, denominator),
  };
  if (!Number.isFinite(denominator) || denominator === 0) {
    return { ...base, value: null, ci: null, status: "NO_DENOMINATOR" };
  }
  if (BOOTSTRAP_METRICS.has(metricId)) {
    // Ratio of counts (contacts per account): Poisson-resample both counts,
    // keep the ratio free to exceed 1, and skip degenerate zero denominators.
    const rng = createRng(seed, `${metricId}:${dim}`);
    const values = [];
    for (let rep = 0; rep < 500; rep += 1) {
      const numer = poissonCount(numerator, rng);
      const denom = poissonCount(denominator, rng);
      if (denom === 0) continue;
      values.push(numer / denom);
    }
    values.sort((left, right) => left - right);
    return {
      ...base,
      value: numerator / denominator,
      ci:
        values.length > 0
          ? { low: quantile(values, 0.025), high: quantile(values, 0.975), method: "bootstrap", reps: values.length }
          : null,
      status: "OK",
    };
  }
  const interval = wilson(numerator, denominator);
  return {
    ...base,
    value: numerator / denominator,
    ci: interval ? { ...interval, method: RATIO_METRICS.has(metricId) ? "wilson" : "none" } : null,
    status: "OK",
  };
}

// Small local Poisson draw (kept here so the snapshot stays dependency-free).
function poissonCount(lambda, rng) {
  if (lambda <= 0) return 0;
  if (lambda >= 30) {
    const u1 = Math.max(rng(), 1e-12);
    const u2 = rng();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * normal));
  }
  const limit = Math.exp(-lambda);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= rng();
  } while (product > limit);
  return count - 1;
}

export function collectSnapshot({ workspace = null, seed = "20261108" } = {}) {
  const observations = [];
  const window = { type: "snapshot", cadence: "weekly", asOf: utcStamp() };
  for (const [metricId, sqlFactory] of Object.entries(QUERIES)) {
    const rows = queryRows(sqlFactory(workspace), ["dim", "numerator", "denominator"]);
    for (const row of rows) {
      observations.push(
        makeObservation({
          metricId,
          dim: row.dim,
          numerator: toInt(row.numerator),
          denominator: toInt(row.denominator),
          window,
          seed,
          dimensionKey: DIMENSION_KEY[metricId],
        }),
      );
    }
  }
  return { generatedAt: utcStamp(), workspace, observations, skipped: [...SKIPPED] };
}

function renderMarkdown(snapshot) {
  const out = [];
  out.push("# 指标快照（只读）");
  out.push("");
  out.push(`> 生成时间：${snapshot.generatedAt}（UTC）；workspace 过滤：${snapshot.workspace ?? "全库"}`);
  out.push("> 观测形状 = `metric-observation/v1`（metricId/version/stratum/window/counts/value/ci/computationHash），供 PR-03 直接落表。");
  out.push("");
  out.push("| 指标 | 维度 | 分子/分母 | 值 | 95% CI | 方法 |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of snapshot.observations) {
    const isRatioOfCounts = BOOTSTRAP_METRICS.has(row.metricId);
    const format = (number) => (isRatioOfCounts ? number.toFixed(2) : `${(number * 100).toFixed(1)}%`);
    const value = row.value === null ? "—" : format(row.value);
    const ci = row.ci && row.ci.low !== undefined ? `[${format(row.ci.low)}, ${format(row.ci.high)}]` : "—";
    const method = isRatioOfCounts ? "bootstrap" : row.metricId === "T1-009" ? "share" : "wilson";
    const dim = Object.values(row.stratum)[0];
    out.push(
      `| ${row.metricId} v${row.metricVersion} | ${dim} | ${row.numerator}/${row.denominator} | ${value} | ${ci} | ${method} |`,
    );
  }
  out.push("");
  out.push("## 跳过的指标（不下结论）");
  out.push("");
  out.push("| 指标 | 原因 | 说明 |");
  out.push("| --- | --- | --- |");
  for (const row of snapshot.skipped) out.push(`| ${row.metricId} | ${row.reason} | ${row.detail} |`);
  return out.join("\n");
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log("usage: node scripts/metrics/metrics-snapshot.mjs [--json] [--workspace <uuid>] [--out <file>]");
    return;
  }
  const workspace = flags.workspace ? assertUuid(flags.workspace, "--workspace") : null;
  const snapshot = collectSnapshot({ workspace });
  if (flags.out) writeFileSync(flags.out, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(flags.json ? JSON.stringify(snapshot, null, 2) : renderMarkdown(snapshot));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
