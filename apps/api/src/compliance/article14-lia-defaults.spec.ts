import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import {
  DEFAULT_B2B_OUTREACH_LIA_TEMPLATE,
  ensureDefaultWorkspaceLiaInTransaction,
} from './article14-lia.service';
import { buildCompactArticle14Footer } from '../lead/outreach-draft';

describe('Batch 1.5-A seamless LIA default template & compact Art.14 outreach footer', () => {
  it('activates a standard workspace B2B LIA idempotently without duplicating existing ACTIVE rows', async () => {
    const create = vi.fn(async () => ({ id: 'lia-1', ref: DEFAULT_B2B_OUTREACH_LIA_TEMPLATE.ref }));
    const findFirst = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'lia-1', ref: DEFAULT_B2B_OUTREACH_LIA_TEMPLATE.ref });
    const tx = { liaRecord: { findFirst, create } } as unknown as Prisma.TransactionClient;

    const first = await ensureDefaultWorkspaceLiaInTransaction(tx, {
      workspaceId: 'ws-1',
      recordedBy: 'user-1',
    });
    expect(first).toEqual({ id: 'lia-1', created: true, ref: 'LIA-B2B-DEFAULT-V1' });
    expect(create).toHaveBeenCalledOnce();

    const second = await ensureDefaultWorkspaceLiaInTransaction(tx, {
      workspaceId: 'ws-1',
      recordedBy: 'user-1',
    });
    expect(second).toEqual({ id: 'lia-1', created: false, ref: 'LIA-B2B-DEFAULT-V1' });
    expect(create).toHaveBeenCalledOnce();
  });

  it('builds localized compact Art.14 privacy footers for first-contact emails', () => {
    expect(buildCompactArticle14Footer('it', 'Liansheng PV')).toContain('GDPR Art. 14');
    expect(buildCompactArticle14Footer('it', 'Liansheng PV')).toContain('Liansheng PV');
    expect(buildCompactArticle14Footer('de', 'Liansheng PV')).toContain('DSGVO Art. 14');
    expect(buildCompactArticle14Footer('en', 'Liansheng PV')).toContain('Reply "STOP"');
  });
});
