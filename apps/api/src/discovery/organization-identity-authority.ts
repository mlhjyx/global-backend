import {
  OrganizationIdentityV2Error,
  type OrganizationIdentityAuthorityProfile,
} from './organization-identity-v2';

const DOMAIN_RULE = {
  scheme: 'domain',
  jurisdictions: ['GLOBAL'],
  validator: 'domain-v1',
} as const;

/**
 * Code-owned projection of Provider Registry identity authority metadata.
 * A provider may only assert schemes listed here; unknown schemes fail closed.
 */
export const ORGANIZATION_IDENTITY_AUTHORITY: Readonly<Record<string, OrganizationIdentityAuthorityProfile>> = Object.freeze({
  public_web: {
    providerKey: 'public_web',
    profileVersion: 'identity-authority-v1',
    rules: [DOMAIN_RULE],
  },
  wikidata: {
    providerKey: 'wikidata',
    profileVersion: 'identity-authority-v2',
    rules: [
      DOMAIN_RULE,
      {
        scheme: 'wikidata-qid',
        jurisdictions: ['GLOBAL'],
        validator: 'opaque-v1',
      },
      {
        scheme: 'lei',
        jurisdictions: ['GLOBAL'],
        validator: 'lei-v1',
      },
      {
        scheme: 'siren',
        jurisdictions: ['FR'],
        validator: 'siren-v1',
      },
    ],
  },
  openstreetmap: {
    providerKey: 'openstreetmap',
    profileVersion: 'identity-authority-v1',
    rules: [DOMAIN_RULE],
  },
  gleif: {
    providerKey: 'gleif',
    profileVersion: 'identity-authority-v1',
    rules: [DOMAIN_RULE, { scheme: 'lei', jurisdictions: ['GLOBAL'], validator: 'lei-v1' }],
  },
  directory: {
    providerKey: 'directory',
    profileVersion: 'identity-authority-v1',
    rules: [DOMAIN_RULE],
  },
  trade_fair: {
    providerKey: 'trade_fair',
    profileVersion: 'identity-authority-v1',
    rules: [DOMAIN_RULE],
  },
  ted: {
    providerKey: 'ted',
    profileVersion: 'identity-authority-v1',
    rules: [DOMAIN_RULE, { scheme: 'ted-natid', jurisdictions: ['*'], validator: 'opaque-v1' }],
  },
  openfda: {
    providerKey: 'openfda',
    profileVersion: 'identity-authority-v1',
    rules: [
      DOMAIN_RULE,
      {
        scheme: 'fda-reg',
        jurisdictions: ['US'],
        validator: 'opaque-v1',
      },
    ],
  },
  digital_footprint: {
    providerKey: 'digital_footprint',
    profileVersion: 'identity-authority-v1',
    rules: [DOMAIN_RULE],
  },
  structured_harvest: {
    providerKey: 'structured_harvest',
    profileVersion: 'identity-authority-v1',
    rules: [DOMAIN_RULE],
  },
  samgov: {
    providerKey: 'samgov',
    profileVersion: 'identity-authority-v1',
    rules: [DOMAIN_RULE, { scheme: 'uei', jurisdictions: ['US'], validator: 'opaque-v1' }],
  },
  companies_house: {
    providerKey: 'companies_house',
    profileVersion: 'identity-authority-v1',
    rules: [{ scheme: 'uk-company-number', jurisdictions: ['GB'], validator: 'uk-company-number-v1' }],
  },
  inpi_rne: {
    providerKey: 'inpi_rne',
    profileVersion: 'identity-authority-v1',
    rules: [{ scheme: 'siren', jurisdictions: ['FR'], validator: 'siren-v1' }],
  },
  fr_company: {
    providerKey: 'fr_company',
    profileVersion: 'identity-authority-v2',
    rules: [{ scheme: 'siren', jurisdictions: ['FR'], validator: 'siren-v1' }],
  },
  nppes: {
    providerKey: 'nppes',
    profileVersion: 'identity-authority-v2',
    rules: [{ scheme: 'us_npi', jurisdictions: ['US'], validator: 'npi-v1' }],
  },
  ror: {
    providerKey: 'ror',
    profileVersion: 'identity-authority-v1',
    rules: [{ scheme: 'ror-id', jurisdictions: ['GLOBAL'], validator: 'ror-id-v1' }],
  },
  sec_edgar: {
    providerKey: 'sec_edgar',
    profileVersion: 'identity-authority-v2',
    rules: [{ scheme: 'cik', jurisdictions: ['US'], validator: 'cik-v1' }],
  },
  mexico_denue: {
    providerKey: 'mexico_denue',
    profileVersion: 'identity-authority-none-v1',
    rules: [],
  },
  fmcsa_qcmobile: {
    providerKey: 'fmcsa_qcmobile',
    profileVersion: 'identity-authority-v1',
    rules: [{ scheme: 'usdot', jurisdictions: ['US'], validator: 'usdot-v1' }],
  },
  eu_ecolabel: {
    providerKey: 'eu_ecolabel',
    profileVersion: 'identity-authority-none-v1',
    rules: [],
  },
  sbir_sttr_companies: {
    providerKey: 'sbir_sttr_companies',
    profileVersion: 'identity-authority-none-v1',
    rules: [],
  },
  koneps: {
    providerKey: 'koneps',
    profileVersion: 'identity-authority-none-v1',
    rules: [],
  },
  world_bank_procurement: {
    providerKey: 'world_bank_procurement',
    profileVersion: 'identity-authority-v2',
    rules: [DOMAIN_RULE],
  },
  usaspending_awards: {
    providerKey: 'usaspending_awards',
    profileVersion: 'identity-authority-v2',
    rules: [DOMAIN_RULE],
  },
  uk_find_a_tender: {
    providerKey: 'uk_find_a_tender',
    profileVersion: 'identity-authority-v2',
    rules: [DOMAIN_RULE],
  },
  brazil_pncp: {
    providerKey: 'brazil_pncp',
    profileVersion: 'identity-authority-v2',
    rules: [DOMAIN_RULE, { scheme: 'br-cnpj', jurisdictions: ['BR'], validator: 'cnpj-v1' }],
  },
  singapore_gebiz: {
    providerKey: 'singapore_gebiz',
    profileVersion: 'identity-authority-v2',
    rules: [DOMAIN_RULE],
  },
  uk_contracts_finder: {
    providerKey: 'uk_contracts_finder',
    profileVersion: 'identity-authority-v2',
    rules: [DOMAIN_RULE],
  },
  sandbox: {
    providerKey: 'sandbox',
    profileVersion: 'identity-authority-v1',
    rules: [
      DOMAIN_RULE,
      { scheme: 'lei', jurisdictions: ['GLOBAL'], validator: 'lei-v1' },
      { scheme: 'fda-reg', jurisdictions: ['US'], validator: 'opaque-v1' },
      { scheme: 'ted-natid', jurisdictions: ['*'], validator: 'opaque-v1' },
    ],
  },
});

export function authorityProfileForProvider(providerKey: string): OrganizationIdentityAuthorityProfile {
  const profile = ORGANIZATION_IDENTITY_AUTHORITY[providerKey];
  if (!profile) {
    throw new OrganizationIdentityV2Error(
      'IDENTITY_AUTHORITY_PROFILE_INVALID',
      'provider has no registered organization identity authority profile',
    );
  }
  return profile;
}
