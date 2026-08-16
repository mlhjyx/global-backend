import { describe, expect, it, vi } from 'vitest';
import {
  organizationMayUseExternalProcessing,
  resolveOrganizationIdentityGroups,
  resolveOrganizationRoot,
  resolveOrganizationRootIds,
} from './organization-identity-root';

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111';

describe('organization identity root projection', () => {
  it('resolves aliases directly to one root for single and batched reads', async () => {
    const mappings = [
      { sourceCompanyId: 'alias-a', canonicalCompanyId: 'root' },
      { sourceCompanyId: 'alias-b', canonicalCompanyId: 'root' },
    ];
    const tx = {
      organizationCanonicalMapping: {
        findFirst: async ({ where }: { where: { sourceCompanyId: string } }) =>
          mappings.find((mapping) => mapping.sourceCompanyId === where.sourceCompanyId) ?? null,
        findMany: async () => mappings,
      },
    };

    await expect(resolveOrganizationRoot(tx as never, WORKSPACE_ID, 'alias-a')).resolves.toEqual({
      rootCompanyId: 'root',
      relatedCompanyIds: ['root', 'alias-a', 'alias-b'],
    });
    await expect(resolveOrganizationRootIds(tx as never, WORKSPACE_ID, ['alias-a', 'root', 'alias-b'])).resolves.toEqual(['root']);
    await expect(resolveOrganizationIdentityGroups(tx as never, WORKSPACE_ID, ['alias-a', 'root', 'alias-b'])).resolves.toEqual([
      {
        rootCompanyId: 'root',
        relatedCompanyIds: ['root', 'alias-a', 'alias-b'],
      },
    ]);
  });

  it('marks the root safe-side when any active alias is suppressed', async () => {
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const companies = new Map([
      [
        'root',
        {
          id: 'root',
          name: 'Root',
          domain: 'root.example',
          status: 'NEW',
          attributes: {},
        },
      ],
      [
        'alias',
        {
          id: 'alias',
          name: 'Old Name',
          domain: 'blocked.example',
          status: 'NEW',
          attributes: {},
        },
      ],
    ]);
    const tx = {
      $queryRaw: async () => [],
      organizationCanonicalMapping: {
        findFirst: async () => null,
        findMany: async () => [{ sourceCompanyId: 'alias', canonicalCompanyId: 'root' }],
      },
      organizationIdentityConflictParty: { count: async () => 0 },
      suppressionRecord: {
        findMany: async () => [{ type: 'domain', value: 'blocked.example' }],
      },
      canonicalCompany: {
        findUnique: async ({ where }: { where: { id: string } }) => companies.get(where.id) ?? null,
        updateMany,
      },
    };

    await expect(organizationMayUseExternalProcessing(tx as never, WORKSPACE_ID, 'root')).resolves.toBe(false);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'root', status: { not: 'SUPPRESSED' } },
      data: { status: 'SUPPRESSED', version: { increment: 1 } },
    });
  });
});
