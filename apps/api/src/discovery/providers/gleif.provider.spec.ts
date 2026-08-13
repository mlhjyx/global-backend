import { describe, expect, it, vi } from 'vitest';
import { GleifEnrichmentProvider, pickBest } from './gleif.provider';
import { GleifRecord } from '../../adapters/gleif';

function rec(lei: string, legalName: string, extra: Partial<GleifRecord> = {}): GleifRecord {
  return { lei, legalName, ...extra };
}

// 真实 GLEIF "TRUMPF" contains 检索会返回的一组噪声候选（含非目标同 token 公司）
const TRUMPF_CANDIDATES = [
  rec('5299007DQPD2QYB17B54', 'Trumpf Vermögensverwaltung GbR'),
  rec('875500QIWPHRUM3LQ468', 'Brandt & Trumpf GmbH'),
  rec('529900WJ5PTEQ4V00I90', 'TRUMPF Laser SE'),
  rec('EXACTMATCHLEI00000001', 'TRUMPF GmbH + Co. KG'),
];

describe('GLEIF 最佳匹配 + 置信度 + 歧义护栏（绝不贴错身份）', () => {
  it('精确规范化名 → 满分命中且甩开次佳', () => {
    const best = pickBest('TRUMPF GmbH + Co. KG', TRUMPF_CANDIDATES);
    expect(best?.record.lei).toBe('EXACTMATCHLEI00000001');
    expect(best?.score).toBe(1);
    expect(best?.margin).toBeGreaterThanOrEqual(0.1);
  });

  it('查询完全被候选包含 → 强分选中更具体的那条（而非同 token 的泛名/异公司）', () => {
    const best = pickBest('TRUMPF Laser', TRUMPF_CANDIDATES);
    expect(best?.record.legalName).toBe('TRUMPF Laser SE');
    expect(best?.score).toBeGreaterThanOrEqual(0.72);
    expect(best?.margin).toBeGreaterThanOrEqual(0.1); // 甩开 "TRUMPF"/"Brandt & Trumpf"
  });

  it('拼写全称法人形式与缩写归一等价："Siemens AG" ≡ "Siemens Aktiengesellschaft"', () => {
    // 模拟真实 GLEIF 对 "Siemens" 的 123 条 contains 命中（真身埋在基金/基金会里）
    const siemens = [
      rec('F1', 'Siemens-Fonds Siemens-Rente'),
      rec('F2', 'Siemens Auszahlungsfonds'),
      rec('S1', 'Siemens Stiftung'),
      rec('AG', 'Siemens Aktiengesellschaft'),
      rec('F3', 'Siemens EuroCash'),
    ];
    const best = pickBest('Siemens AG', siemens);
    expect(best?.record.lei).toBe('AG'); // 精确命中真身 Siemens Aktiengesellschaft
    expect(best?.score).toBe(1);
    expect(best?.margin).toBeGreaterThanOrEqual(0.1);
  });

  it('多个同前缀实体并列、无突出者 → margin 低于护栏（调用方据此 miss，不乱贴）', () => {
    const ambiguous = [
      rec('A', 'Müller Präzision GmbH'),
      rec('B', 'Müller Technik GmbH'),
      rec('C', 'Müller Bau GmbH'),
    ];
    const best = pickBest('Müller', ambiguous);
    expect(best!.score).toBeGreaterThanOrEqual(0.72); // 单看分数够高
    expect(best!.margin).toBeLessThan(0.1); // 但没有突出者 → 歧义 → 不贴
  });

  it('只共享零核心 token 的公司分数低于门槛（被拒绝）', () => {
    const noise = [rec('X', 'Schmidt Präzision GmbH'), rec('Y', 'Weber Automotive AG')];
    const best = pickBest('Bayerische Motoren Werke', noise);
    expect(best!.score).toBeLessThan(0.72);
  });

  it('空/无核心 token 名不误命中', () => {
    expect(pickBest('GmbH', TRUMPF_CANDIDATES)).toBeNull(); // 全是法人后缀 → 无 token
  });

  it('候选为空返回 null', () => {
    expect(pickBest('TRUMPF', [])).toBeNull();
  });
});

const executionContext = { workspaceId: 'ws', runId: 'run', correlationId: 'corr' };

function gleifRecord(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

describe('GleifEnrichmentProvider runtime behavior', () => {
  it('fails closed without a broker and on search failures', async () => {
    await expect(
      new GleifEnrichmentProvider().enrichCompany(
        { name: 'Pump GmbH', country: 'DE' } as never,
        executionContext,
      ),
    ).resolves.toMatchObject({ matched: false });
    const invoke = vi.fn(async () => {
      throw new Error('denied');
    });
    await expect(
      new GleifEnrichmentProvider({ broker: { invoke } as never }).enrichCompany(
        { name: 'Pump GmbH', country: 'DE' } as never,
        executionContext,
      ),
    ).resolves.toMatchObject({ matched: false });
  });

  it('retries without country after an empty constrained search', async () => {
    const invoke = vi
      .fn()
      .mockResolvedValueOnce({ data: { records: [] } })
      .mockResolvedValueOnce({ data: { records: [gleifRecord()] } });
    const result = await new GleifEnrichmentProvider({ broker: { invoke } as never }).enrichCompany(
      { name: 'Pump GmbH', country: ' DE ' } as never,
      executionContext,
    );
    expect(result).toMatchObject({ matched: true, attributes: { lei: 'LEI-1' } });
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      'gleif.fetch',
      expect.not.objectContaining({ country: expect.anything() }),
      expect.anything(),
    );
  });

  it('returns a miss when fallback fails, remains empty, or identity is ambiguous', async () => {
    const fallbackFails = vi
      .fn()
      .mockResolvedValueOnce({ data: { records: [] } })
      .mockRejectedValueOnce(new Error('fallback failed'));
    await expect(
      new GleifEnrichmentProvider({ broker: { invoke: fallbackFails } as never }).enrichCompany(
        { name: 'Pump GmbH', country: 'DE' } as never,
        executionContext,
      ),
    ).resolves.toMatchObject({ matched: false });

    const empty = vi.fn(async () => ({ data: {} }));
    await expect(
      new GleifEnrichmentProvider({ broker: { invoke: empty } as never }).enrichCompany(
        { name: '', country: undefined } as never,
        executionContext,
      ),
    ).resolves.toMatchObject({ matched: false });

    const ambiguous = vi.fn(async () => ({
      data: { records: [gleifRecord({ lei: 'A' }), gleifRecord({ lei: 'B' })] },
    }));
    await expect(
      new GleifEnrichmentProvider({ broker: { invoke: ambiguous } as never }).enrichCompany(
        { name: 'Pump GmbH', country: 'DE' } as never,
        executionContext,
      ),
    ).resolves.toMatchObject({ matched: false });
  });

  it('adds parent facts while tolerating failed parent lookups', async () => {
    const invoke = vi.fn(async (_tool: string, input: { op: string }) => {
      if (input.op === 'search') {
        return {
          data: {
            records: [gleifRecord({ hasDirectParent: true, hasUltimateParent: true, legalFormId: 'UNKNOWN' })],
          },
        };
      }
      if (input.op === 'directParent') {
        return { data: { parent: { lei: 'PARENT', legalName: 'Parent AG' } } };
      }
      return { data: { parent: { lei: 'ULTIMATE', legalName: 'Ultimate SE' } } };
    });
    const result = await new GleifEnrichmentProvider({ broker: { invoke } as never }).enrichCompany(
      { name: 'Pump GmbH', country: 'DE' } as never,
      executionContext,
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
      if (input.op === 'search') return { data: { records: [gleifRecord({ hasDirectParent: true })] } };
      throw new Error('parent unavailable');
    });
    await expect(
      new GleifEnrichmentProvider({ broker: { invoke: failedParent } as never }).enrichCompany(
        { name: 'Pump GmbH', country: 'DE' } as never,
        executionContext,
      ),
    ).resolves.not.toHaveProperty('attributes.parent_lei');
  });

  it('does not duplicate self as ultimate parent', async () => {
    const invoke = vi.fn(async (_tool: string, input: { op: string }) =>
      input.op === 'search'
        ? { data: { records: [gleifRecord({ hasUltimateParent: true })] } }
        : { data: { parent: { lei: 'LEI-1', legalName: 'Pump GmbH' } } },
    );
    const result = await new GleifEnrichmentProvider({ broker: { invoke } as never }).enrichCompany(
      { name: 'Pump GmbH', country: 'DE' } as never,
      executionContext,
    );
    expect(result.attributes).not.toHaveProperty('ultimate_parent_lei');
  });
});
