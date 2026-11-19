import { describe, it, expect, vi } from 'vitest';
import { loadRunProjectPage, scopeRunProjectEvidence } from './run-project-page';

const domain = 'acme.example';
const project = {
  source_url: 'https://www.acme.example/referenzen/anlage',
  fetched_at: '2026-11-16T10:00:00.000Z',
  spans: ['Wir haben Pumpen für dieses Abwasserprojekt ausgewählt und beschafft.'],
};
const now = new Date('2026-11-16T11:00:00.000Z');
const input = { workspaceId: 'ws', runId: 'run', icpId: 'icp', companyId: 'company', domain, now };
const fallback = {
  id: 'fallback', domain: 'public_web:company_site', allowedPurpose: ['discovery', 'enrichment'],
  reviewStatus: 'APPROVED', updatedAt: now, retentionDays: 365,
};

function fixture(scenario: string, siteOverride?: Record<string, unknown>) {
  const materialized = vi.fn(async () => [{ queryItem: { rawRecord: {
    sourceUrl: project.source_url, sourcePolicySnapshot: { id: fallback.id },
  } } }]);
  const tx = {
    discoveryRun: { findFirst: vi.fn(async () => ({ planId: 'plan' })) },
    discoveryQueryPlan: { findFirst: vi.fn(async () => ({ queries: [{ filters: { procurement_scenario: scenario } }] })) },
    discoveryCompanyMaterializationOutcome: { findMany: materialized },
    sourcePolicy: { findMany: vi.fn(async () => [fallback, ...(siteOverride ? [siteOverride] : [])]) },
  };
  return { tx: tx as never, materialized };
}

describe('project sourcing is tied to the run and current policy', () => {
  it('only loads a live accepted source of the canonical company in the run', async () => {
    const { tx, materialized } = fixture('equipment_integration');
    await expect(loadRunProjectPage(tx, input)).resolves.toBe(project.source_url);
    expect(materialized).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ workspaceId: 'ws', runId: 'run', canonicalCompanyId: 'company',
        providerKey: 'public_web', outcome: 'CANONICALIZED',
        queryItem: { rawRecord: expect.objectContaining({ runId: 'run', ingestStatus: 'ACCEPTED',
          expiredAt: null, expiresAt: { gt: now } }) },
      }),
    }));
  });

  it('does not read project links for an ordinary distribution run', async () => {
    const { tx, materialized } = fixture('distribution');
    await expect(loadRunProjectPage(tx, input)).resolves.toBeUndefined();
    expect(materialized).not.toHaveBeenCalled();
  });

  it('does not reuse an accepted generic-policy link after a more specific site suspension', async () => {
    const { tx } = fixture('factory_direct', { ...fallback, id: 'override', domain, reviewStatus: 'SUSPENDED' });
    await expect(loadRunProjectPage(tx, input)).resolves.toBeUndefined();
  });

  it('removes persisted proof when this run did not allow its page', () => {
    const attrs = { website_profile: { trade_role: 'other', project_evidence: project } };
    expect(scopeRunProjectEvidence(attrs, project.source_url)).toBe(attrs);
    expect(scopeRunProjectEvidence(attrs, undefined)).toEqual({ website_profile: { trade_role: 'other' } });
  });
});
