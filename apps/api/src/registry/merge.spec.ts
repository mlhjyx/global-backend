import { describe, expect, it } from 'vitest';
import {
  proposeEntityLinks,
  trigramDice,
  trigrams,
  type LinkableEntity,
} from './merge';

function linkable(overrides: Partial<LinkableEntity> = {}): LinkableEntity {
  return {
    scheme: 'gb_crn',
    regNumber: '12345678',
    country: 'GB',
    nameNorm: 'muster pumpen',
    lei: null,
    vatId: null,
    website: null,
    identifiers: null,
    ...overrides,
  };
}

const LEI = '529900T8BM49AURSDO55';

describe('proposeEntityLinks — hard keys', () => {
  it('links entities sharing a LEI as CONFIRMED SAME, in canonical order', () => {
    const a = linkable({ scheme: 'lei', regNumber: LEI, country: 'DE', lei: LEI, nameNorm: 'muster pumpen' });
    const b = linkable({ scheme: 'gb_crn', regNumber: '12345678', lei: LEI.toLowerCase() });
    const proposals = proposeEntityLinks([a, b]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      leftScheme: 'gb_crn',
      leftRegNumber: '12345678',
      rightScheme: 'lei',
      rightRegNumber: LEI,
      rule: 'lei_exact',
      linkType: 'SAME',
      status: 'CONFIRMED',
    });
    // 输入顺序无关
    expect(proposeEntityLinks([b, a])).toEqual(proposals);
  });

  it('is namespace-safe: same number under different schemes never links', () => {
    const a = linkable({ scheme: 'gb_crn', regNumber: '12345678' });
    const b = linkable({ scheme: 'fr_siren', regNumber: '12345678', country: 'FR' });
    expect(proposeEntityLinks([a, b])).toEqual([]);
  });

  it('links cross-references through identifiers[] against the primary key', () => {
    const gleif = linkable({
      scheme: 'lei',
      regNumber: LEI,
      country: 'GB',
      lei: LEI,
      identifiers: [{ scheme: 'gb_crn', value: '12345678' }],
    });
    const ch = linkable();
    const proposals = proposeEntityLinks([gleif, ch]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      rule: 'identifier_exact',
      linkType: 'SAME',
      status: 'CONFIRMED',
      evidence: { identifier: 'gb_crn:12345678' },
    });
  });

  it('proposes VAT matches for human confirmation (VIES not yet wired)', () => {
    const a = linkable({ vatId: 'DE291499156' });
    const b = linkable({ scheme: 'de_hrb', regNumber: 'HRB 999', country: 'DE', vatId: 'de 291 499 156' });
    const proposals = proposeEntityLinks([a, b]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ rule: 'vat_exact', linkType: 'SAME', status: 'PROPOSED' });
  });

  it('proposes shared domains as UNCERTAIN (group portal vs same entity needs a human)', () => {
    const a = linkable({ website: 'https://www.muster-pumpen.de' });
    const b = linkable({ scheme: 'de_hrb', regNumber: 'HRB 999', country: 'DE', website: 'muster-pumpen.de' });
    const proposals = proposeEntityLinks([a, b]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      rule: 'domain_exact',
      linkType: 'UNCERTAIN',
      status: 'PROPOSED',
    });
  });

  it('keeps the strongest rule when multiple keys match, recording the rest as alsoMatchedBy', () => {
    const a = linkable({ lei: LEI, vatId: 'DE291499156', website: 'muster-pumpen.de' });
    const b = linkable({
      scheme: 'lei',
      regNumber: LEI,
      country: 'DE',
      lei: LEI,
      vatId: 'DE291499156',
      website: 'muster-pumpen.de',
    });
    const proposals = proposeEntityLinks([a, b]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.rule).toBe('lei_exact');
    const evidence = proposals[0]!.evidence as { alsoMatchedBy?: string[] };
    expect(evidence.alsoMatchedBy).toEqual(['domain_exact@PROPOSED', 'vat_exact@PROPOSED']);
  });
});

describe('trigram candidate pairs', () => {
  it('computes Dice similarity with boundary padding', () => {
    expect(trigramDice('muster pumpen', 'muster pumpen')).toBe(1);
    expect(trigramDice('muster pumpen', 'muster pumpan')).toBeGreaterThan(0.6);
    expect(trigramDice('muster pumpen', 'beispiel ventile')).toBeLessThan(0.2);
    expect(trigrams('ab')).toEqual(new Set(['\u0002ab', 'ab\u0003']));
  });

  it('creates PROPOSED UNCERTAIN candidates only — never auto-merges by name', () => {
    const a = linkable({ nameNorm: 'muster pumpen' });
    const b = linkable({ scheme: 'de_hrb', regNumber: 'HRB 1', country: 'GB', nameNorm: 'muster pumpan' });
    const proposals = proposeEntityLinks([a, b]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      rule: 'name_trigram',
      linkType: 'UNCERTAIN',
      status: 'PROPOSED',
    });
    expect(proposals[0]!.score).toBeGreaterThanOrEqual(0.6);
  });

  it('blocks by country and first 4 name characters', () => {
    const a = linkable({ nameNorm: 'muster pumpen' });
    const otherCountry = linkable({ scheme: 'de_hrb', regNumber: 'HRB 1', country: 'DE', nameNorm: 'muster pumpan' });
    const otherPrefix = linkable({ scheme: 'de_hrb', regNumber: 'HRB 2', country: 'GB', nameNorm: 'xuster pumpan' });
    expect(proposeEntityLinks([a, otherCountry, otherPrefix])).toEqual([]);
  });

  it('does not duplicate a pair already linked by a hard key', () => {
    const a = linkable({ lei: LEI, nameNorm: 'muster pumpen' });
    const b = linkable({ scheme: 'de_hrb', regNumber: 'HRB 1', country: 'GB', lei: LEI, nameNorm: 'muster pumpan' });
    const proposals = proposeEntityLinks([a, b]);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.rule).toBe('lei_exact');
  });

  it('is deterministic regardless of input order', () => {
    const entities = [
      linkable({ nameNorm: 'muster pumpen' }),
      linkable({ scheme: 'de_hrb', regNumber: 'HRB 1', country: 'GB', nameNorm: 'muster pumpan' }),
      linkable({ scheme: 'de_hrb', regNumber: 'HRB 2', country: 'GB', nameNorm: 'muster pumpen' }),
    ];
    const forward = proposeEntityLinks(entities);
    const backward = proposeEntityLinks([...entities].reverse());
    expect(backward).toEqual(forward);
  });
});
