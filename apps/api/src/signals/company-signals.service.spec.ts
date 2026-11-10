import { describe, expect, it, vi } from 'vitest';
import { CompanySignalsService, parseSignalsLimit } from './company-signals.service';

const ctx = {
  workspaceId: '42c863b9-7c7e-4d28-8678-60ef9a20219b',
  userId: '0d5b2a4c-1111-4222-8333-944455556666',
} as never;

const companyId = '3f5bff42-ec9b-496f-9b6a-b725cbb171ef';

function row(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    provider_key: 'rss',
    signal_kind: 'rss_item',
    source_url: `https://example.test/news/${index}`,
    title: `signal ${index}`,
    excerpt: null,
    observed_at: new Date(Date.UTC(2026, 10, 10, 0, index)),
  };
}

function prisma(rows: unknown[]) {
  const queryRaw = vi.fn(async () => rows);
  return {
    withWorkspace: vi.fn(async (workspaceId: string, fn: (tx: unknown) => unknown) =>
      fn({ $queryRaw: queryRaw }),
    ),
    queryRaw,
  };
}

describe('CompanySignalsService', () => {
  it('maps rows to the page envelope and stops at the limit', async () => {
    const db = prisma([row(2), row(1)]);
    const service = new CompanySignalsService(db as never);

    const page = await service.listForCompany(ctx, companyId, { limit: '1' });

    expect(db.withWorkspace).toHaveBeenCalledWith(ctx.workspaceId, expect.any(Function));
    expect(page).toEqual({
      data: [
        {
          id: '00000000-0000-4000-8000-000000000002',
          providerKey: 'rss',
          signalKind: 'rss_item',
          sourceUrl: 'https://example.test/news/2',
          title: 'signal 2',
          excerpt: null,
          observedAt: '2026-11-10T00:02:00.000Z',
        },
      ],
      page: {
        nextCursor: expect.any(String),
        hasMore: true,
      },
    });
    // The cursor round-trips through listForCompany without a decode error.
    const decoded = JSON.parse(
      Buffer.from((page as { page: { nextCursor: string } }).page.nextCursor, 'base64url').toString('utf8'),
    ) as { t: string; id: string };
    expect(decoded).toEqual({ t: '2026-11-10T00:02:00.000Z', id: '00000000-0000-4000-8000-000000000002' });
  });

  it('returns an empty page with has_more=false when the company has no signals', async () => {
    const service = new CompanySignalsService(prisma([]) as never);

    const page = await service.listForCompany(ctx, companyId, {});

    expect(page).toEqual({ data: [], page: { nextCursor: null, hasMore: false } });
  });

  it('rejects malformed limit and cursor without touching the database', async () => {
    const db = prisma([]);
    const service = new CompanySignalsService(db as never);

    await expect(service.listForCompany(ctx, companyId, { limit: '0' })).resolves.toBe('invalid');
    await expect(service.listForCompany(ctx, companyId, { limit: '101' })).resolves.toBe('invalid');
    await expect(service.listForCompany(ctx, companyId, { limit: '1e3' })).resolves.toBe('invalid');
    await expect(service.listForCompany(ctx, companyId, { cursor: 'not-base64-json' })).resolves.toBe('invalid');
    await expect(
      service.listForCompany(ctx, companyId, {
        cursor: Buffer.from(JSON.stringify({ t: 'yesterday', id: 'nope' }), 'utf8').toString('base64url'),
      }),
    ).resolves.toBe('invalid');
    expect(db.withWorkspace).not.toHaveBeenCalled();
  });

  it('parses the limit bounds', () => {
    expect(parseSignalsLimit(undefined)).toBe(20);
    expect(parseSignalsLimit('')).toBe(20);
    expect(parseSignalsLimit('100')).toBe(100);
    expect(parseSignalsLimit(5)).toBe(5);
    expect(parseSignalsLimit('abc')).toBe('invalid');
    expect(parseSignalsLimit(0)).toBe('invalid');
  });
});
