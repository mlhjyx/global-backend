import { describe, expect, it, vi } from 'vitest';
import { LeadService } from './lead.service';

/**
 * BI-23（交付闭环设计 §6）：POST /leads/:id/outcomes 只追加地记录客户/运营的线索结果，
 * 按租户隔离，空反馈拒绝。
 */
const ctx = { workspaceId: 'ws-1', userId: 'user-1', roles: [], scopes: [] } as never;

function serviceWithTx(tx: unknown): LeadService {
  return new LeadService(
    { withWorkspace: async <T>(_workspaceId: string, callback: (client: unknown) => Promise<T>) => callback(tx) } as never,
    {} as never,
    {} as never,
  );
}

describe('LeadService.recordOutcome', () => {
  it('appends a customer outcome row scoped to the workspace', async () => {
    const created = {
      id: 'outcome-1',
      workspaceId: 'ws-1',
      leadId: 'lead-1',
      relevance: 4,
      willingToContact: true,
      reasonCode: 'GOOD_FIT',
      note: 'guter Kontakt',
      contacted: false,
      source: 'customer',
      createdAt: new Date('2026-10-27T00:00:00.000Z'),
    };
    const tx = {
      lead: { findUnique: vi.fn(async () => ({ id: 'lead-1' })) },
      leadOutcome: { create: vi.fn(async () => created) },
    };

    const row = await serviceWithTx(tx).recordOutcome(ctx, 'lead-1', {
      relevance: 4,
      willingToContact: true,
      reasonCode: 'GOOD_FIT',
      note: 'guter Kontakt',
      contacted: false,
      source: 'customer',
    });

    expect(row).toMatchObject({ id: 'outcome-1', leadId: 'lead-1', source: 'customer' });
    expect(tx.leadOutcome.create).toHaveBeenCalledWith({
      data: {
        workspaceId: 'ws-1',
        leadId: 'lead-1',
        relevance: 4,
        willingToContact: true,
        reasonCode: 'GOOD_FIT',
        note: 'guter Kontakt',
        contacted: false,
        source: 'customer',
      },
    });
  });

  it('defaults the source to operator and refuses an empty outcome', async () => {
    const tx = {
      lead: { findUnique: vi.fn(async () => ({ id: 'lead-1' })) },
      leadOutcome: { create: vi.fn(async () => ({})) },
    };
    await serviceWithTx(tx).recordOutcome(ctx, 'lead-1', { note: 'nur Notiz' });
    expect(tx.leadOutcome.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ source: 'operator', note: 'nur Notiz' }) }),
    );

    await expect(serviceWithTx(tx).recordOutcome(ctx, 'lead-1', {})).rejects.toMatchObject({
      response: { error: { code: 'OUTCOME_EMPTY' } },
    });
    expect(tx.leadOutcome.create).toHaveBeenCalledTimes(1);
  });

  it('rejects an unknown reason code and a note beyond the storage bound', async () => {
    const tx = {
      lead: { findUnique: vi.fn(async () => ({ id: 'lead-1' })) },
      leadOutcome: { create: vi.fn(async () => ({})) },
    };
    await expect(
      serviceWithTx(tx).recordOutcome(ctx, 'lead-1', { reasonCode: 'NOT_A_CODE' }),
    ).rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });
    await expect(
      serviceWithTx(tx).recordOutcome(ctx, 'lead-1', { note: 'x'.repeat(2001) }),
    ).rejects.toMatchObject({ response: { error: { code: 'VALIDATION_ERROR' } } });
    expect(tx.leadOutcome.create).not.toHaveBeenCalled();
  });

  it('refuses an outcome for a lead outside the workspace', async () => {
    const tx = {
      lead: { findUnique: vi.fn(async () => null) },
      leadOutcome: { create: vi.fn(async () => ({})) },
    };
    await expect(
      serviceWithTx(tx).recordOutcome(ctx, 'missing', { relevance: 3 }),
    ).rejects.toMatchObject({ response: { error: { code: 'NOT_FOUND' } } });
    expect(tx.leadOutcome.create).not.toHaveBeenCalled();
  });
});
