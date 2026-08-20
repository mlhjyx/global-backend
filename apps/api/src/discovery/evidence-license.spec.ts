import { describe, expect, it } from 'vitest';
import {
  assertProductDiscoveryProvenance,
  isProductDiscoveryRawRecord,
  isSyntheticDiscoveryProvenance,
  resolveEvidenceLicense,
  syntheticDiscoveryEntityIds,
  SyntheticDiscoveryProvenanceError,
} from './evidence-license';

describe('§8.5 discovery 证据许可归一（resolveEvidenceLicense）', () => {
  it('记录声明许可优先（TED 绿事实 CC BY 4.0 署名义务）', () => {
    expect(resolveEvidenceLicense('CC BY 4.0', 'ted')).toBe('CC BY 4.0');
  });

  it('未声明 + sandbox → sandbox（既有行为不变）', () => {
    expect(resolveEvidenceLicense(undefined, 'sandbox')).toBe('sandbox');
  });

  it('未声明 + 其它 provider → licensed（既有行为字节级不变）', () => {
    expect(resolveEvidenceLicense(undefined, 'wikidata')).toBe('licensed');
    expect(resolveEvidenceLicense(undefined, 'public_web')).toBe('licensed');
  });

  it('未声明 + ted → licensed（不因 providerKey 静默假定许可，必须记录显式声明）', () => {
    expect(resolveEvidenceLicense(undefined, 'ted')).toBe('licensed');
  });

  it('声明可覆盖回退（如 CC0 源）', () => {
    expect(resolveEvidenceLicense('CC0-1.0', 'wikidata')).toBe('CC0-1.0');
  });
});

describe('product discovery provenance boundary', () => {
  it.each([
    { providerKey: 'sandbox' },
    { providerKey: 'SANDBOX' },
    { license: 'sandbox' },
    { providerKey: 'public_web', license: ' sandbox ' },
  ])('classifies historical synthetic provenance without deleting it: %j', (provenance) => {
    expect(isSyntheticDiscoveryProvenance(provenance)).toBe(true);
    expect(() => assertProductDiscoveryProvenance(provenance)).toThrow(SyntheticDiscoveryProvenanceError);
  });

  it('allows real provider provenance with an explicit commercial/public license', () => {
    const provenance = { providerKey: 'companies_house', license: 'OGL-UK-3.0' };
    expect(isSyntheticDiscoveryProvenance(provenance)).toBe(false);
    expect(() => assertProductDiscoveryProvenance(provenance)).not.toThrow();
  });

  it('treats absent and non-string provenance markers as product-neutral', () => {
    expect(isSyntheticDiscoveryProvenance(null)).toBe(false);
    expect(isSyntheticDiscoveryProvenance(undefined)).toBe(false);
    expect(isSyntheticDiscoveryProvenance({ providerKey: 42, license: {} })).toBe(false);
  });

  it('reads a synthetic marker only from an object raw payload', () => {
    expect(isProductDiscoveryRawRecord({ providerKey: 'public_web', payload: null })).toBe(true);
    expect(isProductDiscoveryRawRecord({ providerKey: 'public_web', payload: 'fixture' })).toBe(true);
    expect(
      isProductDiscoveryRawRecord({
        providerKey: 'public_web',
        payload: { license: ' fixture ' },
      }),
    ).toBe(false);
  });

  it('collects only quarantined entity ids from a bounded evidence batch', () => {
    expect(
      [...syntheticDiscoveryEntityIds([
        { entityId: 'company-real', providerKey: 'companies_house', license: 'OGL-UK-3.0' },
        { entityId: 'company-sandbox', providerKey: 'sandbox', license: 'sandbox' },
        { entityId: 'contact-fixture', providerKey: 'public_web', license: 'fixture' },
      ])],
    ).toEqual(['company-sandbox', 'contact-fixture']);
  });
});
