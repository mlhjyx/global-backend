#!/usr/bin/env node
// source-scorecard — offline read-only source scorecard (ch01 PR-06, script
// side; the daily job + source_scorecard_daily table arrive with PR-03).
//
//   node scripts/metrics/source-scorecard.mjs [--days 7] [--json] [--out scorecard.json]
//
// Per provider it reports: raw records in the window, accepted/rejected/
// quarantined, the reject-reason breakdown validated against
// docs/metrics/schemas/reject-reasons.v1.json (unknown codes are surfaced as a
// drift signal), cost cents, freshness, and the all-time company attribution
// (companies created, domain resolved, unique contribution = companies seen by
// this provider only). Rows carry a content hash so the future daily job can
// be idempotent (source_scorecard_daily has PRIMARY KEY (day, provider_key)).
//
// The database is opened read-only (PGOPTIONS default_transaction_read_only);
// contact_point.value is never touched.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseArgs, queryRows, toInt, utcStamp } from "./lib/psql.mjs";

const REJECT_REASONS = new URL("../../docs/metrics/schemas/reject-reasons.v1.json", import.meta.url);

export function loadRejectReasons(path = REJECT_REASONS) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function windowSql(days) {
  return `select provider_key,
       source_class,
       ingest_status,
       coalesce(disposition_code, '') disposition_code,
       count(*)::text n,
       coalesce(sum(cost_cents), 0)::text cost_cents,
       max(fetched_at)::text last_seen
from raw_source_record
where created_at >= now() - interval '${days} days'
group by 1, 2, 3, 4`;
}

const COMPANY_ATTRIBUTION_SQL = `with cp as (
  select il.canonical_id cid, array_agg(distinct r.provider_key) providers
  from identity_link il
  join raw_source_record r on r.id = il.raw_record_id
  where il.canonical_type = 'company'
  group by 1
)
select p provider,
       count(*)::text companies,
       count(*) filter (where only_one)::text unique_companies,
       count(*) filter (where has_domain)::text domain_resolved
from (
  select unnest(providers) p,
         (cardinality(providers) = 1) only_one,
         (c.domain is not null and btrim(c.domain) <> '') has_domain
  from cp
  join canonical_company c on c.id = cp.cid
) t
group by 1`;

function daysBetween(laterIso, earlierIso) {
  if (!earlierIso) return null;
  const later = new Date(laterIso).getTime();
  const earlier = new Date(earlierIso).getTime();
  if (Number.isNaN(later) || Number.isNaN(earlier)) return null;
  return (later - earlier) / 86400000;
}

function contentHash(row) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        day: row.day,
        provider: row.providerKey,
        raw: row.rawRecords,
        accepted: row.acceptedRecords,
        rejected: row.rejectedRecords,
        quarantined: row.quarantinedRecords,
        reasons: row.rejectReasons,
        cost: row.costCents,
        companies: row.companiesCreated,
        unique: row.uniqueContribution,
      }),
    )
    .digest("hex");
}

/**
 * Aggregate raw query rows into scorecard rows. Pure function (testable):
 * rawRows = [{provider_key, source_class, ingest_status, disposition_code, n, cost_cents, last_seen}]
 * companyRows = [{provider, companies, unique_companies, domain_resolved}]
 */
export function aggregateScorecard({ rawRows, companyRows, rejectReasons, windowDays, asOf }) {
  const providers = new Map();
  const issues = [];
  for (const row of rawRows) {
    const provider = row.provider_key;
    const entry = providers.get(provider) ?? {
      providerKey: provider,
      sourceClasses: new Map(),
      statusCounts: { ACCEPTED: 0, REJECTED: 0, QUARANTINED: 0 },
      rejectReasons: {},
      unknownReasons: new Set(),
      costCents: 0,
      lastSeen: null,
      rawRecords: 0,
    };
    entry.rawRecords += toInt(row.n);
    entry.sourceClasses.set(row.source_class, (entry.sourceClasses.get(row.source_class) ?? 0) + toInt(row.n));
    const status = row.ingest_status;
    entry.statusCounts[status] = (entry.statusCounts[status] ?? 0) + toInt(row.n);
    if (status !== "ACCEPTED" && row.disposition_code) {
      entry.rejectReasons[row.disposition_code] = (entry.rejectReasons[row.disposition_code] ?? 0) + toInt(row.n);
      if (!(row.disposition_code in rejectReasons.reasons)) entry.unknownReasons.add(row.disposition_code);
    }
    entry.costCents += toInt(row.cost_cents);
    if (row.last_seen && (!entry.lastSeen || row.last_seen > entry.lastSeen)) entry.lastSeen = row.last_seen;
    providers.set(provider, entry);
  }
  const companyByProvider = new Map(companyRows.map((row) => [row.provider, row]));
  const rows = [...providers.values()]
    .sort((left, right) => right.rawRecords - left.rawRecords)
    .map((entry) => {
      const company = companyByProvider.get(entry.providerKey) ?? {};
      const dominantClass = [...entry.sourceClasses.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
      const mixed = entry.sourceClasses.size > 1;
      if (entry.unknownReasons.size > 0) {
        issues.push({
          code: "UNKNOWN_DISPOSITION_CODE",
          provider: entry.providerKey,
          detail: [...entry.unknownReasons].join(", "),
        });
      }
      const rejected = entry.statusCounts.REJECTED ?? 0;
      const quarantined = entry.statusCounts.QUARANTINED ?? 0;
      const flagged = rejected + quarantined;
      const rejectShare = {};
      for (const [code, count] of Object.entries(entry.rejectReasons)) {
        rejectShare[code] = flagged > 0 ? count / flagged : null;
      }
      const row = {
        schemaVersion: "source-scorecard-daily/v1",
        day: asOf.slice(0, 10),
        windowDays,
        providerKey: entry.providerKey,
        sourceClass: dominantClass,
        mixedSourceClass: mixed ? [...entry.sourceClasses.keys()].sort() : null,
        rawRecords: entry.rawRecords,
        acceptedRecords: entry.statusCounts.ACCEPTED ?? 0,
        rejectedRecords: rejected,
        quarantinedRecords: quarantined,
        acceptRate: entry.rawRecords > 0 ? (entry.statusCounts.ACCEPTED ?? 0) / entry.rawRecords : null,
        rejectRate: entry.rawRecords > 0 ? rejected / entry.rawRecords : null,
        rejectReasons: entry.rejectReasons,
        rejectReasonsShare: rejectShare,
        unknownRejectCodes: [...entry.unknownReasons].sort(),
        companiesCreated: toInt(company.companies),
        uniqueContribution: toInt(company.unique_companies),
        domainResolved: toInt(company.domain_resolved),
        costCents: entry.costCents,
        costPerValidContact: null,
        costPerValidContactNote: "VALID 联系点为 0，成本/有效联系点不可计算（T2-002 分母为空）",
        freshnessDays: daysBetween(asOf, entry.lastSeen),
        lastSeen: entry.lastSeen,
      };
      row.contentHash = contentHash(row);
      return row;
    });
  return {
    schemaVersion: "source-scorecard-daily/v1",
    asOf,
    windowDays,
    generatedAt: utcStamp(),
    providers: rows,
    issues,
  };
}

export function collectScorecard({ days = 7, asOf = utcStamp() } = {}) {
  const rawRows = queryRows(windowSql(days), [
    "provider_key",
    "source_class",
    "ingest_status",
    "disposition_code",
    "n",
    "cost_cents",
    "last_seen",
  ]);
  const companyRows = queryRows(COMPANY_ATTRIBUTION_SQL, [
    "provider",
    "companies",
    "unique_companies",
    "domain_resolved",
  ]);
  return aggregateScorecard({
    rawRows,
    companyRows,
    rejectReasons: loadRejectReasons(),
    windowDays: days,
    asOf,
  });
}

function percent(value) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(1)}%`;
}

function renderMarkdown(scorecard) {
  const out = [];
  out.push("# 源记分卡（只读离线版）");
  out.push("");
  out.push(`> asOf：${scorecard.asOf}；窗口：最近 ${scorecard.windowDays} 天；形状：\`source-scorecard-daily/v1\`（PR-03 接线后落 source_scorecard_daily）`);
  out.push("");
  out.push("| provider | class | raw | accepted | rejected | quarantined | 接受率 | 拒收率 | 公司数 | 唯一贡献 | 有域名 | 成本(cents) | 新鲜度(天) |");
  out.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of scorecard.providers) {
    out.push(
      `| ${row.providerKey} | ${row.sourceClass}${row.mixedSourceClass ? "（混合）" : ""} | ${row.rawRecords} | ${row.acceptedRecords} | ${row.rejectedRecords} | ${row.quarantinedRecords} | ${percent(row.acceptRate)} | ${percent(row.rejectRate)} | ${row.companiesCreated} | ${row.uniqueContribution} | ${row.domainResolved} | ${row.costCents} | ${row.freshnessDays === null ? "—" : row.freshnessDays.toFixed(1)} |`,
    );
  }
  out.push("");
  out.push("## 拒收原因拆分");
  out.push("");
  out.push("| provider | 拒收原因 | 数量 | 占比（拒收+隔离） |");
  out.push("| --- | --- | --- | --- |");
  for (const row of scorecard.providers) {
    const reasons = Object.entries(row.rejectReasons).sort((left, right) => right[1] - left[1]);
    if (reasons.length === 0) {
      out.push(`| ${row.providerKey} | （无拒收） | 0 | — |`);
      continue;
    }
    for (const [code, count] of reasons) {
      out.push(`| ${row.providerKey} | ${code} | ${count} | ${percent(row.rejectReasonsShare[code])} |`);
    }
  }
  out.push("");
  if (scorecard.issues.length > 0) {
    out.push("## 漂移信号");
    out.push("");
    for (const issue of scorecard.issues) {
      out.push(`- ${issue.code}：${issue.provider} → ${issue.detail}（未在 reject-reasons.v1.json 登记）`);
    }
    out.push("");
  }
  out.push("成本/有效联系点：VALID=0，暂不可算（不伪造）。");
  return out.join("\n");
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    console.log("usage: node scripts/metrics/source-scorecard.mjs [--days N] [--json] [--out <file>]");
    return;
  }
  const days = flags.days !== undefined ? Number(flags.days) : 7;
  if (!Number.isInteger(days) || days <= 0) throw new Error(`--days must be a positive integer, got: ${flags.days}`);
  const scorecard = collectScorecard({ days });
  if (flags.out) writeFileSync(flags.out, `${JSON.stringify(scorecard, null, 2)}\n`);
  console.log(flags.json ? JSON.stringify(scorecard, null, 2) : renderMarkdown(scorecard));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
