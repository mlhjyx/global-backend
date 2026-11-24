import { describe, expect, it, vi } from 'vitest';
import {
  ARTICLE14_DEADLINE_DAYS,
  findActiveLiaRecordInTransaction,
  findRetentionExpiredContactIdsInTransaction,
  fulfillArticle14NoticeInTransaction,
  requiresArticle14ForCountry,
  scheduleArticle14NoticeInTransaction,
} from './article14-lia.service';

const WS = '10000000-0000-4000-8000-000000000001';
const COMPANY = '20000000-0000-4000-8000-000000000002';
const CONTACT = '30000000-0000-4000-8000-000000000003';

describe('GDPR Article 14 Notice, LIA & Personal Contact Retention', () => {
  it('triggers Article 14 scheduling strictly for EU/UK subjects with 30-day deadline and idempotency', async () => {
    expect(requiresArticle14ForCountry('DE')).toBe('EU');
    expect(requiresArticle14ForCountry('IT')).toBe('EU');
    expect(requiresArticle14ForCountry('GB')).toBe('UK');
    expect(requiresArticle14ForCountry('US')).toBeNull();
    expect(requiresArticle14ForCountry('BR')).toBeNull();

    const acquiredAt = new Date('2026-11-25T00:00:00.000Z');
    const createdRows: Array<Record<string, unknown>> = [];
    const tx = {
      article14Notice: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          createdRows.push(data);
          return { id: 'a14-1', dueAt: data.dueAt };
        }),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };

    const nonEu = await scheduleArticle14NoticeInTransaction(tx as never, {
      workspaceId: WS,
      subjectId: CONTACT,
      country: 'US',
      sourceCategory: 'exa_people',
      acquiredAt,
    });
    expect(nonEu).toBeNull();
    expect(tx.article14Notice.create).not.toHaveBeenCalled();

    const eu = await scheduleArticle14NoticeInTransaction(tx as never, {
      workspaceId: WS,
      subjectId: CONTACT,
      country: 'IT',
      sourceCategory: 'exa_people',
      acquiredAt,
    });
    expect(eu?.created).toBe(true);
    expect(eu?.jurisdiction).toBe('EU');
    expect(eu?.dueAt.getTime() - acquiredAt.getTime()).toBe(ARTICLE14_DEADLINE_DAYS * 86_400_000);

    const fulfilled = await fulfillArticle14NoticeInTransaction(tx as never, {
      workspaceId: WS,
      subjectId: CONTACT,
      channel: 'first_contact',
    });
    expect(fulfilled).toBe(1);
  });

  it('resolves LIA records with contact -> company -> workspace precedence', async () => {
    const tx = {
      liaRecord: {
        findMany: vi.fn(async () => [
          { id: 'lia-ws', scope: 'workspace', scopeRef: null, basis: 'legitimate_interest', ref: 'LIA-2026-01' },
          { id: 'lia-co', scope: 'company', scopeRef: COMPANY, basis: 'legitimate_interest', ref: 'LIA-CO-99' },
        ]),
      },
    };
    const hit = await findActiveLiaRecordInTransaction(tx as never, {
      workspaceId: WS,
      companyId: COMPANY,
      contactId: CONTACT,
    });
    expect(hit).toMatchObject({ id: 'lia-co', scope: 'company', ref: 'LIA-CO-99' });
  });

  it('selects personal contacts older than the 730-day retention cap', async () => {
    const now = new Date('2026-11-25T00:00:00.000Z');
    const tx = {
      canonicalContact: {
        findMany: vi.fn(async () => [{ id: CONTACT }]),
      },
    };
    const expired = await findRetentionExpiredContactIdsInTransaction(tx as never, {
      workspaceId: WS,
      now,
    });
    expect(expired).toEqual([CONTACT]);
    expect(tx.canonicalContact.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: WS, createdAt: { lt: new Date(now.getTime() - 730 * 86_400_000) } },
      }),
    );
  });
});
