/**
 * 决策人邮箱猜测（选项 B · P0）真数据实测 —— 真库真爬真 MX/SMTP，无 sandbox。
 * 链路：searxng 发现德国泵企官网 → crawl4ai 抽真决策人 → 对**无公开邮箱**的人跑 EmailGuesser
 *       （模式排列 + 若站上有一个具名邮箱则学格式）→ 经 ToolBroker 真 SMTP 验证 → 诚实裁决。
 *   node --import tsx scripts/verify-email-guess.mts
 *
 * ⚠️ 诚实预期：若当前网络封锁出站 TCP/25，多数真域 SMTP 不可达，猜测必须
 *    降级 unverified（unreachable），不谎报 VALID。只有明确放行 25 出网并完成真握手时才可能命中 VALID。
 */
import { readFileSync } from 'node:fs';
import { PrismaService } from '../src/prisma/prisma.service';
import { DecisionMakerProvider } from '../src/discovery/providers/decision-maker.provider';
import { SelfHostedEmailVerifier } from '../src/discovery/providers/email-verify.provider';
import { EmailGuesser } from '../src/discovery/email-guesser';
import { generateEmailCandidates } from '../src/discovery/email-permutation';
import { ModelProviderRegistry } from '../src/model-gateway/model-provider.registry';
import { ModelRouter } from '../src/model-gateway/model-router';
import { RouterModelGateway } from '../src/model-gateway/router-model-gateway';
import { StubModelProvider } from '../src/model-gateway/providers/stub-model.provider';
import { buildGatewayProvider, stubAllowed } from '../src/model-gateway/model-providers.config';
import { AiTraceSink } from '../src/model-gateway/ai-trace.sink';
import { buildToolBroker, sourcePolicyReaderFrom } from '../src/tools/tool-broker.factory';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trimStart().startsWith('#')) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, '');
}
process.env.DATABASE_URL ??= 'postgresql://global:global@localhost:5432/global_dev';
process.env.APP_DATABASE_URL ??= 'postgresql://app_user:app_pw@localhost:5432/global_dev';

const SEARXNG = process.env.SEARXNG_URL ?? 'http://localhost:8081';
const NON_COMPANY = /(wikipedia|linkedin|facebook|youtube|twitter|x\.com|instagram|xing|kompass|europages|wlw\.|thomasnet|amazon|indeed|glassdoor|yelp|crunchbase|bloomberg|dnb\.com|northdata)/i;

async function discoverViaSearxng(query: string, want: number): Promise<{ domain: string; name: string }[]> {
  const res = await fetch(`${SEARXNG}/search?q=${encodeURIComponent(query)}&format=json`);
  const data = (await res.json()) as { results?: { url: string; title: string }[] };
  const seen = new Set<string>();
  const out: { domain: string; name: string }[] = [];
  for (const r of data.results ?? []) {
    let host: string;
    try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch { continue; }
    if (NON_COMPANY.test(host) || seen.has(host) || !host.endsWith('.de')) continue;
    seen.add(host);
    out.push({ domain: host, name: (r.title || host).split(/[|\-–—:]/)[0].trim().slice(0, 40) });
    if (out.length >= want) break;
  }
  return out;
}

const prisma = new PrismaService();
await prisma.$connect();
const dash = (n = 80) => console.log('─'.repeat(n));

async function main() {
  const reg = new ModelProviderRegistry();
  const gp = buildGatewayProvider();
  if (gp) reg.register(gp);
  if (stubAllowed()) reg.register(new StubModelProvider());
  const gateway = new RouterModelGateway(new ModelRouter(reg), new AiTraceSink(prisma));
  const broker = buildToolBroker({ sourcePolicyReader: sourcePolicyReaderFrom(prisma) });
  const dmProvider = new DecisionMakerProvider({ gateway });
  const verifier = new SelfHostedEmailVerifier(broker);
  const guesser = new EmailGuesser(verifier);

  // 探测人名邮箱需 lawful-basis（GDPR）。实测用一条显式 LIA 引用放行（生产逐条 LIA）。
  const LIA = { basis: 'legitimate_interest' as const, ref: 'DEMO-LIA-pump-outreach' };

  console.log('\n█ 选项 B · P0：把「有名字没邮箱」变成「有可用邮箱」——真数据端到端');
  console.log('█ searxng 发现 → crawl4ai 抽决策人 → 排列/格式学习 → ToolBroker 真 SMTP 验证\n');

  const QUERY = 'Pumpenhersteller Deutschland Impressum Geschäftsführer';
  console.log(`▶ searxng 搜索：「${QUERY}」`);
  const targets = await discoverViaSearxng(QUERY, 2);
  console.log(`  → 过滤出 ${targets.length} 家候选官网：${targets.map((t) => t.domain).join('  ')}\n`);
  if (!targets.length) { console.log('  searxng 本次无可用官网（引擎抖动），可重试'); return; }

  for (const t of targets) {
    dash();
    console.log(`■ ${t.name}  (${t.domain})`);
    let people: Awaited<ReturnType<typeof dmProvider.findDecisionMakers>> = [];
    try {
      people = await dmProvider.findDecisionMakers({ domain: t.domain, name: t.name }, {
        seller: 'Chinese pump manufacturer going global',
        offering: 'pumps, pump components',
        target_roles: ['managing director', 'procurement', 'purchasing', 'engineering', 'sales'],
      });
    } catch (e) { console.log(`  决策人抽取失败：${(e as Error).message.slice(0, 60)}`); continue; }

    if (!people.length) { console.log('  本次未从官网抽到具名决策人（robots/无团队页）'); continue; }
    const withEmail = people.filter((p) => p.email);
    const withoutEmail = people.filter((p) => !p.email);
    console.log(`  抽到 ${people.length} 位具名人：${withEmail.length} 位页面已带邮箱，${withoutEmail.length} 位缺邮箱（正是要补的）`);

    // 站上已有的具名邮箱 = 格式学习样本
    const samples = withEmail
      .filter((p) => p.email && p.email.split('@')[1]?.toLowerCase() === t.domain)
      .map((p) => ({ fullName: p.fullName, email: p.email! }));
    if (samples.length) console.log(`  📚 格式学习样本 ${samples.length} 条（如 ${samples[0].email}）`);

    // 对缺邮箱的决策人补全（最多 3 位，控成本/耗时）
    for (const p of (withoutEmail.length ? withoutEmail : people).slice(0, 3)) {
      const cand = generateEmailCandidates(p.fullName, t.domain).slice(0, 5).map((c) => c.email);
      console.log(`\n   👤 ${p.fullName}${p.title ? `  —  ${p.title}` : ''}  🔴个人数据`);
      console.log(`      排列候选(top5)：${cand.join('  ')}`);
      const r = await guesser.guess(
        { fullName: p.fullName, domain: t.domain, knownSamples: samples },
        { lawfulBasis: LIA, workspaceId: 'platform', maxProbe: 6 },
      );
      const b = r.best ? `${r.best.email}  [${r.best.pattern}]  置信${r.best.confidence}  SMTP:${r.best.verdict.status}${r.best.verdict.detail ? `(${r.best.verdict.detail})` : ''}` : '—';
      console.log(`      → 结果[${r.status}]${r.domainFact ? `·${r.domainFact}` : ''}  探测${r.triedCount}个  最优：${b}`);
    }
  }
  dash();
  console.log('\n█ 说明：');
  console.log('█  · 候选按 B2B 命名法先验排序，有站内样本则先学格式（命中率更高）');
  console.log('█  · SMTP 出网全经 ToolBroker（source_policy/预算/限流/幂等/Trace）；人名邮箱过 lawful-basis 门');
  console.log('█  · Mac 端口25 常封 → 多数域 unverified(unreachable)，诚实不谎报 VALID；VALID 命中需放行25的环境');
}

try { await main(); } finally { await prisma.$disconnect(); }
