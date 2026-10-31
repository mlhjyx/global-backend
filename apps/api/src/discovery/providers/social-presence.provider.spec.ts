import { describe, expect, it, vi } from 'vitest';
import {
  buildSocialDorks,
  parseSocialHeadline,
  parseSocialResults,
  SocialPresenceContactAdapter,
} from './social-presence.provider';

const COMPANY = { name: 'Pumpen Schmid GmbH', domain: 'pumpen-schmid.de' };

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

  it('queries searxng through the broker and tolerates a failing dork', async () => {
    const invoke = vi.fn(async (_tool: string, input: { q: string }) => {
      if (input.q.startsWith('site:xing.com/profile')) throw new Error('search down');
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
    const adapter = new SocialPresenceContactAdapter({ broker: { invoke } as never });

    const result = await adapter.discoverContacts(COMPANY, {
      workspaceId: 'ws-1',
      runId: 'run-1',
      correlationId: 'company-1',
    } as never);

    expect(invoke).toHaveBeenCalled();
    expect(invoke.mock.calls[0]![0]).toBe('searxng.search');
    expect(result.contacts).toHaveLength(1);
    expect(result.contacts[0]).toMatchObject({ fullName: 'Max Mustermann', personalData: true });
    expect(result.costCents).toBe(0);
  });

  it('returns nothing without a broker (fail-closed, no raw egress)', async () => {
    const adapter = new SocialPresenceContactAdapter({});
    await expect(
      adapter.discoverContacts(COMPANY, { workspaceId: 'ws-1' } as never),
    ).resolves.toEqual({ contacts: [], costCents: 0 });
  });
});
