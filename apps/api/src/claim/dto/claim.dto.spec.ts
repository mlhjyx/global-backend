import { describe, expect, it } from 'vitest';
import { ClaimDto } from './claim.dto';

describe('ClaimDto', () => {
  it('keeps the canonical fact key so a projected statement remains self-describing', () => {
    expect(
      ClaimDto.from({
        id: '11111111-1111-4111-8111-111111111111',
        companyId: '22222222-2222-4222-8222-222222222222',
        type: 'param',
        factKey: 'production_capacity',
        statement: '500 units/hour',
        status: 'NEEDS_REVIEW',
        confidence: 1,
        version: 1,
        createdAt: new Date('2026-07-18T00:00:00.000Z'),
        evidence: [],
      }),
    ).toMatchObject({
      factKey: 'production_capacity',
      statement: '500 units/hour',
    });
  });
});
