import { describe, expect, it } from 'vitest';
import { fieldEvidenceProvenance } from './discovery-company-materialization-canonical';

/**
 * L1（交付闭环设计 §8）：物化证据补写来源 URL，并把 fetched_at 改用原始记录的抓取时间。
 * 只有 https、有界的 URL 才落库（迁移里有同样的 CHECK）。
 */
describe('fieldEvidenceProvenance', () => {
  it('carries the raw record url and fetch time', () => {
    const fetchedAt = new Date('2026-10-01T00:00:00.000Z');
    expect(fieldEvidenceProvenance({ sourceUrl: 'https://acme.example/company', fetchedAt })).toEqual({
      sourceUrl: 'https://acme.example/company',
      fetchedAt,
    });
  });

  it('drops a missing, non-https or over-long url and keeps a missing fetch time null', () => {
    expect(fieldEvidenceProvenance(null)).toEqual({ sourceUrl: null, fetchedAt: null });
    expect(fieldEvidenceProvenance({ sourceUrl: null, fetchedAt: null })).toEqual({ sourceUrl: null, fetchedAt: null });
    expect(
      fieldEvidenceProvenance({ sourceUrl: 'http://acme.example/company', fetchedAt: null }),
    ).toEqual({ sourceUrl: null, fetchedAt: null });
    const long = `https://acme.example/${'a'.repeat(2100)}`;
    expect(fieldEvidenceProvenance({ sourceUrl: long, fetchedAt: null })).toEqual({ sourceUrl: null, fetchedAt: null });
  });
});
