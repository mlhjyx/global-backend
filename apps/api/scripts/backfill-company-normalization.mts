/**
 * 存量公司数据归一 backfill（2026-11-10，多源证据图核心切片 ①）。
 *
 * 两件事，全部幂等、默认 dry-run：
 *  1. country 归一：`德国`/`Deutschland`/`DEU` 等变体 → ISO alpha-2（判定链 gates 按 ISO 读）；
 *     NULL country 仅当有确定性登记证据时补（gleif.registered_country / VAT 号前缀）。
 *  2. industry 回填：仅填空值（非空自由文本原样保留）——ISIC_SEED 别名词表对
 *     keywords/products/website_profile.evidence 词面匹配，TED CPV 与 FDA product code
 *     走交叉表；命中节点写 ISIC 英文名 + `attributes.industry_normalization` 留痕。
 *     不认识/无证据的行只进报告，绝不猜。
 *
 * 连接：owner（DATABASE_URL）跨租户扫描，绕过 RLS 是**预期**（与 backfill-pii-encryption.mts
 * 同一纪律）；本脚本只按 id + 原值做条件更新，不触碰其他列。
 *
 * 运行（apps/api 下，.env 已链接）：
 *   node --import tsx scripts/backfill-company-normalization.mts                 # dry-run 报告
 *   node --import tsx scripts/backfill-company-normalization.mts --apply         # 落库
 *   node --import tsx scripts/backfill-company-normalization.mts --report=path.json
 * 可选：--limit=N 只扫前 N 行；--workspace=<uuid> 限定租户。
 */
import 'dotenv/config';
process.umask(0o077);
import { writeFileSync } from 'node:fs';
import { PrismaClient, type Prisma } from '@prisma/client';
import {
  normalizeCountryValue,
  planCompanyNormalization,
  type CompanyNormalizationPlan,
  type IndustryInferencePorts,
} from '../src/discovery/company-normalization';

interface Args {
  apply: boolean;
  limit: number | null;
  workspace: string | null;
  reportPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const limitRaw = argv.find((a) => a.startsWith('--limit='))?.split('=')[1];
  const limit = limitRaw === undefined ? null : Number.parseInt(limitRaw, 10);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit 必须是正整数');
  }
  const workspace = argv.find((a) => a.startsWith('--workspace='))?.split('=')[1] ?? null;
  if (workspace !== null && !/^[0-9a-f-]{36}$/u.test(workspace)) {
    throw new Error('--workspace 必须是 uuid');
  }
  return {
    apply: argv.includes('--apply'),
    limit,
    workspace,
    reportPath: argv.find((a) => a.startsWith('--report='))?.slice('--report='.length) ?? null,
  };
}

type CompanyRow = {
  id: string;
  workspaceId: string;
  name: string;
  domain: string | null;
  country: string | null;
  industry: string | null;
  attributes: Prisma.JsonValue | null;
};

interface CountryChange {
  id: string;
  name: string;
  domain: string | null;
  from: string | null;
  to: string;
  reason: NonNullable<CompanyNormalizationPlan['country']>['reason'];
}

interface IndustryChange {
  id: string;
  name: string;
  domain: string | null;
  to: string;
  isicCode: string;
  nacePrefixes: string[];
  sources: string[];
  matchedTerms: string[];
}

interface Report {
  mode: 'dry-run' | 'apply';
  generatedAt: string;
  scanned: number;
  countryChanges: CountryChange[];
  industryChanges: IndustryChange[];
  unknownCountryValues: Record<string, number>;
  applied: { country: number; industry: number };
  failures: Array<{ id: string; error: string }>;
  beforeSnapshot: unknown;
  afterSnapshot: unknown;
}

function jsonObject(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function snapshot(prisma: PrismaClient): Promise<unknown> {
  const countries = await prisma.$queryRaw<Array<{ country: string | null; count: bigint }>>`
    SELECT country, count(*) AS count FROM canonical_company GROUP BY country ORDER BY count DESC`;
  const [industry] = await prisma.$queryRaw<Array<{ empty: bigint; total: bigint }>>`
    SELECT count(*) FILTER (WHERE industry IS NULL OR btrim(industry) = '') AS empty,
           count(*) AS total
    FROM canonical_company`;
  return {
    countries: countries.map((row) => ({ country: row.country, count: Number(row.count) })),
    industryEmpty: Number(industry?.empty ?? 0),
    total: Number(industry?.total ?? 0),
  };
}

/** canonical_taxonomy 的 FDA product code → panel 交叉表（code 的前缀即 panel）。 */
async function loadFdaPorts(prisma: PrismaClient): Promise<IndustryInferencePorts> {
  const rows = await prisma.canonicalTaxonomy.findMany({
    where: { kind: 'fda_product_code' },
    select: { code: true, parentCode: true },
  });
  const panels = new Map(rows.map((row) => [row.code, row.parentCode]));
  return {
    fdaPanelOf: (code) => panels.get(code) ?? null,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const report: Report = {
    mode: args.apply ? 'apply' : 'dry-run',
    generatedAt: new Date().toISOString(),
    scanned: 0,
    countryChanges: [],
    industryChanges: [],
    unknownCountryValues: {},
    applied: { country: 0, industry: 0 },
    failures: [],
    beforeSnapshot: null,
    afterSnapshot: null,
  };

  const [who] = await prisma.$queryRaw<Array<{ usr: string }>>`SELECT current_user AS usr`;
  console.log(`连接用户：${who?.usr}（owner 跨租户扫描，绕过 RLS 为预期）`);
  report.beforeSnapshot = await snapshot(prisma);
  console.log('BEFORE:', JSON.stringify(report.beforeSnapshot));

  const ports = await loadFdaPorts(prisma);
  const where: Prisma.CanonicalCompanyWhereInput = {
    ...(args.workspace ? { workspaceId: args.workspace } : {}),
  };
  const batchSize = 500;
  let cursor: string | null = null;
  let processed = 0;
  scan: for (;;) {
    const batch = await prisma.canonicalCompany.findMany({
      where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
      select: {
        id: true,
        workspaceId: true,
        name: true,
        domain: true,
        country: true,
        industry: true,
        attributes: true,
      },
      orderBy: { id: 'asc' },
      take: batchSize,
    });
    if (batch.length === 0) break;
    for (const row of batch as CompanyRow[]) {
      cursor = row.id;
      processed += 1;
      report.scanned += 1;
      const plan = planCompanyNormalization(row, ports);
      const countryRaw = typeof row.country === 'string' ? row.country.trim() : '';
      if (countryRaw && normalizeCountryValue(countryRaw) === null) {
        // 归一不了的非标准值：报告明细（不落库、不改动）
        report.unknownCountryValues[row.country!] = (report.unknownCountryValues[row.country!] ?? 0) + 1;
      }
      if (plan.country) {
        report.countryChanges.push({
          id: row.id,
          name: row.name,
          domain: row.domain,
          from: plan.country.from,
          to: plan.country.to,
          reason: plan.country.reason,
        });
      }
      if (plan.industry) {
        report.industryChanges.push({
          id: row.id,
          name: row.name,
          domain: row.domain,
          to: plan.industry.to,
          isicCode: plan.industry.inference.isicCode,
          nacePrefixes: plan.industry.inference.nacePrefixes,
          sources: plan.industry.inference.sources,
          matchedTerms: plan.industry.inference.matchedTerms,
        });
      }
      if (!args.apply) continue;
      if (!plan.country && !plan.industry) continue;
      try {
        const data: Prisma.CanonicalCompanyUpdateManyMutationInput = {};
        if (plan.country) data.country = plan.country.to;
        if (plan.industry) {
          const attributes = jsonObject(row.attributes) ?? {};
          data.industry = plan.industry.to;
          data.attributes = {
            ...attributes,
            industry_normalization: {
              method: 'isic_alias_inference',
              isic_code: plan.industry.inference.isicCode,
              nace_prefixes: plan.industry.inference.nacePrefixes,
              matched_terms: plan.industry.inference.matchedTerms,
              sources: plan.industry.inference.sources,
              normalized_at: new Date().toISOString(),
            },
          } as Prisma.InputJsonValue;
        }
        // 条件更新：只按扫描时看到的原值更新（并发写者优先，不覆盖别人的新值）
        const result = await prisma.canonicalCompany.updateMany({
          where: { id: row.id, country: row.country, industry: row.industry },
          data,
        });
        if (result.count === 1) {
          if (plan.country) report.applied.country += 1;
          if (plan.industry) report.applied.industry += 1;
        }
      } catch (error) {
        report.failures.push({ id: row.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (args.limit !== null && processed >= args.limit) break scan;
  }

  report.afterSnapshot = await snapshot(prisma);

  const byReason = report.countryChanges.reduce<Record<string, number>>((acc, change) => {
    acc[change.reason] = (acc[change.reason] ?? 0) + 1;
    return acc;
  }, {});
  const byIsic = report.industryChanges.reduce<Record<string, number>>((acc, change) => {
    acc[change.isicCode] = (acc[change.isicCode] ?? 0) + 1;
    return acc;
  }, {});
  console.log('\n==== 归一报告 ====');
  console.log(`模式：${report.mode}；扫描 ${report.scanned} 行`);
  console.log(`country 变更：${report.countryChanges.length}（按原因：${JSON.stringify(byReason)}；已写 ${report.applied.country}）`);
  console.log(`industry 回填候选：${report.industryChanges.length}（按 ISIC：${JSON.stringify(byIsic)}；已写 ${report.applied.industry}）`);
  console.log(`未识别 country 值：${JSON.stringify(report.unknownCountryValues)}`);
  if (report.failures.length) console.log(`失败：${JSON.stringify(report.failures.slice(0, 10))}`);
  console.log('country 变更样例（前 8）：');
  for (const change of report.countryChanges.slice(0, 8)) {
    console.log(`  ${change.to}  ←  ${JSON.stringify(change.from)}  (${change.reason})  ${change.name}`);
  }
  console.log('industry 回填样例（前 8）：');
  for (const change of report.industryChanges.slice(0, 8)) {
    console.log(
      `  ${change.isicCode} ${change.to}  ${change.name}  证据=${change.matchedTerms.slice(0, 3).join('|')} (${change.sources.join(',')})`,
    );
  }
  console.log('AFTER:', JSON.stringify(report.afterSnapshot));

  if (args.reportPath) {
    writeFileSync(args.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    console.log(`报告已写入 ${args.reportPath}`);
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
