import { ConflictException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { assertOrganizationIdentityCommercialFactsMutable } from './organization-identity-commercial-guard';

describe('organization identity commercial facts guard', () => {
  it('blocks an identity change when two companies in the group own the same ICP Lead', async () => {
    const tx = {
      organizationCanonicalMapping: {
        findMany: vi.fn(async () => []),
      },
      lead: {
        findMany: vi.fn(async () => [
          { id: 'lead-a', icpId: 'icp-1', canonicalCompanyId: 'company-a', status: 'DISCOVERED' },
          { id: 'lead-b', icpId: 'icp-1', canonicalCompanyId: 'company-b', status: 'REVIEW' },
        ]),
      },
      outboxEvent: { count: vi.fn(async () => 0) },
    };

    await expect(
      assertOrganizationIdentityCommercialFactsMutable(
        tx as never,
        'workspace-1',
        ['company-a', 'company-b'],
      ),
    ).rejects.toMatchObject({
      response: { error: { code: 'COMMERCIAL_FACTS_IMMUTABLE' } },
    });
    await expect(
      assertOrganizationIdentityCommercialFactsMutable(
        tx as never,
        'workspace-1',
        ['company-a', 'company-b'],
      ),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
