/**
 * 电话 / LinkedIn 补全 CLI（2026-11-10，多源证据图核心切片 ④）。
 *
 * 对指定公司集合跑「官网 + Impressum/联系页」抓取，抽取并落库：
 *  - phone / form_url → company_contact_channel（A4 公司级渠道层，A1 装配器）；
 *  - linkedin_company_page → company_contact_point（BI-14 写入器，provider_key=company_contact）。
 * 邮箱**不进本管线**（邮箱走联系人/公司渠道既有链路）。
 *
 * 抓取纪律与 impressum-evidence.mts 相同：robots 先检；crawl4ai render 原始 HTML /
 * markdown 双端点；单页/单公司失败可容忍并计入报告。
 *
 * 运行（apps/api 下，.env 已链接；连 owner 库，跨租户是预期）：
 *   node --import tsx scripts/complete-contact-channels.mts --domains=a.de,b.de            # dry-run
 *   node --import tsx scripts/complete-contact-channels.mts --country=DE --limit=20 --apply
 *   node --import tsx scripts/complete-contact-channels.mts --domains=... --report=/tmp/x.json
 */
import 'dotenv/config';
process.umask(0o077);
import { writeFileSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { crawlHtml, crawlUrl } from '../src/adapters/web-crawler';
import { extractSameSiteLinks } from '../src/adapters/site-links';
import { isAllowedByRobots } from '../src/adapters/robots';
import { legalPageCandidates } from '../src/discovery/impressum/find-legal-pages';
import type { ImpressumPage } from '../src/discovery/impressum/collect-company-channels';
import { stripHtml } from '../src/discovery/impressum/impressum-extract';
import { planContactCompletion } from '../src/discovery/contact-completion';
import { upsertCompanyContactChannels } from '../src/discovery/company-contact-channel';
import {
  persistCompanyContactPoints,
  type CompanyContactObservation,
} from '../src/discovery/company-contact-points';
import { companyMatchesSuppression } from '../src/discovery/suppression-value';

interface Args {
  apply: boolean;
  country: string | null;
  limit: number;
  domains: string[] | null;
  ids: string[] | null;
  workspace: string | null;
  reportPath: string | null;
  delayMs: number;
}

function parseArgs(argv: string[]): Args {
  const one = (name: string): string | null =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;
  const limit = Number.parseInt(one('limit') ?? '20', 10);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit 必须是正整数');
  const domains = one('domains')
    ?.split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean) ?? null;
  const ids = one('ids')?.split(',').map((id) => id.trim()).filter(Boolean) ?? null;
  const delayMs = Number.parseInt(one('delay-ms') ?? '1000', 10);
  if (!Number.isInteger(delayMs) || delayMs < 0) throw new Error('--delay-ms 必须是非负整数');
  return {
    apply: argv.includes('--apply'),
    country: one('country') ?? (domains ? null : 'DE'),
    limit,
    domains,
    ids,
    workspace: one('workspace'),
    reportPath: one('report'),
    delayMs,
  };
}

const authorize = async () => true;

function sameHostLinks(html: string, baseUrl: string): string[] {
  const base = new URL(baseUrl);
  const baseHost = base.hostname.replace(/^www\./u, '');
  const out = new Set<string>();
  for (const match of html.matchAll(/href=["']([^"'#]+)["']/giu)) {
    try {
      const url = new URL(match[1]!, base);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') continue;
      if (url.hostname.replace(/^www\./u, '') !== baseHost) continue;
      url.hash = '';
      url.search = '';
      out.add(url.toString());
    } catch {
      // 坏 href 跳过
    }
  }
  return [...out];
}

/** 抓首页 markdown（findContactPaths 的输入）与站点内链接（法定页候选）。 */
async function crawlHomepage(base: string): Promise<{ markdown: string; links: string[] }> {
  let markdown = '';
  let links: string[] = [];
  try {
    const md = await crawlUrl(base, authorize);
    markdown = md.text.slice(0, 80_000);
    links = extractSameSiteLinks(md.text, base);
  } catch {
    // markdown 端点失败 → 用渲染 HTML 兜底链接（LinkedIn 解析需要 markdown，缺失时 linkedin 为空）
  }
  if (links.length === 0) {
    try {
      const rendered = await crawlHtml(base, authorize);
      links = [...new Set([...links, ...sameHostLinks(rendered.html, base)])];
    } catch {
      // 两端都失败：交给调用方记录错误
    }
  }
  return { markdown, links };
}

/** 抓法定页（Impressum/Kontakt），镜像 impressum-evidence.mts 的抓取纪律。 */
async function crawlLegalPages(base: string, homeLinks: string[]): Promise<ImpressumPage[]> {
  const pages: ImpressumPage[] = [];
  for (const candidate of legalPageCandidates(base, homeLinks, { maxPages: 5 })) {
    try {
      if (!(await isAllowedByRobots(candidate.url, { authorizeExternalAction: authorize }))) continue;
      try {
        const rendered = await crawlHtml(candidate.url, authorize);
        const text = stripHtml(rendered.html);
        if (text.trim()) {
          pages.push({ url: candidate.url, kind: candidate.kind, html: rendered.html, text });
          continue;
        }
      } catch {
        // 渲染失败/响应过大 → markdown 端点兜底
      }
      const md = await crawlUrl(candidate.url, authorize);
      const text = md.text.slice(0, 40_000);
      if (text.trim()) pages.push({ url: candidate.url, kind: candidate.kind, text });
    } catch {
      // 单页失败可容忍
    }
  }
  return pages;
}

interface CompanyResult {
  id: string;
  name: string;
  domain: string;
  workspaceId: string;
  robotsAllowed: boolean;
  pagesFetched: number;
  phones: string[];
  formUrls: string[];
  linkedin: string | null;
  writtenChannels: number;
  writtenPoints: number;
  skippedSuppressed: boolean;
  error: string | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  const where = {
    status: { not: 'SUPPRESSED' },
    domain: args.domains ? { in: args.domains } : { not: null },
    ...(args.ids ? { id: { in: args.ids } } : {}),
    ...(args.country ? { country: args.country } : {}),
    ...(args.workspace ? { workspaceId: args.workspace } : {}),
  };
  const rawCompanies = await prisma.canonicalCompany.findMany({
    where,
    select: { id: true, name: true, domain: true, country: true, workspaceId: true },
    orderBy: { id: 'asc' },
    // 同一域名常跨工作区多行（dev 实测 ksb.com ×6）：多取再按域名去重，每域只补一次。
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
  console.log(
    `模式 ${args.apply ? 'APPLY' : 'dry-run'}；选中 ${companies.length} 家公司` +
      `（country=${args.country ?? '不限'} domains=${args.domains?.length ?? 0} 个）`,
  );

  const results: CompanyResult[] = [];
  for (const company of companies) {
    const domain = (company.domain ?? '').toLowerCase().replace(/^www\./u, '');
    const base = `https://${domain}/`;
    const rec: CompanyResult = {
      id: company.id,
      name: company.name,
      domain,
      workspaceId: company.workspaceId,
      robotsAllowed: false,
      pagesFetched: 0,
      phones: [],
      formUrls: [],
      linkedin: null,
      writtenChannels: 0,
      writtenPoints: 0,
      skippedSuppressed: false,
      error: null,
    };
    try {
      rec.robotsAllowed = await isAllowedByRobots(base, { authorizeExternalAction: authorize });
      if (!rec.robotsAllowed) {
        results.push(rec);
        continue;
      }
      const home = await crawlHomepage(base);
      const pages = await crawlLegalPages(base, home.links);
      rec.pagesFetched = pages.length;
      const plan = planContactCompletion({
        domain,
        country: company.country,
        homeMarkdown: home.markdown,
        pages,
      });
      rec.phones = plan.channels.filter((c) => c.channel === 'phone').map((c) => c.value);
      rec.formUrls = plan.channels.filter((c) => c.channel === 'form_url').map((c) => c.value);
      rec.linkedin = plan.linkedinCompanyPage;

      if (args.apply) {
        const suppressions = await prisma.suppressionRecord.findMany({
          where: { workspaceId: company.workspaceId, type: { in: ['domain', 'company_name'] } },
          select: { type: true, value: true },
        });
        if (companyMatchesSuppression(suppressions, company)) {
          rec.skippedSuppressed = true;
        } else {
          const observation: CompanyContactObservation = {
            points: plan.linkedinCompanyPage
              ? [{ kind: 'linkedin_company_page', value: plan.linkedinCompanyPage, sourceKind: 'homepage' }]
              : [],
            // 移除语义属于 website-profile provider 的全量观察；本管线只补不删。
            checkedKinds: [],
          };
          const seenAt = new Date();
          await prisma.$transaction(async (tx) => {
            if (plan.channels.length > 0) {
              const written = await upsertCompanyContactChannels(tx, {
                workspaceId: company.workspaceId,
                companyId: company.id,
                channels: plan.channels,
                seenAt,
              });
              rec.writtenChannels = written.written;
            }
            if (observation.points.length > 0) {
              const persisted = await persistCompanyContactPoints(tx, {
                workspaceId: company.workspaceId,
                companyId: company.id,
                observation,
                seenAt,
              });
              rec.writtenPoints = persisted?.written ?? 0;
            }
          });
        }
      }
    } catch (error) {
      rec.error = (error instanceof Error ? error.message : String(error)).slice(0, 160);
    }
    results.push(rec);
    console.log(
      `${domain}: robots=${rec.robotsAllowed} pages=${rec.pagesFetched} ` +
        `phones=${rec.phones.length} linkedin=${rec.linkedin ? 'yes' : 'no'}` +
        (args.apply ? ` written=${rec.writtenChannels}+${rec.writtenPoints}` : '') +
        (rec.skippedSuppressed ? ' (suppressed)' : '') +
        (rec.error ? ` err=${rec.error}` : ''),
    );
    if (args.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, args.delayMs));
  }

  const fetched = results.filter((r) => r.pagesFetched > 0 || r.linkedin !== null);
  const summary = {
    generatedAt: new Date().toISOString(),
    mode: args.apply ? 'apply' : 'dry-run',
    criterion: 'companies with >=1 phone OR >=1 linkedin company page, over companies with a fetched site',
    sampleSize: results.length,
    robotsDisallowed: results.filter((r) => !r.robotsAllowed).length,
    siteFetched: fetched.length,
    withPhone: fetched.filter((r) => r.phones.length > 0).length,
    withLinkedin: fetched.filter((r) => r.linkedin !== null).length,
    withPhoneOrLinkedin: fetched.filter((r) => r.phones.length > 0 || r.linkedin !== null).length,
    writtenChannels: results.reduce((sum, r) => sum + r.writtenChannels, 0),
    writtenPoints: results.reduce((sum, r) => sum + r.writtenPoints, 0),
    errors: results.filter((r) => r.error !== null).length,
  };
  console.log('\nSUMMARY ' + JSON.stringify(summary));
  if (args.reportPath) {
    writeFileSync(args.reportPath, JSON.stringify({ summary, results }, null, 2) + '\n', {
      mode: 0o600,
    });
    console.log(`报告已写入 ${args.reportPath}`);
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
