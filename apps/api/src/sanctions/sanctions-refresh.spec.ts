import { describe, expect, it } from 'vitest';
import {
  countryToAlpha2,
  toDesiredEntity,
  diffSanctionsEntities,
  type ExistingEntityRow,
} from './sanctions-refresh.service';
import type { ParsedSanctionsEntity } from '../adapters/ofac-xml';

const ent = (over: Partial<ParsedSanctionsEntity> = {}): ParsedSanctionsEntity => ({
  externalId: '36',
  primaryName: 'AEROCARIBBEAN AIRLINES',
  country: 'Cuba',
  programs: ['CUBA'],
  aliases: [{ name: 'AERO-CARIBBEAN', quality: 'strong' }],
  ...over,
});

describe('countryToAlpha2', () => {
  it('OFAC 全名 / EU 代码 → alpha-2', () => {
    expect(countryToAlpha2('Cuba')).toBe('CU');
    expect(countryToAlpha2('RU')).toBe('RU');
    expect(countryToAlpha2('Russia')).toBe('RU');
    expect(countryToAlpha2('IRN')).toBe('IR'); // ISO3
  });
  it('未知/空 → null（matcher 视作 unknown，不误判国别）', () => {
    expect(countryToAlpha2('Neverland')).toBeNull();
    expect(countryToAlpha2(null)).toBeNull();
    expect(countryToAlpha2('')).toBeNull();
  });
});

describe('toDesiredEntity', () => {
  it('归一名 + alpha-2 国别 + rawFeatures 仅绿字段（无 person PII）', () => {
    const d = toDesiredEntity(ent(), '2026-07-13');
    expect(d.country).toBe('CU');
    expect(d.normalizedName).toBe('aerocaribbean airlines');
    expect(d.rawFeatures).toEqual({ addressCountry: 'Cuba' });
    expect(d.listVersion).toBe('2026-07-13');
  });
  it('contentHash 确定（同输入同 hash），字段变则变', () => {
    const a = toDesiredEntity(ent(), 'v1');
    const b = toDesiredEntity(ent(), 'v1');
    const c = toDesiredEntity(ent({ programs: ['CUBA', 'SDGT'] }), 'v1');
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.contentHash).not.toBe(c.contentHash);
  });
  it('别名顺序不同但集合相同 → 同 hash（顺序无关）', () => {
    const a = toDesiredEntity(ent({ aliases: [{ name: 'X', quality: 'strong' }, { name: 'Y', quality: 'weak' }] }), 'v1');
    const b = toDesiredEntity(ent({ aliases: [{ name: 'Y', quality: 'weak' }, { name: 'X', quality: 'strong' }] }), 'v1');
    expect(a.contentHash).toBe(b.contentHash);
  });
});

describe('diffSanctionsEntities', () => {
  const d1 = toDesiredEntity(ent({ externalId: '1' }), 'v1');
  const d2 = toDesiredEntity(ent({ externalId: '2', programs: ['IRAN'] }), 'v1');

  it('全新 → toCreate', () => {
    const diff = diffSanctionsEntities([], [d1, d2]);
    expect(diff.toCreate.map((d) => d.externalId)).toEqual(['1', '2']);
    expect(diff.toUpdate).toEqual([]);
    expect(diff.toWithdrawExternalIds).toEqual([]);
  });

  it('contentHash 未变 → unchanged（不写库）', () => {
    const existing: ExistingEntityRow[] = [{ externalId: '1', contentHash: d1.contentHash, withdrawnAt: null }];
    const diff = diffSanctionsEntities(existing, [d1]);
    expect(diff.unchanged).toBe(1);
    expect(diff.toCreate).toEqual([]);
    expect(diff.toUpdate).toEqual([]);
  });

  it('contentHash 变 → toUpdate；之前撤下现又出现 → toUpdate（复活）', () => {
    const existing: ExistingEntityRow[] = [
      { externalId: '1', contentHash: 'old', withdrawnAt: null },
      { externalId: '2', contentHash: d2.contentHash, withdrawnAt: new Date() },
    ];
    const diff = diffSanctionsEntities(existing, [d1, d2]);
    expect(diff.toUpdate.map((d) => d.externalId).sort()).toEqual(['1', '2']);
  });

  it('本次未出现且尚未撤下 → toWithdraw；已撤下的不重复撤', () => {
    const existing: ExistingEntityRow[] = [
      { externalId: '1', contentHash: d1.contentHash, withdrawnAt: null },
      { externalId: '99', contentHash: 'x', withdrawnAt: null },
      { externalId: '98', contentHash: 'y', withdrawnAt: new Date() },
    ];
    const diff = diffSanctionsEntities(existing, [d1]);
    expect(diff.toWithdrawExternalIds).toEqual(['99']);
  });
});
