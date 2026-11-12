import { describe, expect, it } from 'vitest';
import type { TedAwardNotice } from '../../adapters/ted-api';
import { scoreLead, type CompanyForScoring, type IcpForScoring } from '../../lead/scoring';
import { mapNoticeToRecords } from './ted.provider';

/**
 * PR-03 diagnostic (test-only): before changing production code, prove whether the
 * residual TED risk is in the provider output (no explicit buyer/winner relationship)
 * or in downstream qualification (winner country is not checked against the target
 * market / buyer relation).
 *
 * These are characterization tests: they pass on the current HEAD and document what
 * the code actually does. The `it.fails` cases encode the desired contract; they will
 * start failing (and must then be converted) only when the defect is fixed. No
 * production code is changed by this PR.
 */

const NOW = '2026-11-12T00:00:00.000Z';

const notice: TedAwardNotice = {
  publicationNumber: '123456-2026',
  publicationDate: '2026-11-12+01:00',
  noticeType: 'can-standard',
  formType: 'result',
  cpvCodes: ['42120000'],
  buyerNames: ['Stadtwerke München'],
  buyerCountries: ['DEU'],
  winners: [
    {
      name: 'Pompes Martin SAS',
      country: 'FRA',
      identifier: 'FR12345678901',
      internetAddress: 'https://pompes-martin.example',
    },
  ],
};

describe('PR-03 TED buyer/winner diagnostic', () => {
  it('T1 (characterization): winner record carries winner country and buyer facts separately', () => {
    const record = mapNoticeToRecords(notice, NOW)[0]!;
    const ted = record.attributes?.ted as Record<string, unknown>;

    // Current HEAD: the record is the winner (FR), while buyer facts stay in attributes (DE).
    // 买方国家原样保留 TED 的 alpha-3 码：下游若按 ISO2 比对国家永远对不上。
    expect(record.country).toBe('FR');
    expect(ted.buyer_countries).toEqual(['DEU']);
    expect(ted.buyer_names).toEqual(['Stadtwerke München']);

    // There is no explicit relationship structure the downstream can key on.
    expect('relationships' in ted).toBe(false);
    expect('relationship' in record).toBe(false);
  });

  it.fails(
    'T1 (desired): provider output exposes explicit buyer/winner relationships',
    () => {
      const record = mapNoticeToRecords(notice, NOW)[0]!;
      const ted = record.attributes?.ted as Record<string, unknown>;
      expect(ted).toHaveProperty('relationships');
    },
  );

  it('T2 (characterization): downstream scoring ignores TED buyer facts', () => {
    const base: Omit<CompanyForScoring, 'attributes'> = {
      name: 'Pompes Martin SAS',
      domain: 'pompes-martin.example',
      country: 'FR',
      industry: 'manufacturing',
      employeeCount: 80,
      revenueUsd: null,
      status: 'NEW',
      contacts: [
        {
          title: 'CEO',
          seniority: 'c_level',
          contactPoints: [{ type: 'email', status: 'VALID' }],
        },
      ],
      companyContactPoints: [],
    };
    const icp: IcpForScoring = {
      rules: [{ kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'manufacturing' }],
      triggerSignals: [],
      committeeRoles: [],
    };

    const withBuyerFacts = scoreLead(
      {
        ...base,
        attributes: {
          ted: { buyer_countries: ['DE'], buyer_names: ['Stadtwerke München'] },
        },
      },
      icp,
    );
    const withoutBuyerFacts = scoreLead({ ...base, attributes: null }, icp);

    // Buyer facts do not change the score/queue at all: the downstream does not read them.
    expect(withBuyerFacts.scores).toEqual(withoutBuyerFacts.scores);
    expect(withBuyerFacts.queue).toBe(withoutBuyerFacts.queue);
  });

  it.fails(
    'T2 (desired): a DE-only target does not accept a FR winner without buyer-role evidence',
    () => {
      const icp: IcpForScoring = {
        rules: [{ kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'manufacturing' }],
        triggerSignals: [],
        committeeRoles: [],
      };
      const result = scoreLead(
        {
          name: 'Pompes Martin SAS',
          domain: 'pompes-martin.example',
          country: 'FR',
          industry: 'manufacturing',
          employeeCount: 80,
          revenueUsd: null,
          status: 'NEW',
          attributes: {
            ted: { buyer_countries: ['DE'], buyer_names: ['Stadtwerke München'] },
          },
          contacts: [
            {
              title: 'CEO',
              seniority: 'c_level',
              contactPoints: [{ type: 'email', status: 'VALID' }],
            },
          ],
          companyContactPoints: [],
        },
        icp,
      );
      expect(result.queue).toBe('rejected');
    },
  );
});
