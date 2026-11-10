import { describe, expect, it } from 'vitest';
import {
  blockingKeyFor,
  CompanyIdentitySnapshot,
  decideCompanyLegalLinks,
  DEFAULT_MATCH_CONFIG,
  LegalEntityCandidate,
  scoreProbabilistic,
} from './entity-matching';

const LEI_A = '529900T8BM49AURSDO55';
const LEI_B = '5493001KJTIIGC8Y1R12';

function company(overrides: Partial<CompanyIdentitySnapshot> = {}): CompanyIdentitySnapshot {
  return {
    companyId: '11111111-1111-4111-8111-111111111111',
    name: 'Siemens AG',
    legalName: 'Siemens Aktiengesellschaft',
    country: 'DE',
    address: 'Werner-von-Siemens-Str. 1, 80333 München',
    identifiers: [],
    ...overrides,
  };
}

function entity(overrides: Partial<LegalEntityCandidate> = {}): LegalEntityCandidate {
  return {
    entityId: '22222222-2222-4222-8222-222222222222',
    scheme: 'lei',
    value: LEI_A,
    country: 'DE',
    name: 'Siemens Aktiengesellschaft',
    address: 'Werner-von-Siemens-Str. 1, 80333 München',
    status: 'active',
    ...overrides,
  };
}

describe('确定性键匹配（W2）', () => {
  it('LEI 完全一致 → deterministic auto，哪怕名字完全不同（确定性优先于相似度）', async () => {
    const decisions = await decideCompanyLegalLinks(
      company({ identifiers: [{ scheme: 'lei', value: LEI_A }] }),
      [entity({ name: 'Voellig Anderer Name GmbH', address: null })],
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      status: 'auto',
      matchMethod: 'deterministic',
      matchRule: 'lei_exact',
      confidence: 1,
    });
  });

  it('HRB 命中只落 review（按法院分配，同号风险）', async () => {
    const decisions = await decideCompanyLegalLinks(
      company({ name: 'Müller GmbH', legalName: null, identifiers: [{ scheme: 'hrb', value: 'HRB12345' }] }),
      [entity({ scheme: 'hrb', value: 'HRB12345', name: 'Müller GmbH', address: null })],
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ status: 'review', matchMethod: 'deterministic', matchRule: 'hrb_exact' });
  });

  it('VAT：无 VIES 校验器 → review；VIES 通过 → auto；VIES 不通过/不可用 → review 且留证', async () => {
    const vatEntity = entity({ scheme: 'vat', value: 'DE291499156', name: 'Müller GmbH', address: null });
    const snapshot = company({
      name: 'Müller GmbH',
      legalName: null,
      identifiers: [{ scheme: 'vat', value: 'DE291499156' }],
    });

    const unvalidated = await decideCompanyLegalLinks(snapshot, [vatEntity]);
    expect(unvalidated[0]).toMatchObject({ status: 'review', matchMethod: 'deterministic' });

    const valid = await decideCompanyLegalLinks(snapshot, [vatEntity], {
      vatValidator: { provider: 'vies_fixture', validate: async () => ({ valid: true, provider: 'vies_fixture' }) },
    });
    expect(valid[0]).toMatchObject({ status: 'auto', confidence: 1 });
    expect(valid[0]!.evidence).toMatchObject({ vies: { provider: 'vies_fixture', valid: true } });

    const invalid = await decideCompanyLegalLinks(snapshot, [vatEntity], {
      vatValidator: { provider: 'vies_fixture', validate: async () => ({ valid: false, provider: 'vies_fixture' }) },
    });
    expect(invalid[0]!.status).toBe('review');

    const down = await decideCompanyLegalLinks(snapshot, [vatEntity], {
      vatValidator: {
        provider: 'vies_fixture',
        validate: async () => {
          throw new Error('vies down');
        },
      },
    });
    expect(down[0]!.status).toBe('review');
    expect(down[0]!.evidence).toMatchObject({ vies: { unavailable: true } });
  });
});

describe('同名异法人反例（W2 硬门）', () => {
  it('公司已有 HRB 键时，同名同国的另一法人即使名字/地址完全一致也 rejected', async () => {
    const companySnapshot = company({
      name: 'Müller GmbH',
      legalName: null,
      identifiers: [{ scheme: 'hrb', value: 'HRB111' }],
    });
    const sameNameOtherEntity = entity({ scheme: 'hrb', value: 'HRB222', name: 'Müller GmbH' });
    const decisions = await decideCompanyLegalLinks(companySnapshot, [sameNameOtherEntity]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      status: 'rejected',
      matchMethod: 'deterministic',
      matchRule: 'identifier_conflict',
      confidence: 0,
    });
    expect(decisions[0]!.evidence).toMatchObject({
      scheme: 'hrb',
      companyValues: ['HRB111'],
      entityValue: 'HRB222',
    });
  });

  it('国家域内编号不跨国命中：DE 的 HRB 12345 与 AT 的同号实体是不同的法人', async () => {
    const snapshot = company({
      name: 'Müller GmbH',
      legalName: null,
      identifiers: [{ scheme: 'hrb', value: 'HRB12345', country: 'DE' }],
    });
    const decisions = await decideCompanyLegalLinks(snapshot, [
      entity({ scheme: 'hrb', value: 'HRB12345', country: 'AT', name: 'Müller GmbH', address: null }),
    ]);
    expect(decisions).toEqual([]);
  });

  it('LEI 冲突同样 rejected，且不因概率相似度翻案', async () => {
    const decisions = await decideCompanyLegalLinks(
      company({ identifiers: [{ scheme: 'lei', value: LEI_A }] }),
      [entity({ value: LEI_B })],
    );
    expect(decisions[0]!.status).toBe('rejected');
    expect(decisions[0]!.matchRule).toBe('identifier_conflict');
    expect(decisions[0]!.evidence).toMatchObject({ wouldBePosterior: expect.any(Number) });
  });

  it('键冲突但名字毫不相似 → 不留 rejected 噪音行', async () => {
    const decisions = await decideCompanyLegalLinks(
      company({
        name: 'Siemens AG',
        legalName: null,
        address: null,
        identifiers: [{ scheme: 'lei', value: LEI_A }],
      }),
      [entity({ value: LEI_B, name: 'Voellig Anderer Name GmbH', address: null })],
    );
    expect(decisions).toEqual([]);
  });
});

describe('Fellegi–Sunter 概率匹配与双阈值分档（W2）', () => {
  it('blocking：国家或归一名不同 → 不评分、不产出', async () => {
    const snapshot = company({ identifiers: [] });
    expect(blockingKeyFor('DE', 'Siemens AG')).toBe(blockingKeyFor('de', 'siemens aktiengesellschaft'));
    expect(scoreProbabilistic(snapshot, entity({ scheme: 'ch', value: 'SC123456', country: 'GB' }))).toBeNull();
    expect(
      scoreProbabilistic(snapshot, entity({ scheme: 'ch', value: 'SC123456', name: 'Deutsche Telekom AG' })),
    ).toBeNull();
    const decisions = await decideCompanyLegalLinks(snapshot, [
      entity({ scheme: 'ch', value: 'SC123456', country: 'GB' }),
    ]);
    expect(decisions).toEqual([]);
  });

  it('auto 档：名称+国家+地址全部一致 → 后验 ≥ autoThreshold', async () => {
    const decisions = await decideCompanyLegalLinks(company(), [
      entity({ scheme: 'ch', value: 'SC123456' }),
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      status: 'auto',
      matchMethod: 'probabilistic',
      matchRule: 'fellegi_sunter_v1',
    });
    const assessment = scoreProbabilistic(company(), entity({ scheme: 'ch', value: 'SC123456' }))!;
    expect(assessment.posterior).toBeGreaterThanOrEqual(DEFAULT_MATCH_CONFIG.autoThreshold);
    expect(decisions[0]!.confidence).toBe(assessment.posterior);
  });

  it('review 档：名称+国家一致但无地址佐证 → reviewThreshold ≤ 后验 < autoThreshold', async () => {
    const snapshot = company({ address: null });
    const decisions = await decideCompanyLegalLinks(snapshot, [
      entity({ scheme: 'ch', value: 'SC123456', address: null }),
    ]);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.status).toBe('review');
    const assessment = scoreProbabilistic(snapshot, entity({ scheme: 'ch', value: 'SC123456', address: null }))!;
    expect(assessment.posterior).toBeGreaterThanOrEqual(DEFAULT_MATCH_CONFIG.reviewThreshold);
    expect(assessment.posterior).toBeLessThan(DEFAULT_MATCH_CONFIG.autoThreshold);
  });

  it('低于 review 阈值：名字只部分相似 → 不产出链接', async () => {
    const snapshot = company({
      name: 'Siemens Energy AG',
      legalName: null,
      address: null,
    });
    const candidate = entity({ scheme: 'ch', value: 'SC123456', name: 'Siemens Aktiengesellschaft', address: null });
    const assessment = scoreProbabilistic(snapshot, candidate)!;
    expect(assessment.posterior).toBeLessThan(DEFAULT_MATCH_CONFIG.reviewThreshold);
    const decisions = await decideCompanyLegalLinks(snapshot, [candidate]);
    expect(decisions).toEqual([]);
  });

  it('确定性关系存在的实体不进入概率匹配（既不命中也不冲突时按概率，命名相同的输出唯一）', async () => {
    const snapshot = company({ identifiers: [{ scheme: 'lei', value: LEI_A }] });
    const decisions = await decideCompanyLegalLinks(snapshot, [
      entity({ value: LEI_A }), // 命中 → auto
      entity({ entityId: null, scheme: 'ch', value: 'SC123456' }), // 不同 scheme → 概率
    ]);
    expect(decisions.map((decision) => [decision.matchMethod, decision.status])).toEqual([
      ['deterministic', 'auto'],
      ['probabilistic', 'auto'],
    ]);
  });

  it('重复候选（同 scheme+value）只判定一次；输出排序 auto → review → rejected', async () => {
    const snapshot = company({
      name: 'Müller GmbH',
      legalName: null,
      identifiers: [{ scheme: 'hrb', value: 'HRB111' }],
    });
    const decisions = await decideCompanyLegalLinks(snapshot, [
      entity({ scheme: 'hrb', value: 'HRB222', name: 'Müller GmbH', address: null }),
      entity({ scheme: 'hrb', value: 'HRB111', name: 'Müller GmbH', address: null }),
      entity({ scheme: 'hrb', value: 'HRB111', name: 'Müller GmbH', address: null }),
    ]);
    expect(decisions.map((decision) => [decision.entity.value, decision.status])).toEqual([
      ['HRB111', 'review'],
      ['HRB222', 'rejected'],
    ]);
  });
});
