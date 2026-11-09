/**
 * Golden ICP 评测（骨架，2026-11-10，多源证据图核心切片 ⑤）。
 *
 * 读 docs/eval/golden-icp/queries.yaml（人工标注的 ICP 查询），对每条查询从 dev 库
 * canonical_company 取候选（按目标市场过滤），用确定性排序器打分取 top-K，输出
 * precision@K / recall / 排除域误入；未标注查询只出候选预览。
 *
 * 运行（apps/api 下，.env 已链接；owner 连接跨租户，预期）：
 *   node --import tsx scripts/evaluate-golden-icp.mts
 *   node --import tsx scripts/evaluate-golden-icp.mts --k=5 --report=/tmp/golden-icp.json
 */
import 'dotenv/config';
process.umask(0o077);
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@prisma/client';
import {
  parseGoldenIcpYaml,
  precisionAtK,
  rankGoldenCandidates,
  targetMarketIsos,
  type GoldenCandidate,
  type PrecisionResult,
} from '../src/eval/golden-icp';
import { normalizeCountryValue } from '../src/discovery/company-normalization';

const defaultQueriesPath = fileURLToPath(
  new URL('../../../docs/eval/golden-icp/queries.yaml', import.meta.url),
);

function parseArgs(argv: string[]): { queriesPath: string; k: number; workspace: string | null; reportPath: string | null; candidateLimit: number } {
  const one = (name: string): string | null =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const k = Number.parseInt(one('k') ?? '10', 10);
  if (!Number.isInteger(k) || k < 1 || k > 50) throw new Error('--k 必须是 1..50 的整数');
  const candidateLimit = Number.parseInt(one('candidate-limit') ?? '2000', 10);
  if (!Number.isInteger(candidateLimit) || candidateLimit < 1) throw new Error('--candidate-limit 必须是正整数');
  return {
    queriesPath: one('queries') ?? defaultQueriesPath,
    k,
    workspace: one('workspace'),
    reportPath: one('report'),
    candidateLimit,
  };
}

interface QueryReport {
  queryId: string;
  icp: string;
  labeled: boolean;
  candidateCount: number;
  result: PrecisionResult;
  topMatches: Array<{ domain: string; name: string; score: number; matches: string[] }>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const set = parseGoldenIcpYaml(readFileSync(args.queriesPath, 'utf8'));
  const prisma = new PrismaClient();
  console.log(`评测集 ${args.queriesPath}（${set.queries.length} 条查询，k=${args.k}）`);

  const reports: QueryReport[] = [];
  for (const query of set.queries) {
    const isos = targetMarketIsos(query.targetMarkets);
    const rows = await prisma.canonicalCompany.findMany({
      where: {
        status: { not: 'SUPPRESSED' },
        domain: { not: null },
        ...(args.workspace ? { workspaceId: args.workspace } : {}),
        ...(isos.length > 0
          ? {
              OR: [
                { country: { in: isos } },
                // 未归一的自由文本变体（如「德国」）：按目标市场原词粗取；拉丁语系变体
                // （Deutschland/germany）依赖既有回填归一后才进入池子——本评测以归一后的数据为准。
                { country: { in: query.targetMarkets } },
              ],
            }
          : {}),
      },
      select: { domain: true, name: true, country: true, industry: true, attributes: true },
      orderBy: { id: 'asc' },
      take: args.candidateLimit,
    });
    // 候选按域名去重（同域跨工作区多行）；排除 RFC 2606 占位域（.example 是测试合成数据）。
    const seen = new Set<string>();
    const candidates: GoldenCandidate[] = rows
      .filter((row) => row.domain !== null && !row.domain.toLowerCase().endsWith('.example'))
      .filter((row) => {
        const key = row.domain!.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((row) => {
        const attributes = (row.attributes ?? {}) as Record<string, unknown>;
        const stringList = (value: unknown): string[] =>
          Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
        return {
          domain: row.domain!,
          name: row.name,
          country: row.country ? normalizeCountryValue(row.country) : null,
          industry: row.industry,
          keywords: stringList(attributes.keywords),
          products: stringList(attributes.products),
          hasWebsiteProfile: attributes.website_profile !== undefined,
        };
      });
    const ranked = rankGoldenCandidates(query, candidates);
    const result = precisionAtK(query, ranked, args.k);
    reports.push({
      queryId: query.id,
      icp: query.icp,
      labeled: result.labeled,
      candidateCount: candidates.length,
      result,
      topMatches: ranked.slice(0, args.k).map((candidate) => ({
        domain: candidate.domain,
        name: candidate.name,
        score: candidate.score,
        matches: candidate.matches,
      })),
    });
    console.log(
      `${result.labeled ? '★' : '·'} ${query.id}: 候选 ${candidates.length}，` +
        (result.labeled
          ? `P@${args.k}=${result.precisionAtK} recall=${result.recall} 命中=${result.hits.join(',') || '无'}` +
            (result.excludedInTopK.length ? ` 排除域误入=${result.excludedInTopK.join(',')}` : '')
          : `未标注，top-${args.k}=${result.topK.slice(0, 5).join(',')}…`),
    );
  }

  const labeled = reports.filter((report) => report.labeled);
  const summary = {
    generatedAt: new Date().toISOString(),
    queriesPath: args.queriesPath,
    k: args.k,
    total: reports.length,
    labeled: labeled.length,
    meanPrecisionAtK: labeled.length
      ? Number((labeled.reduce((sum, report) => sum + report.result.precisionAtK, 0) / labeled.length).toFixed(4))
      : 0,
    meanRecall: labeled.length
      ? Number((labeled.reduce((sum, report) => sum + report.result.recall, 0) / labeled.length).toFixed(4))
      : 0,
    excludedIntrusions: labeled.reduce((sum, report) => sum + report.result.excludedInTopK.length, 0),
  };
  console.log('\nSUMMARY ' + JSON.stringify(summary));
  if (args.reportPath) {
    writeFileSync(args.reportPath, JSON.stringify({ summary, reports }, null, 2) + '\n', { mode: 0o600 });
    console.log(`报告已写入 ${args.reportPath}`);
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
