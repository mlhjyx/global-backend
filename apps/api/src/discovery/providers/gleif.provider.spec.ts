import { describe, expect, it, vi } from 'vitest';
import { GleifEnrichmentProvider, pickBest } from './gleif.provider';

const ctx = { workspaceId: 'ws', runId: 'run', correlationId: 'corr' };

function record(over: Record<string, unknown> = {}) {
  return {
    lei: 'LEI-1',
    legalName: 'Pump GmbH',
    legalFormId: '2HBR',
    entityStatus: 'ACTIVE',
    registrationStatus: 'ISSUED',
    country: 'DE',
    city: 'Berlin',
    hasDirectParent: false,
    hasUltimateParent: false,
    ...over,
  };
}

describe('GleifEnrichmentProvider', () => {
  it('fails closed without a broker and on search failures', async () => {
    await expect(
      new GleifEnrichmentProvider().enrichCompany({ name: 'Pump GmbH', country: 'DE' } as never, ctx),
    ).resolves.toMatchObject({ matched: false });
    const invoke = vi.fn(async () => { throw new Error('denied'); });
    await expect(
      new GleifEnrichmentProvider({ broker: { invoke } as never }).enrichCompany(
        { name: 'Pump GmbH', country: 'DE' } as never,
        ctx,
      ),
    ).resolves.toMatchObject({ matched: false });
  });

  it('retries without country after an empty country-constrained search', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ data: { records: [] } })
      .mockResolvedValueOnce({ data: { records: [record()] } });
    const result = await new GleifEnrichmentProvider({ broker: { invoke } as never }).enrichCompany(
      { name: 'Pump GmbH', country: ' DE ' } as never,
      ctx,
    );
    expect(result).toMatchObject({ matched: true, attributes: { lei: 'LEI-1' } });
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'gleif.fetch',
      expect.not.objectContaining({ country: expect.anything() }),
      expect.anything(),
    );
  });

  it('returns a miss when fallback search fails, remains empty, or identity is ambiguous', async () => {
    const fallbackFails = vi
      .fn()
      .mockResolvedValueOnce({ data: { records: [] } })
      .mockRejectedValueOnce(new Error('fallback failed'));
    await expect(
      new GleifEnrichmentProvider({ broker: { invoke: fallbackFails } as never }).enrichCompany(
        { name: 'Pump GmbH', country: 'DE' } as never,
        ctx,
      ),
    ).resolves.toMatchObject({ matched: false });

    const noCountry = vi.fn(async () => ({ data: {} }));
    await expect(
      new GleifEnrichmentProvider({ broker: { invoke: noCountry } as never }).enrichCompany(
        { name: '', country: undefined } as never,
        ctx,
      ),
    ).resolves.toMatchObject({ matched: false });

    const ambiguous = vi.fn(async () => ({
      data: { records: [record({ lei: 'A' }), record({ lei: 'B' })] },
    }));
    await expect(
      new GleifEnrichmentProvider({ broker: { invoke: ambiguous } as never }).enrichCompany(
        { name: 'Pump GmbH', country: 'DE' } as never,
        ctx,
      ),
    ).resolves.toMatchObject({ matched: false });
  });

  it('adds direct and distinct ultimate parent facts while tolerating a failed parent lookup', async () => {
    const invoke = vi.fn(async (_tool: string, input: { op: string }) => {
      if (input.op === 'search') {
        return {
          data: {
            records: [record({ hasDirectParent: true, hasUltimateParent: true, legalFormId: 'UNKNOWN' })],
          },
        };
      }
      if (input.op === 'directParent') return { data: { parent: { lei: 'PARENT', legalName: 'Parent AG' } } };
      return { data: { parent: { lei: 'ULTIMATE', legalName: 'Ultimate SE' } } };
    });
    const result = await new GleifEnrichmentProvider({ broker: { invoke } as never }).enrichCompany(
      { name: 'Pump GmbH', country: 'DE' } as never,
      ctx,
    );
    expect(result).toMatchObject({
      matched: true,
      attributes: {
        legal_form: 'UNKNOWN',
        parent_lei: 'PARENT',
        ultimate_parent_lei: 'ULTIMATE',
        is_subsidiary: true,
      },
      provenance: { parserVersion: 'gleif/v1' },
    });

    const failedParent = vi.fn(async (_tool: string, input: { op: string }) => {
      if (input.op === 'search') return { data: { records: [record({ hasDirectParent: true })] } };
      throw new Error('parent unavailable');
    });
    await expect(
      new GleifEnrichmentProvider({ broker: { invoke: failedParent } as never }).enrichCompany(
        { name: 'Pump GmbH', country: 'DE' } as never,
        ctx,
      ),
    ).resolves.not.toHaveProperty('attributes.parent_lei');
  });

  it('does not duplicate self as ultimate parent and exposes best-match null/non-null branches', async () => {
    const invoke = vi.fn(async (_tool: string, input: { op: string }) =>
      input.op === 'search'
        ? { data: { records: [record({ hasUltimateParent: true })] } }
        : { data: { parent: { lei: 'LEI-1', legalName: 'Pump GmbH' } } },
    );
    const result = await new GleifEnrichmentProvider({ broker: { invoke } as never }).enrichCompany(
      { name: 'Pump GmbH', country: 'DE' } as never,
      ctx,
    );
    expect(result.attributes).not.toHaveProperty('ultimate_parent_lei');
    expect(pickBest('Pump GmbH', [record() as never])).toMatchObject({ record: { lei: 'LEI-1' } });
    expect(pickBest('Pump GmbH', [])).toBeNull();
  });
});
