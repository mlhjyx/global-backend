import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020';
import { authorityProfileForProvider, ORGANIZATION_IDENTITY_AUTHORITY } from './organization-identity-authority';
import { normalizeAuthorityIdentifiers, OrganizationIdentityV2Error } from './organization-identity-v2';
import { DiscoveryProviderRegistry } from './provider.registry';

const NO_STRONG_IDENTIFIER_PROVIDERS = [
  'mexico_denue',
  'eu_ecolabel',
  'sbir_sttr_companies',
  'koneps',
] as const;

describe('organization identity provider authority', () => {
  it('admits jurisdiction-scoped TED registration identifiers', () => {
    const result = normalizeAuthorityIdentifiers(authorityProfileForProvider('ted'), [
      { scheme: 'ted-natid:DEU', value: ' DE 291-499-156 ' },
    ]);
    expect(result).toEqual([
      expect.objectContaining({
        scheme: 'ted-natid',
        jurisdiction: 'DEU',
        normalizedValue: 'DE291499156',
      }),
    ]);
  });

  it('pins FDA registration authority to the US jurisdiction', () => {
    const result = normalizeAuthorityIdentifiers(authorityProfileForProvider('openfda'), [{ scheme: 'fda-reg', value: '3012345678' }]);
    expect(result[0]).toEqual(
      expect.objectContaining({
        jurisdiction: 'US',
        normalizedValue: '3012345678',
      }),
    );
  });

  it('fails closed when a provider asserts an unregistered scheme', () => {
    expect(() =>
      normalizeAuthorityIdentifiers(authorityProfileForProvider('openfda'), [{ scheme: 'lei', value: '529900T8BM49AURSDO55' }]),
    ).toThrow(OrganizationIdentityV2Error);
  });

  it('fails closed for an unknown or misspelled provider key', () => {
    expect(() => authorityProfileForProvider('wikidtaa')).toThrow(
      expect.objectContaining({ code: 'IDENTITY_AUTHORITY_PROFILE_INVALID' }),
    );
  });

  it('represents providers without strong identifiers explicitly and rejects invented authority', () => {
    for (const providerKey of NO_STRONG_IDENTIFIER_PROVIDERS) {
      const profile = authorityProfileForProvider(providerKey);
      expect(profile).toEqual({
        providerKey,
        profileVersion: 'identity-authority-none-v1',
        rules: [],
      });
      expect(normalizeAuthorityIdentifiers(profile, [])).toEqual([]);
      expect(() => normalizeAuthorityIdentifiers(profile, [
        { scheme: 'domain', value: `${providerKey}.example` },
      ])).toThrow(expect.objectContaining({ code: 'IDENTITY_IDENTIFIER_NOT_AUTHORIZED' }));
    }
  });

  it('has an identity authority profile for every registered discovery adapter', () => {
    const withoutGateway = new DiscoveryProviderRegistry() as unknown as {
      discovery: { key: string }[];
    };
    const withGateway = new DiscoveryProviderRegistry({ gateway: {} as never }) as unknown as {
      discovery: { key: string }[];
    };
    const discoveryKeys = [
      ...new Set([
        ...withoutGateway.discovery.map(({ key }) => key),
        ...withGateway.discovery.map(({ key }) => key),
      ]),
    ].sort();

    expect(
      discoveryKeys.filter((providerKey) => !ORGANIZATION_IDENTITY_AUTHORITY[providerKey]),
    ).toEqual([]);
  });

  it('admits USAspending only as a domain authority and rejects award ids as organization identity', () => {
    const profile = authorityProfileForProvider('usaspending_awards');
    expect(profile).toMatchObject({ providerKey: 'usaspending_awards', rules: [{ scheme: 'domain' }] });
    expect(normalizeAuthorityIdentifiers(profile, [])).toEqual([]);
    expect(() => normalizeAuthorityIdentifiers(profile, [{ scheme: 'award-id', value: 'CONT_AWD_123' }]))
      .toThrow(OrganizationIdentityV2Error);
  });

  it('validates official Companies House and INPI company identifiers', () => {
    expect(normalizeAuthorityIdentifiers(authorityProfileForProvider('companies_house'), [
      { scheme: 'uk-company-number', jurisdiction: 'GB', value: ' 02723534 ' },
    ])[0]).toEqual(expect.objectContaining({ normalizedValue: '02723534', validatorVersion: 'uk-company-number-v1' }));
    expect(normalizeAuthorityIdentifiers(authorityProfileForProvider('inpi_rne'), [
      { scheme: 'siren', jurisdiction: 'FR', value: '562 082 909' },
    ])[0]).toEqual(expect.objectContaining({ normalizedValue: '562082909', validatorVersion: 'siren-v1' }));
  });

  it('binds France organizations and NPPES organization units to dedicated validators', () => {
    expect(normalizeAuthorityIdentifiers(authorityProfileForProvider('fr_company'), [
      { scheme: 'siren', jurisdiction: 'FR', value: '356 000 000' },
    ])[0]).toEqual(expect.objectContaining({
      normalizedValue: '356000000',
      validatorVersion: 'siren-v1',
    }));
    expect(normalizeAuthorityIdentifiers(authorityProfileForProvider('nppes'), [
      { scheme: 'us_npi', jurisdiction: 'US', value: '1234567893' },
    ])[0]).toEqual(expect.objectContaining({
      normalizedValue: '1234567893',
      validatorVersion: 'npi-v1',
    }));
    expect(() => normalizeAuthorityIdentifiers(authorityProfileForProvider('nppes'), [
      { scheme: 'us_npi', jurisdiction: 'US', value: '1234567890' },
    ])).toThrow(OrganizationIdentityV2Error);
  });

  it('admits only checksum-valid Brazilian CNPJs for PNCP authority', () => {
    expect(normalizeAuthorityIdentifiers(authorityProfileForProvider('brazil_pncp'), [
      { scheme: 'br-cnpj', jurisdiction: 'BR', value: '11.222.333/0001-81' },
    ])[0]).toEqual(expect.objectContaining({
      normalizedValue: '11222333000181',
      validatorVersion: 'cnpj-v1',
    }));
    expect(() => normalizeAuthorityIdentifiers(authorityProfileForProvider('brazil_pncp'), [
      { scheme: 'br-cnpj', jurisdiction: 'BR', value: '11222333000182' },
    ])).toThrow(OrganizationIdentityV2Error);
  });

  it('binds FMCSA USDOT only to US authority without inventing a checksum', () => {
    expect(normalizeAuthorityIdentifiers(authorityProfileForProvider('fmcsa_qcmobile'), [
      { scheme: 'usdot', jurisdiction: 'US', value: '1234567' },
    ])[0]).toEqual(expect.objectContaining({
      normalizedValue: '1234567',
      validatorVersion: 'usdot-v1',
    }));
    expect(() => normalizeAuthorityIdentifiers(authorityProfileForProvider('fmcsa_qcmobile'), [
      { scheme: 'usdot', jurisdiction: 'CA', value: '1234567' },
    ])).toThrow(OrganizationIdentityV2Error);
    expect(() => normalizeAuthorityIdentifiers(authorityProfileForProvider('fmcsa_qcmobile'), [
      { scheme: 'usdot', jurisdiction: 'US', value: 'ABC' },
    ])).toThrow(OrganizationIdentityV2Error);
  });

  it('rejects malformed registry identifiers before they can bind a company', () => {
    expect(() => normalizeAuthorityIdentifiers(authorityProfileForProvider('companies_house'), [
      { scheme: 'uk-company-number', jurisdiction: 'GB', value: '123' },
    ])).toThrow(OrganizationIdentityV2Error);
    expect(() => normalizeAuthorityIdentifiers(authorityProfileForProvider('inpi_rne'), [
      { scheme: 'siren', jurisdiction: 'FR', value: '562082908' },
    ])).toThrow(OrganizationIdentityV2Error);
  });

  it('keeps code authority profiles aligned with the machine Provider Registry', () => {
    const registry = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/governance/provider-registry.json'), 'utf8')) as {
      providers: {
        key: string;
        identity_authority?: {
          profile_version: string;
          rules: {
            scheme: string;
            jurisdictions: string[];
            validator: string;
          }[];
        };
      }[];
    };
    const registryAuthorities = registry.providers.filter((item) => item.identity_authority);
    expect(Object.keys(ORGANIZATION_IDENTITY_AUTHORITY).sort()).toEqual(
      registryAuthorities.map((provider) => provider.key).sort(),
    );
    for (const provider of registryAuthorities) {
      const code = ORGANIZATION_IDENTITY_AUTHORITY[provider.key];
      expect(code, provider.key).toBeDefined();
      expect({
        profile_version: code.profileVersion,
        rules: code.rules,
      }).toEqual({
        profile_version: provider.identity_authority!.profile_version,
        rules: provider.identity_authority!.rules,
      });
    }
  });

  it('keeps the machine Provider Registry valid against its published JSON Schema', () => {
    const registry = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/governance/provider-registry.json'), 'utf8'));
    const schema = JSON.parse(readFileSync(resolve(process.cwd(), '../../docs/governance/provider-registry.schema.json'), 'utf8'));
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    expect(validate(registry), JSON.stringify(validate.errors, null, 2)).toBe(true);
  });
});
