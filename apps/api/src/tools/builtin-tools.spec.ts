import { describe, expect, it } from 'vitest';
import { ToolRegistry } from './tool-registry';
import {
  registerBuiltinTools,
  searxngSearchTool,
  crawl4aiFetchTool,
  smtpRcptProbeTool,
  SmtpProbeInput,
  SmtpProbeOutput,
} from './builtin-tools';
import { ToolBroker, ToolPolicyDenied } from './tool-broker';
import { BudgetLedger } from './budget';
import { RateLimiter } from './rate-limiter';
import type { ToolResult } from './tool-contract';

function broker(sourcePolicyReader?: (d: string) => Promise<{ suspended: boolean; allowedPurpose?: string[] } | null>) {
  const registry = registerBuiltinTools(new ToolRegistry());
  return new ToolBroker({
    registry,
    budget: new BudgetLedger(),
    limiter: new RateLimiter(),
    sourcePolicyReader,
    traceRecorder: () => {},
    now: () => 1_000_000,
  });
}

/**
 * M1-b fast-follow 改动 4：品牌研究（site_builder.brand_profile）借 searxng/crawl4ai 出网，
 * 需以 purpose=['site_builder'] 调用。crawl4ai 是 advisory 门（effective = 调用purpose ∩ 工具allowedPurpose，
 * 空集即拒），故必须声明 site_builder；searxng 是 none（短路放行），加是语义一致/前瞻。
 */
describe('site_builder 用途门 · searxng/crawl4ai allowedPurpose', () => {
  it('paid replay drops search titles, snippets, paths and query PII', () => {
    const replay = searxngSearchTool.durableReplayResult?.({
      data: {
        results: [
          {
            title: 'Jane Smith appointed CEO',
            content: 'Contact jane@example.com',
            url: 'https://news.example/people/jane-smith?author=Jane+Smith',
          },
        ],
      },
      costCents: 0,
    } as ToolResult<{ results: never[] }>);

    expect(replay).toEqual({
      data: { results: [{ url: 'https://news.example/' }] },
      costCents: 0,
    });
    expect(JSON.stringify(replay)).not.toMatch(/Jane|CEO|jane@example|people/i);
  });

  it('paid replay applies the Evidence 2.0 scrubber to storefront payloads', () => {
    const replay = crawl4aiFetchTool.durableReplayResult?.({
      data: {
        url: 'https://sales:secret@acme.example/about?email=jane@example.com#team',
        text: 'Call +49 30 1234567 or email jane@example.com for pumps.',
        contentHash: 'raw-hash',
      },
      costCents: 1,
      provenance: {
        sourceUrl:
          'https://sales:secret@acme.example/about?email=jane@example.com#team',
        fetchedAt: '2026-07-19T00:00:00.000Z',
        contentHash: 'raw-hash',
        parserVersion: 'crawl4ai/1',
      },
    });

    expect(replay?.data.text).toContain('[redacted-email]');
    expect(replay?.data.text).toContain('[redacted-phone]');
    expect(JSON.stringify(replay)).not.toMatch(
      /sales:secret|jane@example|\+49 30 1234567|#team/,
    );
  });

  it('searxng.search.allowedPurpose 含 site_builder（与 discovery 并列）', () => {
    expect(searxngSearchTool.compliance.allowedPurpose).toEqual(['discovery', 'site_builder']);
  });

  it('crawl4ai.fetch.allowedPurpose 含 site_builder（advisory 门功能必需）', () => {
    expect(crawl4aiFetchTool.compliance.allowedPurpose).toEqual([
      'discovery',
      'enrichment',
      'site_builder',
    ]);
  });

  it('crawl4ai advisory：purpose=[site_builder] 且域策略允许 site_builder → 放行（不误拒）', async () => {
    const b = broker(async () => ({ suspended: false, allowedPurpose: ['site_builder'] }));
    const chk = await b.checkSourcePolicy('crawl4ai.fetch', 'acme.example', ['site_builder']);
    expect(chk.allowed).toBe(true);
  });

  it('crawl4ai advisory：purpose=[site_builder] 但工具未声明会拒——声明后不再拒（回归守卫）', async () => {
    const b = broker(async () => null); // 未登记域，advisory 放行；用途门只看工具声明集
    const chk = await b.checkSourcePolicy('crawl4ai.fetch', 'acme.example', ['site_builder']);
    expect(chk.allowed).toBe(true); // 工具已声明 site_builder → 交集非空 → 放行
  });
});

/**
 * FIX C（Codex P1）：把 site_builder 加进共享 crawl4ai.fetch.allowedPurpose 后，**不带 purpose**
 * 的既有调用者会 fallback 到扩宽全集，令仅授权 site_builder 的域连带放行发现/富集抓取。调用者显式声明
 * purpose:['discovery','enrichment'] 关闭此扩宽（effective = 调用purpose ∩ 工具allowedPurpose）。
 * 本组是「扩宽已关闭」的语义护栏 + 「品牌研究不受影响」「[discovery] 域行为不变」的回归守卫。
 */
describe('crawl4ai 用途扩宽已关闭 · 显式 [discovery,enrichment] 用途（FIX C）', () => {
  it('purpose=[discovery,enrichment] 对仅 site_builder 域策略 → DENIED（扩宽已关闭）', async () => {
    const b = broker(async () => ({ suspended: false, allowedPurpose: ['site_builder'] }));
    const chk = await b.checkSourcePolicy('crawl4ai.fetch', 'acme.example', ['discovery', 'enrichment']);
    expect(chk.allowed).toBe(false);
    expect(chk.reason).toBe('purpose_not_allowed');
  });

  it('purpose=[site_builder] 对同域仍放行（品牌研究不受影响）', async () => {
    const b = broker(async () => ({ suspended: false, allowedPurpose: ['site_builder'] }));
    const chk = await b.checkSourcePolicy('crawl4ai.fetch', 'acme.example', ['site_builder']);
    expect(chk.allowed).toBe(true);
  });

  it('purpose=[discovery,enrichment] 对 [discovery] 域策略仍放行（行为保持）', async () => {
    const b = broker(async () => ({ suspended: false, allowedPurpose: ['discovery'] }));
    const chk = await b.checkSourcePolicy('crawl4ai.fetch', 'acme.example', ['discovery', 'enrichment']);
    expect(chk.allowed).toBe(true);
  });
});

describe('smtp.rcpt_probe 工具 · 经 ToolBroker 闸门', () => {
  it('已注册为 verify/email_verification，sourcePolicy=advisory + personalData（登记即强制、标个人数据）', () => {
    expect(smtpRcptProbeTool.id).toBe('smtp.rcpt_probe');
    expect(smtpRcptProbeTool.category).toBe('verify');
    expect(smtpRcptProbeTool.sourceClass).toBe('email_verification');
    // advisory：标的=任意公司邮箱域，未登记放行（required 会杀死邮箱验证）；登记即强制 SUSPENDED/用途门
    expect(smtpRcptProbeTool.compliance.sourcePolicy).toBe('advisory');
    expect(smtpRcptProbeTool.compliance.personalData).toBe(true); // rcptTo 可含具名人邮箱
    expect(registerBuiltinTools(new ToolRegistry()).get('smtp.rcpt_probe')).toBeDefined();
  });

  it('SUSPENDED 域名：Broker 在 execute 前拒绝出网（source_policy 门，按 input.domain 判）', async () => {
    const b = broker(async (d) => ({ suspended: d === 'blocked.de' }));
    const input: SmtpProbeInput = { domain: 'blocked.de', mxHost: '127.0.0.1', rcptTo: ['a@blocked.de'] };
    await expect(b.invoke('smtp.rcpt_probe', input, { workspaceId: 'w' })).rejects.toThrow(ToolPolicyDenied);
    await expect(b.invoke('smtp.rcpt_probe', input, { workspaceId: 'w' })).rejects.toThrow(/SUSPENDED/);
  });

  it('用途门：域策略 allowedPurpose 与工具 [discovery,enrichment] 无交集 → execute 前拒绝', async () => {
    const b = broker(async () => ({ suspended: false, allowedPurpose: ['news_only'] }));
    const input: SmtpProbeInput = { domain: 'acme.de', mxHost: '127.0.0.1', rcptTo: ['a@acme.de'] };
    await expect(b.invoke('smtp.rcpt_probe', input, { workspaceId: 'w' })).rejects.toThrow(/purpose not allowed/);
  });

  it('用途门：域策略 allowedPurpose=[discovery] 与工具有交集 → 放行到 execute（不误拒）', async () => {
    const b = broker(async () => ({ suspended: false, allowedPurpose: ['discovery'] }));
    const input: SmtpProbeInput = { domain: 'acme.de', mxHost: '127.0.0.1', rcptTo: ['a@acme.de'] };
    const res = await b.invoke<SmtpProbeInput, SmtpProbeOutput>('smtp.rcpt_probe', input, { workspaceId: 'w' });
    expect(res.data.egressBlocked).toBe('ip_literal_not_allowed'); // 过了合规门，被 SSRF 护栏挡在真实出网前
  });

  it('非 SUSPENDED：工具内 SSRF 护栏拦截私网/IP 字面量 MX → egressBlocked，不发生出网', async () => {
    const b = broker(async () => null); // 无策略 = 放行到 execute
    const input: SmtpProbeInput = { domain: 'acme.de', mxHost: '127.0.0.1', rcptTo: ['user@acme.de'] };
    const res = await b.invoke<SmtpProbeInput, SmtpProbeOutput>('smtp.rcpt_probe', input, { workspaceId: 'w' });
    expect(res.data.reachable).toBe(false);
    expect(res.data.egressBlocked).toBe('ip_literal_not_allowed');
    expect(res.data.codes).toEqual([]);
  });
});
