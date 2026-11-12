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
 *
 * Scope note: "downstream ignores buyer facts" holds for ICPs without trigger signals.
 * With triggerSignals set, buyer_names feed the Intent keyword proxy (T2b), so a fix
 * must decide whether the TED namespace belongs in that proxy.
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
    const icp: IcpForScoring = {
      rules: [{ kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'manufacturing' }],
      triggerSignals: [],
      committeeRoles: [],
    };

    const withBuyerFacts = scoreLead(
      {
        ...base,
        attributes: {
          ted: { buyer_countries: ['DEU'], buyer_names: ['Stadtwerke München'] },
        },
      },
      icp,
    );
    const withoutBuyerFacts = scoreLead({ ...base, attributes: null }, icp);

    // 该 ICP 没有 triggerSignals：买方事实不改变任何维度与队列（T2b 覆盖有触发词的情形）。
    expect(withBuyerFacts.scores).toEqual(withoutBuyerFacts.scores);
    expect(withBuyerFacts.queue).toBe(withoutBuyerFacts.queue);
  });

  it('T2b (characterization): with trigger signals, TED buyer names feed the intent keyword proxy', () => {
    const icp: IcpForScoring = {
      rules: [{ kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'manufacturing' }],
      triggerSignals: ['stadtwerke'],
      committeeRoles: [],
    };
    const withBuyerFacts = scoreLead(
      {
        ...base,
        attributes: {
          ted: { buyer_countries: ['DEU'], buyer_names: ['Stadtwerke München'] },
        },
      },
      icp,
    );
    const withoutBuyerFacts = scoreLead({ ...base, attributes: null }, icp);

    // 关键词代理扫全部非下划线属性值，buyer_names 也参与 → intent 不同。
    expect(withBuyerFacts.scores.intent).toBeGreaterThan(withoutBuyerFacts.scores.intent);
  });

  it('T2 (characterization): a same-country winner is accepted today (the fix must preserve it)', () => {
    const icp: IcpForScoring = {
      rules: [{ kind: 'MUST_HAVE', field: 'industry', operator: 'eq', value: 'manufacturing' }],
      triggerSignals: [],
      committeeRoles: [],
    };
    const result = scoreLead(
      {
        ...base,
        attributes: {
          ted: { buyer_countries: ['FRA'], buyer_names: ['Ville de Paris'] },
        },
      },
      icp,
    );
    expect(result.queue).not.toBe('rejected');
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
            ted: { buyer_countries: ['DEU'], buyer_names: ['Stadtwerke München'] },
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
