import { describe, expect, it } from 'vitest';
import {
  identityConflictFingerprint,
  normalizeAuthorityIdentifiers,
  ORGANIZATION_SINGLETON_IDENTIFIER_SCHEMES,
  planOrganizationIdentityResolution,
  type OrganizationIdentityAuthorityProfile,
} from './organization-identity-v2';

const PROFILE: OrganizationIdentityAuthorityProfile = {
  providerKey: 'fixture_registry',
  profileVersion: 'v1',
  rules: [
    {
      scheme: 'lei',
      jurisdictions: ['GLOBAL'],
      validator: 'lei-v1',
    },
    {
      scheme: 'registration_number',
      jurisdictions: ['DE', 'FR'],
      validator: 'opaque-v1',
    },
    {
      scheme: 'domain',
      jurisdictions: ['GLOBAL'],
      validator: 'domain-v1',
    },
  ],
};

const VALID_LEI = '529900T8BM49AURSDO55';

describe('organization identity v2 normalization', () => {
  it('uses one shared singleton policy for registry identifiers in every identity entry point', () => {
    expect(ORGANIZATION_SINGLETON_IDENTIFIER_SCHEMES).toEqual(new Set([
      'lei',
      'siren',
      'cik',
      'uei',
      'ted-natid',
      'wikidata-qid',
      'uk-company-number',
      'br-cnpj',
      'ror-id',
      'usdot',
    ]));
  });

  it('normalizes, validates, deduplicates and sorts identifiers independently of input order', () => {
    const left = normalizeAuthorityIdentifiers(PROFILE, [
      {
        scheme: 'registration_number',
        jurisdiction: 'de',
        value: ' HRB 12-34 ',
      },
      { scheme: 'domain', value: 'https://WWW.Example.COM/path' },
      { scheme: 'lei', value: VALID_LEI.toLowerCase() },
      { scheme: 'registration_number', jurisdiction: 'DE', value: 'HRB1234' },
    ]);
    const right = normalizeAuthorityIdentifiers(PROFILE, [
      { scheme: 'lei', value: VALID_LEI },
      { scheme: 'registration_number', jurisdiction: 'DE', value: 'HRB1234' },
      { scheme: 'domain', value: 'example.com' },
    ]);

    expect(left).toEqual(right);
    expect(left.map((identifier) => identifier.key)).toEqual([
      'domain:GLOBAL:example.com',
      'lei:GLOBAL:' + VALID_LEI,
      'registration_number:DE:HRB1234',
    ]);
  });

  it('rejects identifiers outside the provider authority profile and invalid LEIs', () => {
    expect(() => normalizeAuthorityIdentifiers(PROFILE, [{ scheme: 'sec_cik', jurisdiction: 'US', value: '1234' }])).toThrowError(
      /not authorized/i,
    );

    expect(() => normalizeAuthorityIdentifiers(PROFILE, [{ scheme: 'lei', value: '529900T8BM49AURSDO54' }])).toThrowError(/LEI/i);
  });

  it('normalizes checksum-valid ROR IDs and rejects structural or checksum mutations', () => {
    const rorProfile: OrganizationIdentityAuthorityProfile = {
      providerKey: 'ror',
      profileVersion: 'v1',
      rules: [{ scheme: 'ror-id', jurisdictions: ['GLOBAL'], validator: 'ror-id-v1' }],
    };
    expect(normalizeAuthorityIdentifiers(rorProfile, [
      { scheme: 'ror-id', value: 'HTTPS://ROR.ORG/052GG0110' },
    ])[0]).toMatchObject({
      normalizedValue: 'https://ror.org/052gg0110',
      validatorVersion: 'ror-id-v1',
    });
    for (const value of ['052gg0111', '052gg0i10', '052gg01100', 'https://ror.org/052gg0110?x=1']) {
      expect(() => normalizeAuthorityIdentifiers(rorProfile, [{ scheme: 'ror-id', value }]))
        .toThrowError(/ROR ID checksum/i);
    }
  });

  it('normalizes CIK with the dedicated strict validator and rejects decorated or zero values', () => {
    const secProfile: OrganizationIdentityAuthorityProfile = {
      providerKey: 'sec_edgar',
      profileVersion: 'v1',
      rules: [{ scheme: 'cik', jurisdictions: ['US'], validator: 'cik-v1' as never }],
    };
    expect(normalizeAuthorityIdentifiers(secProfile, [
      { scheme: 'cik', jurisdiction: 'US', value: '123' },
    ])[0]).toMatchObject({
      normalizedValue: '0000000123',
      validatorVersion: 'cik-v1',
    });
    for (const value of ['0', '0000000000', 'CIK 123', 'CIK: ----123', '12-3', '12345678901', '１２３']) {
      expect(() => normalizeAuthorityIdentifiers(secProfile, [{ scheme: 'cik', jurisdiction: 'US', value }]))
        .toThrowError(/CIK/i);
    }
  });

  it('accepts the official La Poste SIREN exception while rejecting other invalid SIRENs', () => {
    const sirenProfile: OrganizationIdentityAuthorityProfile = {
      providerKey: 'fr_company',
      profileVersion: 'v1',
      rules: [{ scheme: 'siren', jurisdictions: ['FR'], validator: 'siren-v1' }],
    };

    expect(normalizeAuthorityIdentifiers(sirenProfile, [
      { scheme: 'siren', jurisdiction: 'FR', value: '356 000 000' },
    ])[0]).toMatchObject({
      normalizedValue: '356000000',
      validatorVersion: 'siren-v1',
    });
    expect(() => normalizeAuthorityIdentifiers(sirenProfile, [
      { scheme: 'siren', jurisdiction: 'FR', value: '356000001' },
    ])).toThrowError(/SIREN checksum/i);
  });

  it('normalizes checksum-valid organization NPIs and rejects malformed or invalid values', () => {
    const npiProfile: OrganizationIdentityAuthorityProfile = {
      providerKey: 'nppes',
      profileVersion: 'v1',
      rules: [{ scheme: 'us_npi', jurisdictions: ['US'], validator: 'npi-v1' }],
    };

    expect(normalizeAuthorityIdentifiers(npiProfile, [
      { scheme: 'us_npi', jurisdiction: 'US', value: '1234567893' },
    ])[0]).toMatchObject({
      normalizedValue: '1234567893',
      validatorVersion: 'npi-v1',
    });
    expect(() => normalizeAuthorityIdentifiers(npiProfile, [
      { scheme: 'us_npi', jurisdiction: 'US', value: '1234567890' },
    ])).toThrowError(/NPI checksum/i);
    expect(() => normalizeAuthorityIdentifiers(npiProfile, [
      { scheme: 'us_npi', jurisdiction: 'US', value: '3234567893' },
    ])).toThrowError(/NPI checksum/i);
    expect(() => normalizeAuthorityIdentifiers(npiProfile, [
      { scheme: 'us_npi', jurisdiction: 'US', value: '1234-5678-93' },
    ])).toThrowError(/NPI checksum/i);
  });

  it('normalizes checksum-valid Brazilian CNPJs and rejects invalid values', () => {
    const cnpjProfile: OrganizationIdentityAuthorityProfile = {
      providerKey: 'brazil_pncp',
      profileVersion: 'v1',
      rules: [{ scheme: 'br-cnpj', jurisdictions: ['BR'], validator: 'cnpj-v1' }],
    };

    expect(normalizeAuthorityIdentifiers(cnpjProfile, [
      { scheme: 'br-cnpj', jurisdiction: 'BR', value: '11.222.333/0001-81' },
    ])[0]).toMatchObject({
      normalizedValue: '11222333000181',
      validatorVersion: 'cnpj-v1',
    });
    expect(() => normalizeAuthorityIdentifiers(cnpjProfile, [
      { scheme: 'br-cnpj', jurisdiction: 'BR', value: '11222333000182' },
    ])).toThrowError(/CNPJ checksum/i);
  });

  it('normalizes numeric QCMobile USDOT values and rejects non-numeric or zero identities', () => {
    const usdotProfile: OrganizationIdentityAuthorityProfile = {
      providerKey: 'fmcsa_qcmobile',
      profileVersion: 'v1',
      rules: [{ scheme: 'usdot', jurisdictions: ['US'], validator: 'usdot-v1' }],
    };
    expect(normalizeAuthorityIdentifiers(usdotProfile, [
      { scheme: 'usdot', jurisdiction: 'US', value: ' 12345678 ' },
    ])[0]).toMatchObject({ normalizedValue: '12345678', validatorVersion: 'usdot-v1' });
    for (const value of ['ABC', '0000000', '01234567', '123-456', '123456789']) {
      expect(() => normalizeAuthorityIdentifiers(usdotProfile, [
        { scheme: 'usdot', jurisdiction: 'US', value },
      ])).toThrowError(/USDOT/u);
    }
  });
});

describe('organization identity v2 resolution planning', () => {
  const identifiers = normalizeAuthorityIdentifiers(PROFILE, [
    { scheme: 'domain', value: 'acme.example' },
    { scheme: 'registration_number', jurisdiction: 'DE', value: 'HRB1234' },
  ]);

  it('matches one canonical root when all strong identifiers agree', () => {
    expect(
      planOrganizationIdentityResolution({
        identifiers,
        legacyCandidateCompanyId: 'company-a',
        bindings: new Map([
          ['domain:GLOBAL:acme.example', 'company-a'],
          ['registration_number:DE:HRB1234', 'company-a'],
        ]),
        roots: new Map([['company-a', 'company-a']]),
      }),
    ).toEqual({
      kind: 'match',
      companyId: 'company-a',
      identifiers,
    });
  });

  it('returns lazy_upgrade when no strong identifier exists yet but the legacy blocker matches', () => {
    expect(
      planOrganizationIdentityResolution({
        identifiers,
        legacyCandidateCompanyId: 'legacy-company',
        bindings: new Map(),
        roots: new Map(),
      }),
    ).toEqual({
      kind: 'lazy_upgrade',
      companyId: 'legacy-company',
      identifiers,
    });
  });

  it('fails closed when strong identifiers resolve to different roots', () => {
    const result = planOrganizationIdentityResolution({
      identifiers,
      legacyCandidateCompanyId: null,
      bindings: new Map([
        ['domain:GLOBAL:acme.example', 'company-a'],
        ['registration_number:DE:HRB1234', 'company-b'],
      ]),
      roots: new Map([
        ['company-a', 'company-a'],
        ['company-b', 'company-b'],
      ]),
    });

    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') throw new Error('expected conflict');
    expect(result.conflictType).toBe('identifier_split');
    expect(result.companyIds).toEqual(['company-a', 'company-b']);
  });

  it('fails closed when the legacy blocking candidate disagrees with an authoritative identifier', () => {
    const result = planOrganizationIdentityResolution({
      identifiers,
      legacyCandidateCompanyId: 'company-by-domain',
      bindings: new Map([['registration_number:DE:HRB1234', 'company-by-registration']]),
      roots: new Map([
        ['company-by-domain', 'company-by-domain'],
        ['company-by-registration', 'company-by-registration'],
      ]),
    });

    expect(result.kind).toBe('conflict');
    if (result.kind !== 'conflict') throw new Error('expected conflict');
    expect(result.conflictType).toBe('blocking_key_disagreement');
  });

  it('produces one stable conflict fingerprint regardless of input ordering', () => {
    const a = identityConflictFingerprint({
      rawRecordId: 'raw-1',
      resolverVersion: 'organization-identity-v2',
      conflictType: 'identifier_split',
      companyIds: ['company-b', 'company-a'],
      identifierKeys: identifiers.map((identifier) => identifier.key),
    });
    const b = identityConflictFingerprint({
      rawRecordId: 'raw-1',
      resolverVersion: 'organization-identity-v2',
      conflictType: 'identifier_split',
      companyIds: ['company-a', 'company-b'],
      identifierKeys: [...identifiers].reverse().map((identifier) => identifier.key),
    });

    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(b);
    expect(
      identityConflictFingerprint({
        rawRecordId: 'raw-reingested',
        resolverVersion: 'organization-identity-v2',
        conflictType: 'identifier_split',
        companyIds: ['company-a', 'company-b'],
        identifierKeys: identifiers.map((identifier) => identifier.key),
      }),
    ).toBe(a);
  });
});
