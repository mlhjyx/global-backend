#!/usr/bin/env node
// Funnel baseline — read-only snapshot of the acquisition funnel.
//
//   node scripts/metrics/funnel-baseline.mjs                 # markdown to stdout
//   node scripts/metrics/funnel-baseline.mjs --json          # machine-readable
//   node scripts/metrics/funnel-baseline.mjs --show-sql      # include SQL appendix
//   node scripts/metrics/funnel-baseline.mjs --main-workspace <uuid>
//
// Funnel stages (per workspace / country / source):
//   canonical_company 池 → lead（status/queue）→ fit=match 公司 → 有域名
//   → 有邮箱（任意状态）→ 有电话 → 邮箱 VALID → 电话 VALID → VRIC（引擎侧部分）
//
// The database is opened read-only (PGOPTIONS default_transaction_read_only),
// contact_point.value is never selected (encrypted PII column); every figure is
// built from metadata columns only. Counts are a single-point snapshot and will
// drift — rerun before quoting.
import { pathToFileURL } from "node:url";

import {
  assertUuid,
  parseArgs,
  pct,
  pctInterval,
  queryRow,
  queryRows,
  toInt,
  utcStamp,
} from "./lib/psql.mjs";

const DEFAULT_MAIN_WORKSPACE = "c3584cf9-1a6b-4e7e-9b0c-c1bdcc8258e5";
const USAGE = `usage: node scripts/metrics/funnel-baseline.mjs [--json] [--show-sql] [--main-workspace <uuid>]`;

// Raw country spellings observed in the wild are folded to ISO-2 here; the
// dictionary (§1.6) requires DE and 「德国」 to mean the same stratum.
const COUNTRY_NORM = (alias) => `case
    when ${alias}.country is null or btrim(${alias}.country) = '' then '(null)'
    when btrim(${alias}.country) in ('德国', 'Deutschland', 'GERMANY', 'Germany') then 'DE'
    when btrim(${alias}.country) ~ '^[A-Za-z]{2}$' then upper(btrim(${alias}.country))
    else btrim(${alias}.country)
  end`;

// Shared CTE bundle. `dimension` picks the grouping expression; `scope`
// restricts canonical_company to one workspace (empty = whole database).
function funnelSql({ dimension, scope }) {
  return `with co as (
  select c.workspace_id, c.id cid,
         (c.domain is not null and btrim(c.domain) <> '') has_domain,
         ${COUNTRY_NORM("c")} country_norm
  from canonical_company c
  where true ${scope}
),
src as (
  select il.canonical_id cid, min(r.provider_key) provider
  from identity_link il
  join raw_source_record r on r.id = il.raw_record_id
  where il.canonical_type = 'company'
  group by 1
),
lead_agg as (
  select l.workspace_id, l.canonical_company_id cid,
         bool_or(l.fit_verdict = 'match') is_match
  from lead l
  group by 1, 2
),
em as (
  select distinct ct.workspace_id, ct.company_id cid
  from contact_point cp
  join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'email'
),
ph as (
  select distinct ct.workspace_id, ct.company_id cid
  from contact_point cp
  join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'phone'
),
ve as (
  select distinct ct.workspace_id, ct.company_id cid
  from contact_point cp
  join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'email' and cp.status = 'VALID'
),
vp as (
  select distinct ct.workspace_id, ct.company_id cid
  from contact_point cp
  join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'phone' and cp.status = 'VALID'
)
select ${dimension} dim,
       count(*) companies,
       count(*) filter (where co.has_domain) with_domain,
       count(*) filter (where la.is_match) match_companies,
       count(*) filter (where la.is_match and co.has_domain) match_with_domain,
       count(*) filter (where la.is_match and em.cid is not null) match_with_email,
       count(*) filter (where la.is_match and ph.cid is not null) match_with_phone,
       count(*) filter (where la.is_match and ve.cid is not null) match_with_valid_email,
       count(*) filter (where la.is_match and vp.cid is not null) match_with_valid_phone
from co
left join src on src.cid = co.cid
left join lead_agg la on la.workspace_id = co.workspace_id and la.cid = co.cid
left join em on em.workspace_id = co.workspace_id and em.cid = co.cid
left join ph on ph.workspace_id = co.workspace_id and ph.cid = co.cid
left join ve on ve.workspace_id = co.workspace_id and ve.cid = co.cid
left join vp on vp.workspace_id = co.workspace_id and vp.cid = co.cid
group by 1
order by companies desc`;
}

const WORKSPACE_SQL = funnelSql({ dimension: "co.workspace_id", scope: "" });
const COUNTRY_ALL_SQL = funnelSql({ dimension: "co.country_norm", scope: "" });
const SOURCE_ALL_SQL = funnelSql({
  dimension: "coalesce(src.provider, '(unattributed)')",
  scope: "",
});

// MAIN variants: filter canonical_company by workspace before grouping.
function mainVariant(sql, mainWorkspace) {
  const scoped = sql.replace(
    "from canonical_company c\n  where true \n",
    `from canonical_company c\n  where c.workspace_id = '${mainWorkspace}'\n`,
  );
  if (scoped === sql) {
    throw new Error("mainVariant: scope anchor not found in query — update funnelSql anchor");
  }
  return scoped;
}

const TOTALS_SQL = `select
  count(*) companies,
  count(*) filter (where domain is not null and btrim(domain) <> '') with_domain,
  count(*) filter (where industry is not null and btrim(industry) <> '') with_industry,
  count(*) filter (where country is not null and btrim(country) <> '') with_country,
  count(*) filter (where country in ('德国', 'Deutschland', 'GERMANY', 'Germany')) legacy_country
from canonical_company`;

const COUNTRY_RAW_SQL = `select btrim(country) raw_country, ${COUNTRY_NORM("c")} normalized, count(*) n
from canonical_company c
where country is not null and btrim(country) <> ''
group by 1, 2
order by n desc`;

const LEAD_STATUS_SQL = `select workspace_id, status::text status, count(*) n
from lead group by 1, 2 order by 1, 2`;
const LEAD_QUEUE_SQL = `select workspace_id, queue, count(*) n
from lead group by 1, 2 order by 1, 2`;

const CONTACT_META_SQL = `select cp.type, cp.status, count(*) n
from contact_point cp group by 1, 2 order by 1, 2`;

const CHANNEL_SQL = `select count(*) n from company_contact_channel`;

// Engine-side VRIC (dictionary §1.3 conditions 1–3 and 6; suppression/legal
// basis live in the SaaS database and cannot be checked from here).
function vricSql(scope) {
  return `with acc as (
  select distinct c.workspace_id, c.id cid
  from canonical_company c
  join lead l on l.canonical_company_id = c.id and l.workspace_id = c.workspace_id
  where l.fit_verdict = 'match' and l.status <> 'REJECTED'
    and c.status in ('NEW', 'ENRICHED')
    ${scope ? `and c.workspace_id = '${scope}'` : ""}
),
people_email as (
  select distinct ct.workspace_id, ct.dedupe_key
  from canonical_contact ct
  join acc a on a.cid = ct.company_id and a.workspace_id = ct.workspace_id
  join contact_point cp on cp.contact_id = ct.id and cp.workspace_id = ct.workspace_id
  where cp.type = 'email' and cp.status = 'VALID' and cp.catch_all = 'not_catch_all'
    and cp.verification_method in ('smtp_rcpt', 'provider_reported', 'operator')
    and cp.verified_at >= now() - interval '180 days'
    and coalesce(cp.email_type, 'other') not in
        ('role', 'generic_sales', 'procurement', 'finance', 'support')
    and ct.seniority in ('c_level', 'vp', 'director', 'manager')
),
people_phone as (
  select distinct ct.workspace_id, ct.dedupe_key
  from canonical_contact ct
  join acc a on a.cid = ct.company_id and a.workspace_id = ct.workspace_id
  join contact_point cp on cp.contact_id = ct.id and cp.workspace_id = ct.workspace_id
  where cp.type = 'phone' and cp.status = 'VALID'
    and cp.verified_at >= now() - interval '90 days'
    and ct.seniority in ('c_level', 'vp', 'director', 'manager')
),
people_plus as (
  select workspace_id, dedupe_key from people_email
  union
  select workspace_id, dedupe_key from people_phone
)
select (select count(*) from acc) accounts,
       (select count(*) from people_email) vric_strict,
       (select count(*) from people_plus) vric_plus`;
}

const ROWS_COLUMNS = [
  "dim",
  "companies",
  "with_domain",
  "match_companies",
  "match_with_domain",
  "match_with_email",
  "match_with_phone",
  "match_with_valid_email",
  "match_with_valid_phone",
];

function numberRow(row) {
  const out = { dim: row.dim };
  for (const key of ROWS_COLUMNS.slice(1)) out[key] = toInt(row[key]);
  return out;
}

function funnelTable(rows) {
  const header =
    "| 维度 | 公司 | 有域名 | fit=match | match 有域名 | match 有邮箱 | match 有电话 | match 邮箱 VALID | match 电话 VALID |\n" +
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const lines = rows.map(
    (r) =>
      `| ${r.dim} | ${r.companies} | ${r.with_domain} (${pct(r.with_domain, r.companies)}) | ${r.match_companies} | ${r.match_with_domain} (${pct(r.match_with_domain, r.match_companies)}) | ${r.match_with_email} (${pct(r.match_with_email, r.match_companies)}) | ${r.match_with_phone} (${pct(r.match_with_phone, r.match_companies)}) | ${r.match_with_valid_email} | ${r.match_with_valid_phone} |`,
  );
  return [header, ...lines].join("\n");
}

function vricBlock(label, row) {
  const accounts = toInt(row.accounts);
  const strict = toInt(row.vric_strict);
  const plus = toInt(row.vric_plus);
  const per1000 = (people) => (accounts > 0 ? ((1000 * people) / accounts).toFixed(1) : "—");
  return `- ${label}：ICP 账户 ${accounts}；VRIC_STRICT ${strict} 人 → ${per1000(strict)}/千账户；VRIC_PLUS ${plus} 人 → ${per1000(plus)}/千账户。`;
}

function renderMarkdown(data) {
  const out = [];
  out.push("# GainOS 漏斗基线（只读快照）");
  out.push("");
  out.push(`> 生成时间：${data.generatedAt}（UTC）`);
  out.push(`> 数据源：\`docker exec ${data.database.container} psql -U ${data.database.user} -d ${data.database.database}\`（只读会话；\`contact_point.value\` 加密列未读取）`);
  out.push(`> 主租户：\`${data.mainWorkspace}\`（ch01 审计口径）；全库含 12 个 workspace，其中 11 个为 E2E/验收/夹具租户`);
  out.push("> 复算：`node scripts/metrics/funnel-baseline.mjs`（`--show-sql` 打印全部 SQL）");
  out.push("");
  out.push("## 1. 全库公司池数据质量");
  out.push("");
  const t = data.totals;
  out.push("| 指标 | 值 |");
  out.push("| --- | --- |");
  out.push(`| 公司数 | ${t.companies} |`);
  out.push(`| 有域名 | ${t.with_domain}（${pct(t.with_domain, t.companies)}） |`);
  out.push(`| 有行业 | ${t.with_industry}（${pct(t.with_industry, t.companies)}） |`);
  out.push(`| 有国家 | ${t.with_country}（${pct(t.with_country, t.companies)}） |`);
  out.push(`| 国家字段为非 ISO 写法的行 | ${t.legacy_country} |`);
  out.push("");
  out.push("国家字段原始值 → 归一值（只列有值的行）：");
  out.push("");
  out.push("| 原始值 | 归一 | 公司数 |");
  out.push("| --- | --- | --- |");
  for (const row of data.countryRaw) {
    out.push(`| ${row.raw_country} | ${row.normalized} | ${row.n} |`);
  }
  out.push("");
  out.push("## 2. 主租户漏斗（含 Wilson 95% CI）");
  out.push("");
  const main = data.countryMain.reduce(
    (acc, row) => {
      acc.companies += row.companies;
      acc.match_companies += row.match_companies;
      acc.match_with_email += row.match_with_email;
      acc.match_with_phone += row.match_with_phone;
      acc.match_with_valid_email += row.match_with_valid_email;
      return acc;
    },
    { companies: 0, match_companies: 0, match_with_email: 0, match_with_phone: 0, match_with_valid_email: 0 },
  );
  out.push("| 阶段 | 数量 | 上阶段转化率（Wilson 95% CI） | 分母 |");
  out.push("| --- | --- | --- | --- |");
  out.push(`| 公司池 | ${main.companies} | — | — |`);
  out.push(`| fit=match 公司 | ${main.match_companies} | ${pct(main.match_companies, main.companies)} ${pctInterval(main.match_companies, main.companies)} | 公司池 |`);
  out.push(`| match 且有邮箱（任意状态） | ${main.match_with_email} | ${pct(main.match_with_email, main.match_companies)} ${pctInterval(main.match_with_email, main.match_companies)} | match 公司 |`);
  out.push(`| match 且有电话 | ${main.match_with_phone} | ${pct(main.match_with_phone, main.match_companies)} ${pctInterval(main.match_with_phone, main.match_companies)} | match 公司 |`);
  out.push(`| match 且邮箱 VALID | ${main.match_with_valid_email} | ${pct(main.match_with_valid_email, main.match_companies)} | match 公司 |`);
  out.push("");
  out.push("主租户按国家：");
  out.push("");
  out.push(funnelTable(data.countryMain));
  out.push("");
  out.push("## 3. 全库按 workspace");
  out.push("");
  out.push(funnelTable(data.workspace));
  out.push("");
  out.push("Lead 状态与队列（按 workspace，仅列非零）：");
  out.push("");
  out.push("| workspace | lead 总数 | " + data.leadStatuses.map((s) => s.status).join(" | ") + " | 队列：" + data.leadQueues.map((q) => q.queue).join(" / ") + " |");
  out.push("| --- | --- | " + data.leadStatuses.map(() => "---").join(" | ") + " | --- |");
  for (const row of data.leadByWorkspace) {
    out.push(
      `| ${row.workspace} | ${row.total} | ` +
        data.leadStatuses.map((s) => row.statuses[s.status] ?? 0).join(" | ") +
        " | " +
        data.leadQueues.map((q) => row.queues[q.queue] ?? 0).join(" / ") +
        " |",
    );
  }
  out.push("");
  out.push("## 4. 全库按国家（归一后）");
  out.push("");
  out.push(funnelTable(data.countryAll));
  out.push("");
  out.push("## 5. 按来源（provider_key）");
  out.push("");
  out.push("全库：");
  out.push("");
  out.push(funnelTable(data.sourceAll));
  out.push("");
  out.push("主租户：");
  out.push("");
  out.push(funnelTable(data.sourceMain));
  out.push("");
  out.push("## 6. VRIC（引擎侧部分）");
  out.push("");
  out.push("口径：字典 §1.3 的 1–3、6 条（suppression / OPT_OUT / 合法依据在 SaaS 库与执行层，本库不可验）；`verification_method` 取 schema 实际值 `smtp_rcpt | provider_reported | operator`。");
  out.push("");
  out.push(vricBlock("全库", data.vricAll));
  out.push(vricBlock("主租户", data.vricMain));
  out.push("");
  out.push("## 7. 联系点元数据分布（不解密 value）");
  out.push("");
  out.push("| type | status | 数量 |");
  out.push("| --- | --- | --- |");
  for (const row of data.contactMeta) out.push(`| ${row.type} | ${row.status} | ${row.n} |`);
  out.push("");
  out.push(`公司级渠道（company_contact_channel）行数：${data.companyContactChannels}（A1 #888 未发车前为 0）。`);
  out.push("");
  out.push("## 8. 口径与限制");
  out.push("");
  out.push("1. 「有邮箱」= 存在任一 `contact_point.type='email'`（任意状态）；「邮箱 VALID」= `status='VALID'`。两者分母不同，见字典 §1.2。");
  out.push("2. 电话 VALID 在引擎侧只校验状态与新鲜度；`line_type`（mobile/landline）校验在 Twilio/SaaS 侧，未接入。");
  out.push("3. 来源归因走 `identity_link → raw_source_record.provider_key`；当前每公司恰 1 个 provider，未挂接的公司记 `(unattributed)`。");
  out.push("4. 国家归一在本脚本内完成；入库归一属 P2 数据治理。");
  out.push("5. 单时点快照，数字会漂移；对外引用必须重跑并注明日期。");
  out.push("");
  if (data.showSql) {
    out.push("## 附录 · SQL");
    out.push("");
    for (const [name, sql] of Object.entries(data.sql)) {
      out.push(`### ${name}`);
      out.push("");
      out.push("```sql");
      out.push(sql.trim());
      out.push("```");
      out.push("");
    }
  }
  return out.join("\n");
}

export function collectFunnelBaseline({ mainWorkspace = DEFAULT_MAIN_WORKSPACE, showSql = false } = {}) {
  const mainId = assertUuid(mainWorkspace, "--main-workspace");
  const totals = queryRow(TOTALS_SQL, [
    "companies",
    "with_domain",
    "with_industry",
    "with_country",
    "legacy_country",
  ]);
  const workspace = queryRows(WORKSPACE_SQL, ROWS_COLUMNS).map(numberRow);
  const countryAll = queryRows(COUNTRY_ALL_SQL, ROWS_COLUMNS).map(numberRow);
  const countryMain = queryRows(mainVariant(COUNTRY_ALL_SQL, mainId), ROWS_COLUMNS).map(numberRow);
  const sourceAll = queryRows(SOURCE_ALL_SQL, ROWS_COLUMNS).map(numberRow);
  const sourceMain = queryRows(mainVariant(SOURCE_ALL_SQL, mainId), ROWS_COLUMNS).map(numberRow);
  const countryRaw = queryRows(COUNTRY_RAW_SQL, ["raw_country", "normalized", "n"]).map((r) => ({
    raw_country: r.raw_country,
    normalized: r.normalized,
    n: toInt(r.n),
  }));
  const leadStatusRows = queryRows(LEAD_STATUS_SQL, ["workspace_id", "status", "n"]);
  const leadQueueRows = queryRows(LEAD_QUEUE_SQL, ["workspace_id", "queue", "n"]);
  const contactMeta = queryRows(CONTACT_META_SQL, ["type", "status", "n"]).map((r) => ({
    ...r,
    n: toInt(r.n),
  }));
  const companyContactChannels = toInt(queryRow(CHANNEL_SQL, ["n"]).n);

  const statusNames = [...new Set(leadStatusRows.map((r) => r.status))].sort();
  const queueNames = [...new Set(leadQueueRows.map((r) => r.queue))].sort();
  const workspaceIds = [...new Set([...workspace.map((w) => w.dim), ...leadStatusRows.map((r) => r.workspace_id)])].sort();
  const leadByWorkspace = workspaceIds.map((workspaceId) => {
    const statuses = Object.fromEntries(statusNames.map((name) => [name, 0]));
    const queues = Object.fromEntries(queueNames.map((name) => [name, 0]));
    let total = 0;
    for (const row of leadStatusRows.filter((r) => r.workspace_id === workspaceId)) {
      statuses[row.status] = toInt(row.n);
      total += toInt(row.n);
    }
    for (const row of leadQueueRows.filter((r) => r.workspace_id === workspaceId)) {
      queues[row.queue] = toInt(row.n);
    }
    return { workspace: workspaceId, total, statuses, queues };
  });

  const vricAll = queryRow(vricSql(null), ["accounts", "vric_strict", "vric_plus"]);
  const vricMain = queryRow(vricSql(mainId), ["accounts", "vric_strict", "vric_plus"]);

  return {
    generatedAt: utcStamp(),
    database: { container: "global-postgres", user: "global", database: "global_dev" },
    mainWorkspace: mainId,
    totals: {
      companies: toInt(totals.companies),
      with_domain: toInt(totals.with_domain),
      with_industry: toInt(totals.with_industry),
      with_country: toInt(totals.with_country),
      legacy_country: toInt(totals.legacy_country),
    },
    workspace,
    countryAll,
    countryMain,
    sourceAll,
    sourceMain,
    countryRaw,
    leadStatuses: statusNames.map((status) => ({ status })),
    leadQueues: queueNames.map((queue) => ({ queue })),
    leadByWorkspace,
    contactMeta,
    companyContactChannels,
    vricAll: { accounts: toInt(vricAll.accounts), vric_strict: toInt(vricAll.vric_strict), vric_plus: toInt(vricAll.vric_plus) },
    vricMain: { accounts: toInt(vricMain.accounts), vric_strict: toInt(vricMain.vric_strict), vric_plus: toInt(vricMain.vric_plus) },
    showSql,
    sql: showSql
      ? {
          totals: TOTALS_SQL,
          workspace: WORKSPACE_SQL,
          countryAll: COUNTRY_ALL_SQL,
          countryMain: mainVariant(COUNTRY_ALL_SQL, mainId),
          sourceAll: SOURCE_ALL_SQL,
          sourceMain: mainVariant(SOURCE_ALL_SQL, mainId),
          countryRaw: COUNTRY_RAW_SQL,
          leadStatus: LEAD_STATUS_SQL,
          leadQueue: LEAD_QUEUE_SQL,
          contactMeta: CONTACT_META_SQL,
          vricAll: vricSql(null),
          vricMain: vricSql(mainId),
        }
      : undefined,
  };
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log(USAGE);
    return;
  }
  const data = collectFunnelBaseline({
    mainWorkspace: flags["main-workspace"] ?? DEFAULT_MAIN_WORKSPACE,
    showSql: Boolean(flags["show-sql"]),
  });
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(renderMarkdown(data));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
