/**
 * 证据包 v1 shadow 构建 CLI（2026-11-10，多源证据图核心切片 ②）。
 *
 * 对公司集合（默认 DE、有域名）：
 *  1. 从已存 attributes 装配分层证据条目（零出网）；
 *  2. 缺失域经 ENABLED 富集 provider 实时探测（gleif / wikidata；内部经 ToolBroker：
 *     source_policy/预算/限流/Trace 单点强制）；单源失败只记错过；
 *  3. 写 `canonical_company.attributes.evidence_bundle`（shadow：不改判定/展示结论；
 *     版本号护栏防并发覆盖）；
 *  4. 对公司**最近一条判定记录**跑 corroboration 评估（judgment/corroboration.ts 同一
 *     口径）——这就是判定链 shadow 记录在真实 verdict 上的离线样例。
 *
 * 运行（apps/api 下，.env 已链接；owner 连接跨租户，预期）：
 *   node --import tsx scripts/build-evidence-bundle.mts --country=DE --limit=10          # dry-run
 *   node --import tsx scripts/build-evidence-bundle.mts --country=DE --limit=10 --apply
 *   node --import tsx scripts/build-evidence-bundle.mts --domains=a.de,b.de --report=/tmp/b.json
 */
import 'dotenv/config';
process.umask(0o077);
import { writeFileSync } from 'node:fs';
import { PrismaClient, type Prisma } from '@prisma/client';
import { InMemoryBudgetStoreAdapter } from '@global/test-support';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  buildEvidenceBundle,
  type EvidenceBundle,
} from '../src/discovery/evidence-bundle';
import { evaluateCorroboration } from '../src/discovery/judgment/corroboration';
import { DiscoveryProviderRegistry } from '../src/discovery/provider.registry';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';

interface Args {
  apply: boolean;
  country: string | null;
  limit: number;
  domains: string[] | null;
  ids: string[] | null;
  workspace: string | null;
  reportPath: string | null;
}

function parseArgs(argv: string[]): Args {
  const one = (name: string): string | null =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const limit = Number.parseInt(one('limit') ?? '10', 10);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit 必须是正整数');
  const domains = one('domains')
    ?.split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean) ?? null;
  const ids = one('ids')?.split(',').map((id) => id.trim()).filter(Boolean) ?? null;
  return {
    apply: argv.includes('--apply'),
    // 默认 DE（今晚德国优先）；显式给了 domains/ids 时不再叠加国家过滤。
    country: one('country') ?? (domains || ids ? null : 'DE'),
    limit,
    domains,
    ids,
    workspace: one('workspace'),
    reportPath: one('report'),
  };
}

interface CompanyReport {
  id: string;
  name: string;
  domain: string | null;
  probed: string[];
  probeErrors: Record<string, string>;
  coverage: EvidenceBundle['coverage'];
  entrySources: string[];
  written: boolean;
  latestVerdict: string | null;
  corroboration: ReturnType<typeof evaluateCorroboration> | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  // 双连接：owner 跨租户扫描/写（预期绕过 RLS）；PrismaService(app_user) 供 Broker 的
  // source_policy 与 data_provider 路由（平台表，app_user 只读）。预算账本用 test-support
  // 内存实现（与 2026-11-08 源启用真测同纪律：不写预算表、不建预算账户）。
  const prisma = new PrismaClient();
  const appPrisma = new PrismaService();
  await appPrisma.$connect();
  const broker = buildToolBroker({
    budgetStore: new InMemoryBudgetStoreAdapter(),
    sourcePolicyReader: sourcePolicyReaderFrom(appPrisma),
  });
  const registry = new DiscoveryProviderRegistry({ broker, prisma: appPrisma as never });

  const rawCompanies = await prisma.canonicalCompany.findMany({
    where: {
      status: { not: 'SUPPRESSED' },
      domain: args.domains ? { in: args.domains } : { not: null },
      ...(args.ids ? { id: { in: args.ids } } : {}),
      ...(args.country ? { country: args.country } : {}),
      ...(args.workspace ? { workspaceId: args.workspace } : {}),
    },
    select: {
      id: true,
      workspaceId: true,
      name: true,
      domain: true,
      country: true,
      region: true,
      attributes: true,
      version: true,
    },
    orderBy: { id: 'asc' },
    // 同一域名常跨工作区多行：多取再按域名去重，每域只建一份包（样本口径可复现）。
    take: args.limit * 8,
  });
  const seenDomains = new Set<string>();
  const companies = rawCompanies
    .filter((row) => {
      const key = (row.domain ?? '').toLowerCase();
      if (!key || seenDomains.has(key)) return false;
      seenDomains.add(key);
      return true;
    })
    .slice(0, args.limit);
  console.log(`模式 ${args.apply ? 'APPLY' : 'dry-run'}；选中 ${companies.length} 家公司（country=${args.country ?? '不限'}）`);

  const reports: CompanyReport[] = [];
  for (const company of companies) {
    const enrichers = await registry.routeEnrichment(appPrisma as never);
    const { bundle, probed, errors } = await buildEvidenceBundle({
      subject: {
        name: company.name,
        ...(company.domain ? { domain: company.domain } : {}),
        ...(company.country ? { country: company.country } : {}),
        ...(company.region ? { region: company.region } : {}),
      },
      attributes: company.attributes,
      enrichers,
      // CLI 直跑：无平台主体绑定；出网治理仍由 Broker（source_policy/预算/限流）单点强制。
      ctx: { workspaceId: company.workspaceId },
    });
    const report: CompanyReport = {
      id: company.id,
      name: company.name,
      domain: company.domain,
      probed,
      probeErrors: errors,
      coverage: bundle.coverage,
      entrySources: bundle.entries.map((entry) => `${entry.tier}:${entry.source_key}`),
      written: false,
      latestVerdict: null,
      corroboration: null,
    };
    // 判定链 shadow 样例：最近一条判定记录的 verdict 跑同一评估器。
    const latestJudgment = await prisma.judgmentRecord.findFirst({
      where: { workspaceId: company.workspaceId, canonicalCompanyId: company.id },
      orderBy: { createdAt: 'desc' },
      select: { verdict: true },
    });
    if (latestJudgment) {
      report.latestVerdict = latestJudgment.verdict;
      report.corroboration = evaluateCorroboration({ verdict: latestJudgment.verdict, bundle, mode: 'shadow' });
    }
    if (args.apply) {
      const attributes = (company.attributes ?? {}) as Record<string, unknown>;
      // 版本号护栏：并发公司合并会 increment version；版本不符时跳过（下次跑再建）。
      const result = await prisma.canonicalCompany.updateMany({
        where: { id: company.id, version: company.version },
        data: { attributes: { ...attributes, evidence_bundle: bundle } as Prisma.InputJsonValue },
      });
      report.written = result.count === 1;
      if (result.count !== 1) console.warn(`  ${company.domain ?? company.id}: 版本冲突，跳过写入`);
    }
    reports.push(report);
    const corroborationText = report.corroboration
      ? ` verdict=${report.latestVerdict} corroboration=${report.corroboration.reason}`
      : '';
    console.log(
      `${company.domain ?? company.id}: tiers=[${bundle.coverage.tier_list.join(',')}] ` +
        `sources=${report.entrySources.join(' ')}` +
        (probed.length ? ` probed=${probed.join(',')}` : '') +
        (Object.keys(errors).length ? ` errors=${JSON.stringify(errors)}` : '') +
        corroborationText +
        (args.apply ? ` written=${report.written}` : ''),
    );
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? 'apply' : 'dry-run',
    companies: reports.length,
    withBundle: reports.filter((report) => report.entrySources.length > 0).length,
    corroborated: reports.filter((report) => report.coverage.corroborated).length,
    tierDistribution: reports.reduce<Record<string, number>>((acc, report) => {
      const key = report.coverage.tier_list.join('+') || 'none';
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {}),
    judgmentsEvaluated: reports.filter((report) => report.corroboration !== null).length,
    judgmentsCorroborated: reports.filter((report) => report.corroboration?.corroborated === true).length,
    written: reports.filter((report) => report.written).length,
  };
  console.log('\nSUMMARY ' + JSON.stringify(summary));
  if (args.reportPath) {
    writeFileSync(args.reportPath, JSON.stringify({ summary, reports }, null, 2) + '\n', { mode: 0o600 });
    console.log(`报告已写入 ${args.reportPath}`);
  }
  await prisma.$disconnect();
  await appPrisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
