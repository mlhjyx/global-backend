import { describe, expect, it, vi } from 'vitest';
import {
  buildSocialDorks,
  choosePersonTitle,
  htmlToVisibleText,
  isSocialLoginWall,
  pageTextMentionsName,
  parseSocialHeadline,
  parseSocialResults,
  pickCandidatePerson,
  pickWaybackSnapshot,
  SocialHostCircuit,
  SocialPresenceContactAdapter,
  socialHostKey,
} from './social-presence.provider';

const COMPANY = { name: 'Pumpen Schmid GmbH', domain: 'pumpen-schmid.de' };
const NOW = Date.UTC(2026, 10, 1);

const PROFILE_TEXT =
  'Max Mustermann ist Einkaufsleiter bei der Pumpen Schmid GmbH in Stuttgart. ' +
  'Er verantwortet die Beschaffung von Industriepumpen und berichtet an die Geschäftsführung. ' +
  'Kontakt: max.mustermann@pumpen-schmid.de';

const SNAPSHOT = 'https://web.archive.org/web/20260101/https://www.xing.com/profile/Max_Mustermann';

describe('social presence contact adapter (M2a: search index only)', () => {
  it('builds LinkedIn and Xing dorks with role hints and a domain anchor', () => {
    const dorks = buildSocialDorks(COMPANY, ['Einkauf', 'Geschäftsführer']);

    expect(dorks).toContain('site:linkedin.com/in "Pumpen Schmid GmbH"');
    expect(dorks).toContain('site:xing.com/profile "Pumpen Schmid GmbH"');
    expect(dorks.some((dork) => dork.includes('"Einkauf" OR "Geschäftsführer"'))).toBe(true);
    expect(dorks.some((dork) => dork.includes('"pumpen-schmid.de"'))).toBe(true);
    expect(buildSocialDorks({ name: '   ' }, [])).toEqual([]);
  });

  it('parses a LinkedIn headline into name and role', () => {
    expect(parseSocialHeadline('Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn')).toEqual({
      fullName: 'Max Mustermann',
      title: 'Einkaufsleiter',
    });
    expect(parseSocialHeadline('Erika Musterfrau - Geschäftsführerin - Pumpen Schmid | XING')).toEqual({
      fullName: 'Erika Musterfrau',
      title: 'Geschäftsführerin',
    });
    expect(parseSocialHeadline('Singleword | LinkedIn')).toBeNull();
  });

  it('keeps matching person profiles, drops company pages, strangers and non-social URLs', () => {
    const contacts = parseSocialResults(
      [
        { url: 'https://de.linkedin.com/in/max-mustermann-123', title: 'Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn' },
        { url: 'https://www.linkedin.com/company/pumpen-schmid', title: 'Pumpen Schmid GmbH | LinkedIn' },
        { url: 'https://www.xing.com/profile/Erika_Musterfrau', title: 'Erika Musterfrau - Geschäftsführerin - Pumpen Schmid | XING' },
        { url: 'https://www.linkedin.com/in/other-person', title: 'Other Person - Sales - Unrelated Corp | LinkedIn' },
        { url: 'https://pumpen-schmid.de/team', title: 'Team – Pumpen Schmid' },
        { url: 'https://de.linkedin.com/in/max-mustermann-123', title: 'Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn' },
      ],
      COMPANY,
    );

    expect(contacts).toHaveLength(2);
    expect(contacts[0]).toMatchObject({
      fullName: 'Max Mustermann',
      title: 'Einkaufsleiter',
      linkedin: 'https://de.linkedin.com/in/max-mustermann-123',
      personalData: true,
      license: 'public-index',
    });
    expect(contacts[1]).toMatchObject({ fullName: 'Erika Musterfrau', title: 'Geschäftsführerin' });
    expect(contacts[1]!.linkedin).toBeUndefined();
  });

  it('queries social.search through the broker and tolerates a failing dork', async () => {
    const invoke = vi.fn(async (tool: string, input: { q?: string }) => {
      expect(tool).toBe('social.search');
      if (input.q?.startsWith('site:xing.com/profile')) throw new Error('search down');
      return {
        data: {
          results: [
            {
              url: 'https://de.linkedin.com/in/max-mustermann-123',
              title: 'Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn',
            },
          ],
        },
        costCents: 0,
      };
    });
    const adapter = new SocialPresenceContactAdapter({
      broker: { invoke } as never,
    });

    const result = await adapter.discoverContacts(COMPANY, {
      workspaceId: 'ws-1',
      runId: 'run-1',
      correlationId: 'company-1',
    } as never);

    expect(invoke).toHaveBeenCalled();
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]).toMatchObject({ fullName: 'Max Mustermann', personalData: true });
    expect(result.costCents).toBe(0);
  });

  it('skips the archive/live layers entirely when no extractor is wired (no wasted egress)', async () => {
    const invoke = vi.fn(async () => ({
      data: {
        results: [
          {
            url: 'https://www.linkedin.com/in/max-mustermann',
            title: 'Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn',
          },
        ],
      },
      costCents: 0,
    }));
    const adapter = new SocialPresenceContactAdapter({ broker: { invoke } as never });

    await adapter.discoverContacts(COMPANY, { workspaceId: 'ws-1', runId: 'run-1' } as never);

    expect(invoke.mock.calls.every(([tool]) => tool === 'social.search')).toBe(true);
  });
});

describe('social presence M2b: archive copies and live public pages (D1)', () => {
  it('accepts http and https Wayback snapshots, normalizes to https and rejects stale/foreign ones', () => {
    const fresh = {
      archived_snapshots: {
        closest: { available: true, status: '200', url: 'http://web.archive.org/web/20260101000000/https://www.xing.com/profile/Erika_Musterfrau' },
      },
    };
    expect(pickWaybackSnapshot(fresh, NOW)).toBe(
      'https://web.archive.org/web/20260101000000/https://www.xing.com/profile/Erika_Musterfrau',
    );
    const stale = {
      archived_snapshots: {
        closest: { status: '200', url: 'https://web.archive.org/web/20100505/https://www.xing.com/profile/Christian_Klein4' },
      },
    };
    expect(pickWaybackSnapshot(stale, NOW)).toBeNull();
    expect(
      pickWaybackSnapshot({ archived_snapshots: { closest: { status: '301', url: 'https://web.archive.org/web/20260101/https://x.example' } } }, NOW),
    ).toBeNull();
    expect(
      pickWaybackSnapshot({ archived_snapshots: { closest: { status: '200', url: 'https://evil.example/web/20260101/https://x.example' } } }, NOW),
    ).toBeNull();
    // 非法日期（月份 13/00、2 月 30 日）与未来时间戳都不可信，一律拒绝。
    for (const stamp of ['20261301', '20260015', '20260230']) {
      expect(
        pickWaybackSnapshot(
          { archived_snapshots: { closest: { status: '200', url: `https://web.archive.org/web/${stamp}/https://x.example` } } },
          NOW,
        ),
        stamp,
      ).toBeNull();
    }
    expect(
      pickWaybackSnapshot(
        { archived_snapshots: { closest: { status: '200', url: 'https://web.archive.org/web/20301231/https://x.example' } } },
        NOW,
      ),
    ).toBeNull();
    expect(pickWaybackSnapshot(null, NOW)).toBeNull();
    expect(pickWaybackSnapshot('nope', NOW)).toBeNull();
  });

  it('detects only wall-only phrases, not logged-out page chrome', () => {
    // 未登录的公开个人页也带 "Join now"/"Sign in"/"Anmelden" 导航——都不算墙。
    expect(isSocialLoginWall('LinkedIn Home Jobs Games Join now Sign in Bill Gates Seattle')).toBe(false);
    expect(isSocialLoginWall('XING Anmelden Registrieren Profil von Max Mustermann')).toBe(false);
    // 真正的墙页短语。
    expect(isSocialLoginWall('Sign in to view this profile — LinkedIn')).toBe(true);
    expect(isSocialLoginWall('https://www.linkedin.com/authwall?trk=guest')).toBe(true);
    expect(isSocialLoginWall('Bitte melden Sie sich an, um das Profil zu sehen.')).toBe(true);
  });

  it('strips HTML and decodes entities exactly once (no double-unescape)', () => {
    const text = htmlToVisibleText(
      '<html><head><style>.x{}</style><script>var a=1;</script ></head><body><h1>Max Mustermann</h1><p>Einkauf &amp; Vertrieb, O&#x27;Brien &lt;x&gt; &amp;lt;keep&gt;</p></body></html>',
    );
    expect(text).toBe("Max Mustermann Einkauf & Vertrieb, O'Brien <x> &lt;keep>");
    expect(text).not.toContain('var a=1');
    // 结束标签带空白/属性垃圾（HTML 分词器也视作结束标签）必须整体剥掉。
    expect(htmlToVisibleText('<script>alert(1)</script >visible')).toBe('visible');
    expect(htmlToVisibleText('<script>alert(1)</script\t\n bar>visible')).toBe('visible');
  });

  it('matches names across umlaut transliterations and picks only the profile owner', () => {
    const people = [
      { full_name: 'Erika Musterfrau', title: 'Geschäftsführerin' },
      { full_name: 'Max Müller', title: 'Einkaufsleiter' },
    ];
    expect(pickCandidatePerson(people, 'Max Mueller')?.title).toBe('Einkaufsleiter');
    // 反方向转写（索引写 Müller、页面抽取写 Muller）也必须命中（与预检同折叠）。
    expect(pickCandidatePerson([{ full_name: 'Max Muller', title: 'Einkaufsleiter' }], 'Max Müller')?.title).toBe('Einkaufsleiter');
    expect(pickCandidatePerson(people, 'Strauß')?.title).toBeUndefined();
    expect(pickCandidatePerson(people, 'Strauss')).toBeNull();
    expect(pickCandidatePerson(people, 'John Doe')).toBeNull();
    expect(pageTextMentionsName('Dr. Max Müller ist Einkaufsleiter', 'Max Mueller')).toBe(true);
    expect(pageTextMentionsName('Erika Musterfrau ist Geschäftsführerin', 'Max Mueller')).toBe(false);
  });

  it('keeps the index title when the extracted one is not role-shaped', () => {
    expect(choosePersonTitle('Einkaufsleiter', 'Head of Procurement')).toBe('Head of Procurement');
    expect(choosePersonTitle('Einkaufsleiter', 'Max Mustermann ist seit vielen Jahren im Einkauf der Firma tätig und berichtet')).toBe('Einkaufsleiter');
    expect(choosePersonTitle('Einkaufsleiter', undefined)).toBe('Einkaufsleiter');
    expect(choosePersonTitle(undefined, 'Geschäftsführer')).toBe('Geschäftsführer');
  });

  it('keys the circuit and pacer by registrable domain, not the exact subdomain', () => {
    expect(socialHostKey('de.linkedin.com')).toBe('linkedin.com');
    expect(socialHostKey('www.xing.com')).toBe('xing.com');
    expect(socialHostKey('xing.com')).toBe('xing.com');
    expect(socialHostKey('example.com')).toBe('example.com');
  });

  it('enriches an indexed candidate from a Wayback archive copy (no live fetch)', async () => {
    const invoke = vi.fn(async (tool: string, input: { q?: string; url?: string }) => {
      if (tool === 'social.search') {
        return {
          data: {
            results: [
              {
                url: 'https://www.xing.com/profile/Max_Mustermann',
                title: 'Max Mustermann - Einkaufsleiter - Pumpen Schmid GmbH | XING',
              },
            ],
          },
          costCents: 0,
        };
      }
      if (tool === 'social.fetch' && input.url?.startsWith('https://archive.org/wayback/available')) {
        return {
          data: {
            status: 200,
            ok: true,
            text: JSON.stringify({
              archived_snapshots: { closest: { status: '200', url: 'http://web.archive.org/web/20260101/https://www.xing.com/profile/Max_Mustermann' } },
            }),
          },
          costCents: 0,
        };
      }
      if (tool === 'social.fetch' && input.url?.startsWith('https://web.archive.org/')) {
        return {
          data: { status: 200, ok: true, text: `<html><body>${PROFILE_TEXT}</body></html>` },
          costCents: 0,
        };
      }
      throw new Error(`unexpected tool ${tool} ${input.url}`);
    });
    const extract = vi.fn(async () => [
      {
        full_name: 'Max Mustermann',
        title: 'Einkaufsleiter',
        department: 'procurement',
        seniority: 'manager',
        buying_role: 'economic_buyer',
        is_target_role: true,
        email: 'max.mustermann@pumpen-schmid.de',
      },
    ]);
    const adapter = new SocialPresenceContactAdapter({
      broker: { invoke } as never,
      extract,
    });

    const result = await adapter.discoverContacts(COMPANY, {
      workspaceId: 'ws-1',
      runId: 'run-1',
      correlationId: 'company-1',
    } as never);

    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]).toMatchObject({
      fullName: 'Max Mustermann',
      title: 'Einkaufsleiter',
      department: 'procurement',
      seniority: 'manager',
      buyingRole: 'economic_buyer',
      isTargetRole: true,
      email: 'max.mustermann@pumpen-schmid.de',
      personalData: true,
      license: 'public-archive',
      sourcePage: SNAPSHOT,
    });
    expect(result.diagnostics).toMatchObject({ social_fetches: 1, social_archive_hits: 1 });
  });

  it('falls back to the live LinkedIn page and keeps chrome-heavy pages', async () => {
    let liveCalls = 0;
    const invoke = vi.fn(async (tool: string, input: { q?: string; url?: string }) => {
      if (tool === 'social.search') {
        return {
          data: {
            results: [
              {
                url: 'https://www.linkedin.com/in/max-mustermann',
                title: 'Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn',
              },
            ],
          },
          costCents: 0,
        };
      }
      if (tool === 'social.fetch' && input.url?.startsWith('https://archive.org/wayback/available')) {
        return { data: { status: 200, ok: true, text: '{"archived_snapshots":{}}' }, costCents: 0 };
      }
      if (tool === 'social.fetch') {
        liveCalls += 1;
        return {
          data: {
            status: 200,
            ok: true,
            text: `<html><body>LinkedIn Home Jobs Games Join now Sign in ${PROFILE_TEXT}</body></html>`,
          },
          costCents: 0,
        };
      }
      throw new Error(`unexpected tool ${tool}`);
    });
    const extract = vi.fn(async () => [{ full_name: 'Max Mustermann', title: 'Einkaufsleiter' }]);
    const adapter = new SocialPresenceContactAdapter({
      broker: { invoke } as never,
      extract,
    });

    const result = await adapter.discoverContacts(COMPANY, { workspaceId: 'ws-1', runId: 'run-1' } as never);

    expect(liveCalls).toBe(1);
    expect(result.contacts[0]).toMatchObject({
      license: 'public-page',
      sourcePage: 'https://www.linkedin.com/in/max-mustermann',
    });
    expect(result.diagnostics).toMatchObject({ social_live_hits: 1 });
    expect(result.diagnostics?.social_blocked).toBeUndefined();
  });

  it('counts only target refusals (403/429/999, login wall) into the circuit', async () => {
    const refusalInvoke = vi.fn(async (tool: string, input: { q?: string; url?: string }) => {
      if (tool === 'social.search') {
        return {
          data: {
            results: [
              { url: 'https://www.linkedin.com/in/max-mustermann', title: 'Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn' },
            ],
          },
          costCents: 0,
        };
      }
      if (input.url?.startsWith('https://archive.org/wayback/available')) {
        return { data: { status: 200, ok: true, text: '{"archived_snapshots":{}}' }, costCents: 0 };
      }
      return { data: { status: 999, ok: false, text: '' }, costCents: 0 };
    });
    const circuit = new SocialHostCircuit();
    const adapter = new SocialPresenceContactAdapter({
      broker: { invoke: refusalInvoke } as never,
      extract: async () => [{ full_name: 'Max Mustermann', title: 'Einkaufsleiter' }],
      circuit,
    });
    const first = await adapter.discoverContacts(COMPANY, { workspaceId: 'ws-1', runId: 'run-1' } as never);
    expect(first.diagnostics).toMatchObject({ social_blocked: 1 });
    // 索引层的姓名/职务仍保留，只是没有被富化。
    expect(first.contacts[0]).toMatchObject({ title: 'Einkaufsleiter', license: 'public-index' });

    // 本地闸门拦截（status 0 + blocked）不是目标拒绝：不计熔断、不计 social_blocked。
    const blockedInvoke = vi.fn(async (tool: string, input: { q?: string; url?: string }) => {
      if (tool === 'social.search') {
        return {
          data: {
            results: [
              { url: 'https://www.linkedin.com/in/max-mustermann', title: 'Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn' },
            ],
          },
          costCents: 0,
        };
      }
      if (input.url?.startsWith('https://archive.org/wayback/available')) {
        return { data: { status: 200, ok: true, text: '{"archived_snapshots":{}}' }, costCents: 0 };
      }
      return { data: { status: 0, ok: false, text: '', blocked: 'SSRF_BLOCKED' }, costCents: 0 };
    });
    const blockedResult = await new SocialPresenceContactAdapter({
      broker: { invoke: blockedInvoke } as never,
      extract: async () => [],
      circuit: new SocialHostCircuit(),
    }).discoverContacts(COMPANY, { workspaceId: 'ws-1', runId: 'run-1' } as never);
    expect(blockedResult.diagnostics?.social_blocked).toBeUndefined();
  });

  it('keeps enriching from archives while the live circuit is open', async () => {
    const circuit = new SocialHostCircuit({ threshold: 3, cooldownMs: 60_000 });
    for (let i = 0; i < 3; i += 1) circuit.recordRefusal('linkedin.com');
    expect(circuit.isOpen('linkedin.com')).toBe(true);

    let liveCalls = 0;
    const invoke = vi.fn(async (tool: string, input: { q?: string; url?: string }) => {
      if (tool === 'social.search') {
        return {
          data: {
            results: [
              { url: 'https://www.linkedin.com/in/max-mustermann', title: 'Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn' },
              { url: 'https://www.linkedin.com/in/erika-musterfrau', title: 'Erika Musterfrau – Einkauf – Pumpen Schmid GmbH | LinkedIn' },
            ],
          },
          costCents: 0,
        };
      }
      if (input.url?.startsWith('https://archive.org/wayback/available')) {
        // 只有第一个候选有档案。
        return {
          data: {
            status: 200,
            ok: true,
            text: input.url.includes('max-mustermann')
              ? JSON.stringify({ archived_snapshots: { closest: { status: '200', url: 'http://web.archive.org/web/20260101/https://www.linkedin.com/in/max-mustermann' } } })
              : '{"archived_snapshots":{}}',
          },
          costCents: 0,
        };
      }
      if (input.url?.startsWith('https://web.archive.org/')) {
        return { data: { status: 200, ok: true, text: `<html><body>${PROFILE_TEXT}</body></html>` }, costCents: 0 };
      }
      liveCalls += 1;
      return { data: { status: 200, ok: true, text: `<html><body>${PROFILE_TEXT}</body></html>` }, costCents: 0 };
    });
    const adapter = new SocialPresenceContactAdapter({
      broker: { invoke } as never,
      extract: async (_u, text) => (text.includes('Musterfrau')
        ? [{ full_name: 'Erika Musterfrau', title: 'Einkauf' }]
        : [{ full_name: 'Max Mustermann', title: 'Einkaufsleiter' }]),
      circuit,
    });

    const result = await adapter.discoverContacts(COMPANY, { workspaceId: 'ws-1', runId: 'run-1' } as never);

    // 候选 1 有档案 → 熔断不影响档案层；候选 2 无档案 → L2 被熔断跳过。
    expect(liveCalls).toBe(0);
    expect(result.contacts.find((c) => c.fullName === 'Max Mustermann')).toMatchObject({ license: 'public-archive' });
    expect(result.contacts.find((c) => c.fullName === 'Erika Musterfrau')).toMatchObject({ license: 'public-index' });
    expect(result.diagnostics).toMatchObject({ social_circuit_open: 1 });
  });

  it('drops an unparseable extracted email without dropping the whole contact', async () => {
    const invoke = vi.fn(async (tool: string, input: { q?: string; url?: string }) => {
      if (tool === 'social.search') {
        return {
          data: {
            results: [
              { url: 'https://www.linkedin.com/in/max-mustermann', title: 'Max Mustermann – Einkaufsleiter – Pumpen Schmid GmbH | LinkedIn' },
            ],
          },
          costCents: 0,
        };
      }
      if (input.url?.startsWith('https://archive.org/wayback/available')) {
        return {
          data: {
            status: 200,
            ok: true,
            text: JSON.stringify({ archived_snapshots: { closest: { status: '200', url: 'http://web.archive.org/web/20260101/https://www.linkedin.com/in/max-mustermann' } } }),
          },
          costCents: 0,
        };
      }
      return { data: { status: 200, ok: true, text: `<html><body>${PROFILE_TEXT}</body></html>` }, costCents: 0 };
    });
    const adapter = new SocialPresenceContactAdapter({
      broker: { invoke } as never,
      extract: async () => [
        { full_name: 'Max Mustermann', title: 'Einkaufsleiter', email: 'max.mustermann(at)pumpen-schmid.de' },
      ],
    });

    const result = await adapter.discoverContacts(COMPANY, { workspaceId: 'ws-1', runId: 'run-1' } as never);

    expect(result.contacts[0]).toMatchObject({ fullName: 'Max Mustermann', title: 'Einkaufsleiter' });
    expect(result.contacts[0]!.email).toBeUndefined();
  });

  it('keeps the circuit open for the cooldown window and resets after it', () => {
    let now = 0;
    const circuit = new SocialHostCircuit({ threshold: 3, cooldownMs: 1_000, now: () => now });
    circuit.recordRefusal('linkedin.com');
    circuit.recordRefusal('linkedin.com');
    expect(circuit.isOpen('linkedin.com')).toBe(false);
    circuit.recordRefusal('linkedin.com');
    expect(circuit.isOpen('linkedin.com')).toBe(true);
    now = 1_001;
    expect(circuit.isOpen('linkedin.com')).toBe(false);
    circuit.recordRefusal('linkedin.com');
    expect(circuit.isOpen('linkedin.com')).toBe(false); // strike counter was reset after cooldown
  });

  it('returns nothing without a broker (fail-closed, no raw egress)', async () => {
    const adapter = new SocialPresenceContactAdapter({});
    await expect(
      adapter.discoverContacts(COMPANY, { workspaceId: 'ws-1' } as never),
    ).resolves.toEqual({ contacts: [], costCents: 0 });
  });
});
