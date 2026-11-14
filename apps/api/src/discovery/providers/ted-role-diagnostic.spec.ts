import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TedAwardNotice } from '../../adapters/ted-api';
import { scoreLead, type CompanyForScoring, type IcpForScoring } from '../../lead/scoring';
import { mapNoticeToRecords } from './ted.provider';

/**
 * PR-03 diagnostic + PR-03b fix contract.
 *
 * PR-03 proved the residual TED risk on both sides: the provider emitted no explicit
 * buyer/winner relationship, and downstream treated a winner record as a potential
 * buyer. PR-03b makes the relationship explicit (`self_role` + `relationships`) and
 * adds a flag-gated downstream gate (`TED_BUYER_ROLE_GATE`, default off):
 *  - winner-only records are rejected from buyer queues when the gate is on;
 *  - TED's counterparty facts no longer feed the Intent keyword proxy when the gate is on.
 * Records without `self_role` (legacy data) are unaffected either way.
 */

const NOW = '2026-11-12T00:00:00.000Z';

afterEach(() => vi.unstubAllEnvs());

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

describe('PR-03/PR-03b TED buyer/winner contract', () => {
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

  it('T1: provider output carries the winner role and explicit buyer/winner relationships', () => {
    const record = mapNoticeToRecords(notice, NOW)[0]!;
    const ted = record.attributes?.ted as Record<string, unknown>;

    // 记录主体仍是中标方（FR）；买方国家在 buyer_countries 保留源始 alpha-3。
    expect(record.country).toBe('FR');
    expect(ted.buyer_countries).toEqual(['DEU']);
    expect(ted.self_role).toBe('winner');
    expect(ted.relationships).toEqual([
      { role: 'buyer', name: 'Stadtwerke München', country: 'DE' },
      {
        role: 'winner',
        name: 'Pompes Martin SAS',
        country: 'FR',
        identifier: 'FR12345678901',
      },
    ]);
  });

  it('T2: with the gate off (default), legacy behavior is unchanged', () => {
    const withFacts = scoreLead(
      {
        ...base,
        attributes: {
          ted: { buyer_countries: ['DEU'], buyer_names: ['Stadtwerke München'], self_role: 'winner' },
        },
      },
      icp,
    );
    const withoutFacts = scoreLead({ ...base, attributes: null }, icp);

    expect(withFacts.scores).toEqual(withoutFacts.scores);
    expect(withFacts.queue).toBe(withoutFacts.queue);
  });

  it('T2: with the gate on, a winner-only record never enters a buyer queue', () => {
    vi.stubEnv('TED_BUYER_ROLE_GATE', 'on');
    const result = scoreLead(
      {
        ...base,
        attributes: {
          ted: { buyer_countries: ['DEU'], buyer_names: ['Stadtwerke München'], self_role: 'winner' },
        },
      },
      icp,
    );
    expect(result.queue).toBe('rejected');
    expect(result.detail.reasonCodes).toContain('TED_WINNER_SUPPLY_SIDE');
  });

  it('T2: with the gate on, buyer-role evidence is not rejected by the TED gate', () => {
    vi.stubEnv('TED_BUYER_ROLE_GATE', 'on');
    const result = scoreLead(
      {
        ...base,
        attributes: { ted: { buyer_countries: ['DEU'], self_role: 'buyer' } },
      },
      icp,
    );
    expect(result.detail.reasonCodes ?? []).not.toContain('TED_WINNER_SUPPLY_SIDE');
  });

  it('T2b: with the gate on, TED counterparty facts do not feed the Intent keyword proxy', () => {
    vi.stubEnv('TED_BUYER_ROLE_GATE', 'on');
    const triggered: IcpForScoring = { ...icp, triggerSignals: ['stadtwerke'] };
    const withFacts = scoreLead(
      {
        ...base,
        attributes: {
          ted: { buyer_countries: ['DEU'], buyer_names: ['Stadtwerke München'], self_role: 'buyer' },
        },
      },
      triggered,
    );
    const withoutFacts = scoreLead({ ...base, attributes: null }, triggered);

    expect(withFacts.scores.intent).toBe(withoutFacts.scores.intent);
  });

  it('T2: with the gate off, a same-country winner is still accepted (rollout safety)', () => {
    const result = scoreLead(
      {
        ...base,
        attributes: {
          ted: { buyer_countries: ['FRA'], buyer_names: ['Ville de Paris'], self_role: 'winner' },
        },
      },
      icp,
    );
    expect(result.queue).not.toBe('rejected');
  });
});
