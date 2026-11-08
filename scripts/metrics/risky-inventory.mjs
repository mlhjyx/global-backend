#!/usr/bin/env node
// RISKY inventory — read-only metadata census of contact points.
//
//   node scripts/metrics/risky-inventory.mjs            # markdown to stdout
//   node scripts/metrics/risky-inventory.mjs --json     # machine-readable
//   node scripts/metrics/risky-inventory.mjs --show-sql # include SQL appendix
//
// Answers: how many contact points exist per state, why emails are RISKY
// (never verified vs pattern guess), where they came from (source_type),
// which companies/domains they belong to, and what the SMTP probe actually
// measured. contact_point.value is an encrypted PII column and is never
// selected — every figure below is metadata only (type/status/timestamps/
// classification columns plus company-level domain).
import { pathToFileURL } from "node:url";

import {
  parseArgs,
  queryRow,
  queryRows,
  toInt,
  utcStamp,
} from "./lib/psql.mjs";

const USAGE = `usage: node scripts/metrics/risky-inventory.mjs [--json] [--show-sql] [--top-domains N]`;

const TYPE_STATUS_SQL = `select type, status, count(*) n
from contact_point group by 1, 2 order by 1, 2`;

const EMAIL_MATRIX_SQL = `select status,
       coalesce(catch_all, '(null)') catch_all,
       coalesce(verification_method, '(null)') verification_method,
       coalesce(source_type, '(null)') source_type,
       coalesce(email_type, '(null)') email_type,
       count(*) n
from contact_point
where type = 'email'
group by 1, 2, 3, 4, 5
order by n desc`;

const EMAIL_FRESHNESS_SQL = `select
  count(*) total,
  count(*) filter (where verified_at is not null) verified,
  count(*) filter (where source_url is not null) with_source_url,
  count(*) filter (where verified_at is null) never_verified,
  count(*) filter (where verified_at > now() - interval '30 days') verified_lt_30d,
  count(*) filter (where verified_at > now() - interval '90 days' and verified_at <= now() - interval '30 days') verified_30_90d,
  count(*) filter (where verified_at > now() - interval '180 days' and verified_at <= now() - interval '90 days') verified_90_180d,
  count(*) filter (where verified_at <= now() - interval '180 days') verified_gt_180d
from contact_point where type = 'email'`;

const RISKY_DOMAIN_SQL = `select
  count(*) risky_rows,
  count(distinct ct.company_id) companies,
  count(distinct c.domain) filter (where c.domain is not null) domains,
  count(*) filter (where c.domain is null) rows_without_domain
from contact_point cp
join canonical_contact ct on ct.id = cp.contact_id
join canonical_company c on c.id = ct.company_id
where cp.type = 'email' and cp.status = 'RISKY'`;

const RISKY_PER_COMPANY_SQL = `select n, count(*) companies from (
  select ct.company_id, count(*) n
  from contact_point cp
  join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'email' and cp.status = 'RISKY'
  group by 1
) t group by 1 order by 1`;

const RISKY_TOP_DOMAINS_SQL = `select c.domain domain, count(*) risky_emails
from contact_point cp
join canonical_contact ct on ct.id = cp.contact_id
join canonical_company c on c.id = ct.company_id
where cp.type = 'email' and cp.status = 'RISKY' and c.domain is not null
group by 1 order by 2 desc, 1`;

const RISKY_FIT_SQL = `with risky as (
  select cp.id, ct.company_id cid, ct.workspace_id ws
  from contact_point cp
  join canonical_contact ct on ct.id = cp.contact_id
  where cp.type = 'email' and cp.status = 'RISKY'
),
per_company as (
  select r.cid, r.ws, bool_or(l.fit_verdict = 'match') is_match
  from risky r
  left join lead l on l.canonical_company_id = r.cid and l.workspace_id = r.ws
  group by 1, 2
)
select coalesce(is_match::text, 'no-lead') state, count(*) companies
from per_company group by 1 order by 1`;

const RISKY_BY_WORKSPACE_SQL = `select ct.workspace_id workspace, count(*) risky_emails,
       count(distinct ct.company_id) companies
from contact_point cp
join canonical_contact ct on ct.id = cp.contact_id
where cp.type = 'email' and cp.status = 'RISKY'
group by 1 order by 2 desc`;

const SMTP_PROBE_SQL = `select
  count(*) total,
  count(*) filter (where result_json -> 'data' -> 'data' -> 'data' ->> 'reachable' = 'true') reachable_true,
  count(*) filter (where result_json -> 'data' -> 'data' -> 'data' ->> 'reachable' = 'false') reachable_false,
  count(*) filter (where jsonb_array_length(coalesce(result_json -> 'data' -> 'data' -> 'data' -> 'codes', '[]'::jsonb)) = 0) empty_codes,
  count(*) filter (where result_json -> 'data' -> 'data' -> 'data' ->> 'mailFromCode' is null) mailfrom_null,
  count(*) filter (where result_json -> 'data' -> 'data' -> 'data' ->> 'mailFromCode' = '250') mailfrom_250
from tool_budget_operation
where result_schema = 'smtp-probe-verdict/v1'`;

const CHANNEL_SQL = `select count(*) n from company_contact_channel`;

const PHONE_LINKEDIN_SQL = `select type, status, count(*) n,
       count(*) filter (where source_type is not null) with_source_type
from contact_point where type in ('phone', 'linkedin')
group by 1, 2 order by 1, 2`;

function matrixRows(rows) {
  return rows.map((r) => ({
    status: r.status,
    catch_all: r.catch_all,
    verification_method: r.verification_method,
    source_type: r.source_type,
    email_type: r.email_type,
    n: toInt(r.n),
  }));
}

function renderMarkdown(data) {
  const out = [];
  out.push("# RISKY 盘点（只读元数据快照）");
  out.push("");
  out.push(`> 生成时间：${data.generatedAt}（UTC）`);
  out.push(`> 数据源：\`docker exec global-postgres psql -U global -d global_dev\`（只读会话）`);
  out.push("> 纪律：`contact_point.value` 是加密 PII 列，本报告不读取、不解密、不输出任何地址明文；只有元数据列与公司域名。");
  out.push("> 复算：`node scripts/metrics/risky-inventory.mjs`");
  out.push("");
  out.push("## 1. 联系点总览（type × status）");
  out.push("");
  out.push("| type | status | 数量 |");
  out.push("| --- | --- | --- |");
  for (const row of data.typeStatus) {
    out.push(`| ${row.type} | ${row.status} | ${row.n} |`);
  }
  out.push("");
  out.push("## 2. 邮箱四态与溯源交叉表");
  out.push("");
  out.push("同一份现场按 status × catch_all × verification_method × source_type × email_type 全维度展开（不含地址）：");
  out.push("");
  out.push("| status | catch_all | verification_method | source_type | email_type | 数量 |");
  out.push("| --- | --- | --- | --- | --- | --- |");
  for (const row of data.emailMatrix) {
    out.push(
      `| ${row.status} | ${row.catch_all} | ${row.verification_method} | ${row.source_type} | ${row.email_type} | ${row.n} |`,
    );
  }
  out.push("");
  out.push("## 3. 验证新鲜度与溯源完整性（仅邮箱）");
  out.push("");
  const fresh = data.emailFreshness;
  out.push("| 指标 | 数量 |");
  out.push("| --- | --- |");
  out.push(`| 邮箱联系点总数 | ${fresh.total} |`);
  out.push(`| 从未有 verified_at | ${fresh.never_verified} |`);
  out.push(`| 有 verified_at | ${fresh.verified}（${fresh.verified_lt_30d} 条 <30d，其余分桶见 JSON） |`);
  out.push(`| 有 source_url | ${fresh.with_source_url} |`);
  out.push("");
  out.push("## 4. RISKY 邮件的公司与域名分布");
  out.push("");
  const domain = data.riskyDomain;
  out.push(`RISKY 邮箱 ${domain.risky_rows} 条，分布在 ${domain.companies} 家公司 / ${domain.domains} 个域名上；无域名公司的行 ${domain.rows_without_domain}。`);
  out.push("");
  out.push("每家公司 RISKY 邮箱条数分布：");
  out.push("");
  out.push("| 条数 | 公司数 |");
  out.push("| --- | --- |");
  for (const row of data.riskyPerCompany) out.push(`| ${row.n} | ${row.companies} |`);
  out.push("");
  out.push(`域名级 Top（最多 ${data.topDomains.length} 个，按 RISKY 条数）：`);
  out.push("");
  out.push("| 域名 | RISKY 邮箱条数 |");
  out.push("| --- | --- |");
  for (const row of data.topDomains) out.push(`| ${row.domain} | ${row.risky_emails} |`);
  out.push("");
  out.push("RISKY 邮件所属公司与 lead 状态：");
  out.push("");
  out.push("| 公司是否 fit=match | 公司数 |");
  out.push("| --- | --- |");
  for (const row of data.riskyFit) {
    out.push(`| ${row.state === "true" ? "是" : row.state === "false" ? "否" : "无 lead"} | ${row.companies} |`);
  }
  out.push("");
  out.push("按 workspace：");
  out.push("");
  out.push("| workspace | RISKY 邮箱 | 公司数 |");
  out.push("| --- | --- | --- |");
  for (const row of data.riskyByWorkspace) {
    out.push(`| ${row.workspace} | ${row.risky_emails} | ${row.companies} |`);
  }
  out.push("");
  out.push("## 5. SMTP 探测实际测到了什么");
  out.push("");
  const probe = data.smtpProbe;
  out.push(`\`tool_budget_operation.result_schema = 'smtp-probe-verdict/v1'\` 共 ${probe.total} 条：reachable=true ${probe.reachable_true}、reachable=false ${probe.reachable_false}；\`codes\` 为空 ${probe.empty_codes}；\`mailFromCode\` null ${probe.mailfrom_null} / 250 ${probe.mailfrom_250}。`);
  out.push("");
  out.push("解读：探测只验证到域名级连通/MX（无邮箱级 RCPT 裁决），不能作为任何地址的有效性证据。");
  out.push("");
  out.push("## 6. 电话与 LinkedIn");
  out.push("");
  out.push("| type | status | 数量 | 有 source_type |");
  out.push("| --- | --- | --- | --- |");
  for (const row of data.phoneLinkedin) {
    out.push(`| ${row.type} | ${row.status} | ${row.n} | ${row.with_source_type} |`);
  }
  out.push("");
  out.push(`公司级渠道（company_contact_channel）：${data.companyContactChannels} 行（A1 #888 发车前为 0，Impressum 公司通道尚未入库）。`);
  out.push("");
  out.push("## 7. 与 2026-11-08 首日盘点的差异与结论");
  out.push("");
  out.push("- 首日口径「270 RISKY = 250 从未验证 + 24 pattern guess」需要修正：250 条「无验证方法」里包含 3 条 UNVERIFIED 与 1 条 INVALID；按状态拆分为 **RISKY 270 = 246 从未验证 + 24 pattern guess**，另有 UNVERIFIED 3、INVALID 1。");
  out.push("- 首日「213 条无 source_type」已漂移为 **250 条无 source_type**（274 条邮箱中仅 24 条有 pattern_guess 溯源）。");
  out.push("- 「0 VALID」应读作「从未做邮箱级验证 + 写入缺溯源」，不是「市场证明这些邮箱不可用」（ch01 §2.2）。");
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

export function collectRiskyInventory({ showSql = false, topDomains = 10 } = {}) {
  const typeStatus = queryRows(TYPE_STATUS_SQL, ["type", "status", "n"]).map((r) => ({
    ...r,
    n: toInt(r.n),
  }));
  const emailMatrix = matrixRows(queryRows(EMAIL_MATRIX_SQL, [
    "status",
    "catch_all",
    "verification_method",
    "source_type",
    "email_type",
    "n",
  ]));
  const freshRow = queryRow(EMAIL_FRESHNESS_SQL, [
    "total",
    "verified",
    "with_source_url",
    "never_verified",
    "verified_lt_30d",
    "verified_30_90d",
    "verified_90_180d",
    "verified_gt_180d",
  ]);
  const emailFreshness = Object.fromEntries(
    Object.entries(freshRow).map(([key, value]) => [key, toInt(value)]),
  );
  const riskyDomainRow = queryRow(RISKY_DOMAIN_SQL, [
    "risky_rows",
    "companies",
    "domains",
    "rows_without_domain",
  ]);
  const riskyDomain = Object.fromEntries(
    Object.entries(riskyDomainRow).map(([key, value]) => [key, toInt(value)]),
  );
  const riskyPerCompany = queryRows(RISKY_PER_COMPANY_SQL, ["n", "companies"]).map((r) => ({
    n: toInt(r.n),
    companies: toInt(r.companies),
  }));
  const topDomainRows = queryRows(RISKY_TOP_DOMAINS_SQL, ["domain", "risky_emails"])
    .slice(0, topDomains)
    .map((r) => ({ domain: r.domain, risky_emails: toInt(r.risky_emails) }));
  const riskyFit = queryRows(RISKY_FIT_SQL, ["state", "companies"]).map((r) => ({
    state: r.state,
    companies: toInt(r.companies),
  }));
  const riskyByWorkspace = queryRows(RISKY_BY_WORKSPACE_SQL, ["workspace", "risky_emails", "companies"]).map(
    (r) => ({
      workspace: r.workspace,
      risky_emails: toInt(r.risky_emails),
      companies: toInt(r.companies),
    }),
  );
  const probeRow = queryRow(SMTP_PROBE_SQL, [
    "total",
    "reachable_true",
    "reachable_false",
    "empty_codes",
    "mailfrom_null",
    "mailfrom_250",
  ]);
  const smtpProbe = Object.fromEntries(
    Object.entries(probeRow).map(([key, value]) => [key, toInt(value)]),
  );
  const phoneLinkedin = queryRows(PHONE_LINKEDIN_SQL, [
    "type",
    "status",
    "n",
    "with_source_type",
  ]).map((r) => ({ ...r, n: toInt(r.n), with_source_type: toInt(r.with_source_type) }));
  const companyContactChannels = toInt(queryRow(CHANNEL_SQL, ["n"]).n);

  return {
    generatedAt: utcStamp(),
    typeStatus,
    emailMatrix,
    emailFreshness,
    riskyDomain,
    riskyPerCompany,
    topDomains: topDomainRows,
    riskyFit,
    riskyByWorkspace,
    smtpProbe,
    phoneLinkedin,
    companyContactChannels,
    showSql,
    sql: showSql
      ? {
          typeStatus: TYPE_STATUS_SQL,
          emailMatrix: EMAIL_MATRIX_SQL,
          emailFreshness: EMAIL_FRESHNESS_SQL,
          riskyDomain: RISKY_DOMAIN_SQL,
          riskyPerCompany: RISKY_PER_COMPANY_SQL,
          riskyTopDomains: RISKY_TOP_DOMAINS_SQL,
          riskyFit: RISKY_FIT_SQL,
          riskyByWorkspace: RISKY_BY_WORKSPACE_SQL,
          smtpProbe: SMTP_PROBE_SQL,
          phoneLinkedin: PHONE_LINKEDIN_SQL,
          companyContactChannel: CHANNEL_SQL,
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
  const topDomains = flags["top-domains"] !== undefined ? Number(flags["top-domains"]) : 10;
  if (!Number.isInteger(topDomains) || topDomains <= 0) {
    throw new Error(`--top-domains must be a positive integer, got: ${flags["top-domains"]}`);
  }
  const data = collectRiskyInventory({ showSql: Boolean(flags["show-sql"]), topDomains });
  if (flags.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(renderMarkdown(data));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
