export type ProviderExposure = 'REAL' | 'TEST_ONLY';
export type CredentialRequirement = 'NOT_REQUIRED' | 'OPTIONAL' | 'REQUIRED';
export type PolicyMode = 'NONE' | 'ADVISORY' | 'REQUIRED';
export type ProviderRouteLane =
  | 'DISCOVERY'
  | 'ENRICHMENT'
  | 'CONTACT_DISCOVERY'
  | 'EMAIL_VERIFICATION'
  | 'INTENT';

export type ProviderCredentialDescriptor = Readonly<{
  key: string;
  label: string;
  envKey: string;
  secret: boolean;
  writeOnly: boolean;
}>;

export type ProviderControlDescriptor = Readonly<{
  key: string;
  displayName: string;
  region: string;
  category: string;
  registrationStatus: 'IMPLEMENTED' | 'PARTIAL';
  exposure: ProviderExposure;
  credentialRequirement: CredentialRequirement;
  credentialEvaluation: 'PRESENCE' | 'UNKNOWN';
  credentials: readonly ProviderCredentialDescriptor[];
  policy: Readonly<{
    mode: PolicyMode;
    domains: readonly string[];
    purposes: readonly string[];
  }>;
  route: Readonly<{
    status: 'DECLARED' | 'TEST_ONLY';
    lanes: readonly ProviderRouteLane[];
    descriptor: string;
  }>;
}>;

type EntryOptions = Partial<
  Pick<ProviderControlDescriptor, 'region' | 'category' | 'registrationStatus' | 'exposure'>
> & {
  credentialRequirement?: CredentialRequirement;
  credentials?: readonly ProviderCredentialDescriptor[];
  credentialEvaluation?: 'PRESENCE' | 'UNKNOWN';
  policyMode?: PolicyMode;
  policyDomains?: readonly string[];
  policyPurposes?: readonly string[];
  lanes: readonly ProviderRouteLane[];
  routeDescriptor: string;
};

const secret = (key: string, label: string, envKey: string): ProviderCredentialDescriptor =>
  Object.freeze({ key, label, envKey, secret: true, writeOnly: true });

const setting = (key: string, label: string, envKey: string): ProviderCredentialDescriptor =>
  Object.freeze({ key, label, envKey, secret: false, writeOnly: false });

function entry(key: string, displayName: string, options: EntryOptions): ProviderControlDescriptor {
  return Object.freeze({
    key,
    displayName,
    region: options.region ?? 'GLOBAL',
    category: options.category ?? 'public_intelligence',
    registrationStatus: options.registrationStatus ?? 'IMPLEMENTED',
    exposure: options.exposure ?? 'REAL',
    credentialRequirement: options.credentialRequirement ?? 'NOT_REQUIRED',
    credentialEvaluation: options.credentialEvaluation ?? 'PRESENCE',
    credentials: Object.freeze([...(options.credentials ?? [])]),
    policy: Object.freeze({
      mode: options.policyMode ?? 'REQUIRED',
      domains: Object.freeze([...(options.policyDomains ?? [])]),
      purposes: Object.freeze([...(options.policyPurposes ?? ['discovery'])]),
    }),
    route: Object.freeze({
      status: options.exposure === 'TEST_ONLY' ? 'TEST_ONLY' : 'DECLARED',
      lanes: Object.freeze([...options.lanes]),
      descriptor: options.routeDescriptor,
    }),
  });
}

/**
 * Read-only control metadata. It describes code-owned routes and fixed policy
 * domains; it is not runtime health, enablement, or evidence. A governance test
 * locks its keys to the machine Provider Registry.
 */
export const PROVIDER_CONTROL_CATALOG: readonly ProviderControlDescriptor[] = Object.freeze([
  entry('public_web', 'Public Web', {
    credentialRequirement: 'OPTIONAL',
    credentials: [
      secret('serperApiKey', 'Serper API key', 'SERPER_API_KEY'),
      secret('braveSearchApiKey', 'Brave Search API key', 'BRAVE_SEARCH_API_KEY'),
    ],
    policyMode: 'ADVISORY',
    lanes: ['DISCOVERY', 'CONTACT_DISCOVERY', 'EMAIL_VERIFICATION'],
    routeDescriptor: 'public-web-adapter',
  }),
  entry('wikidata', 'Wikidata', { category: 'company_registry', policyDomains: ['query.wikidata.org', 'www.wikidata.org'], lanes: ['DISCOVERY', 'ENRICHMENT'], routeDescriptor: 'wikidata-adapters' }),
  entry('openstreetmap', 'OpenStreetMap', { category: 'industry_data', policyDomains: ['overpass-api.de'], lanes: ['DISCOVERY'], routeDescriptor: 'osm-discovery-adapter' }),
  entry('gleif', 'GLEIF', { category: 'company_registry', policyDomains: ['api.gleif.org'], policyPurposes: ['enrichment'], lanes: ['ENRICHMENT'], routeDescriptor: 'gleif-enrichment-adapter' }),
  entry('directory', 'Governed Directory', { category: 'industry_data', policyMode: 'ADVISORY', lanes: ['DISCOVERY'], routeDescriptor: 'directory-discovery-adapter' }),
  entry('trade_fair', 'Trade Fair Directory', { category: 'industry_data', policyDomains: ['algolia.net'], lanes: ['DISCOVERY'], routeDescriptor: 'trade-fair-discovery-adapter' }),
  entry('ted', 'EU TED', { region: 'EU', policyDomains: ['api.ted.europa.eu'], lanes: ['DISCOVERY', 'INTENT'], routeDescriptor: 'ted-discovery-and-signal-adapters' }),
  entry('openfda', 'openFDA', { region: 'US', credentialRequirement: 'OPTIONAL', credentials: [secret('apiKey', 'API key', 'OPENFDA_API_KEY')], policyDomains: ['api.fda.gov'], lanes: ['DISCOVERY', 'INTENT'], routeDescriptor: 'openfda-discovery-and-signal-adapters' }),
  entry('fr_company', 'French Company Registry', { region: 'FR', category: 'company_registry', policyDomains: ['recherche-entreprises.api.gouv.fr'], lanes: ['DISCOVERY'], routeDescriptor: 'france-official-organization-adapter' }),
  entry('nppes', 'NPPES', { region: 'US', category: 'company_registry', policyDomains: ['npiregistry.cms.hhs.gov'], policyPurposes: ['discovery', 'enrichment'], lanes: ['DISCOVERY'], routeDescriptor: 'nppes-organization-adapter' }),
  entry('ror', 'Research Organization Registry', { category: 'company_registry', policyDomains: ['api.ror.org'], lanes: ['DISCOVERY'], routeDescriptor: 'ror-organization-adapter' }),
  entry('sec_edgar', 'SEC EDGAR', { region: 'US', category: 'company_registry', credentialRequirement: 'REQUIRED', credentials: [setting('userAgent', 'Monitored contact user agent', 'SEC_EDGAR_USER_AGENT')], policyDomains: ['www.sec.gov', 'data.sec.gov'], policyPurposes: ['discovery', 'enrichment'], lanes: ['DISCOVERY', 'ENRICHMENT'], routeDescriptor: 'sec-edgar-directory-and-submissions-adapters' }),
  entry('mexico_denue', 'Mexico DENUE', { region: 'MX', category: 'company_registry', credentialRequirement: 'REQUIRED', credentials: [secret('token', 'DENUE token', 'MEXICO_DENUE_TOKEN')], policyDomains: ['www.inegi.org.mx'], lanes: ['DISCOVERY'], routeDescriptor: 'mexico-denue-organization-adapter' }),
  entry('fmcsa_qcmobile', 'FMCSA QCMobile', { region: 'US', category: 'company_registry', credentialRequirement: 'REQUIRED', credentials: [secret('webKey', 'QCMobile WebKey', 'FMCSA_QCMOBILE_WEB_KEY')], policyDomains: ['mobile.fmcsa.dot.gov'], lanes: ['DISCOVERY'], routeDescriptor: 'fmcsa-qcmobile-organization-adapter' }),
  entry('eu_ecolabel', 'EU Ecolabel', { region: 'EU', category: 'public_intelligence', policyDomains: ['apps.data.env.service.ec.europa.eu'], lanes: ['DISCOVERY'], routeDescriptor: 'eu-ecolabel-organization-adapter' }),
  entry('sbir_sttr_companies', 'SBIR/STTR Companies', { region: 'US', category: 'public_intelligence', policyDomains: ['api.www.sbir.gov'], lanes: ['DISCOVERY'], routeDescriptor: 'sbir-sttr-company-adapter' }),
  entry('koneps', 'KONEPS', { region: 'KR', credentialRequirement: 'REQUIRED', credentials: [secret('serviceKey', 'KONEPS service key', 'KONEPS_SERVICE_KEY')], policyDomains: ['apis.data.go.kr'], lanes: ['DISCOVERY'], routeDescriptor: 'koneps-contract-buyer-adapter' }),
  entry('world_bank_procurement', 'World Bank Procurement', { policyDomains: ['search.worldbank.org'], lanes: ['DISCOVERY'], routeDescriptor: 'world-bank-procurement-adapter' }),
  entry('usaspending_awards', 'USAspending Awards', { region: 'US', policyDomains: ['api.usaspending.gov'], lanes: ['DISCOVERY'], routeDescriptor: 'usaspending-buyer-adapter' }),
  entry('uk_find_a_tender', 'UK Find a Tender', { region: 'GB', policyDomains: ['www.find-tender.service.gov.uk'], lanes: ['DISCOVERY'], routeDescriptor: 'uk-find-a-tender-adapter' }),
  entry('brazil_pncp', 'Brazil PNCP', { region: 'BR', policyDomains: ['pncp.gov.br'], lanes: ['DISCOVERY'], routeDescriptor: 'brazil-pncp-buyer-adapter' }),
  entry('singapore_gebiz', 'Singapore GeBIZ', { region: 'SG', policyDomains: ['data.gov.sg'], lanes: ['DISCOVERY'], routeDescriptor: 'singapore-gebiz-supplier-research-adapter' }),
  entry('uk_contracts_finder', 'UK Contracts Finder', { region: 'GB', policyDomains: ['www.contractsfinder.service.gov.uk'], lanes: ['DISCOVERY'], routeDescriptor: 'uk-contracts-finder-adapter' }),
  entry('digital_footprint', 'Digital Footprint', { policyMode: 'ADVISORY', policyPurposes: ['enrichment'], lanes: ['ENRICHMENT'], routeDescriptor: 'digital-footprint-enrichment-adapter' }),
  entry('structured_harvest', 'Structured Harvest', { policyMode: 'ADVISORY', policyPurposes: ['enrichment'], lanes: ['ENRICHMENT'], routeDescriptor: 'structured-harvest-enrichment-adapter' }),
  entry('smtp_self', 'Self-hosted SMTP Verification', { category: 'email_verification', policyMode: 'ADVISORY', policyPurposes: ['email_verification'], lanes: ['EMAIL_VERIFICATION'], routeDescriptor: 'self-hosted-email-verifier' }),
  entry('decision_maker', 'Decision Maker Discovery', { category: 'contact_discovery', policyMode: 'ADVISORY', policyPurposes: ['enrichment'], lanes: ['CONTACT_DISCOVERY'], routeDescriptor: 'decision-maker-contact-adapter' }),
  entry('companies_house', 'Companies House', { region: 'GB', category: 'contact_discovery', credentialRequirement: 'REQUIRED', credentials: [secret('apiKey', 'Companies House API key', 'COMPANIES_HOUSE_API_KEY')], policyDomains: ['api.company-information.service.gov.uk'], policyPurposes: ['enrichment'], lanes: ['CONTACT_DISCOVERY'], routeDescriptor: 'companies-house-contact-adapter' }),
  entry('inpi_rne', 'INPI RNE', { region: 'FR', category: 'contact_discovery', policyDomains: ['recherche-entreprises.api.gouv.fr'], policyPurposes: ['enrichment'], lanes: ['CONTACT_DISCOVERY'], routeDescriptor: 'inpi-rne-contact-adapter' }),
  entry('google_patents', 'Google Patents BigQuery', { category: 'contact_discovery', registrationStatus: 'PARTIAL', credentialRequirement: 'REQUIRED', credentialEvaluation: 'UNKNOWN', credentials: [secret('serviceAccountPath', 'Service account key path', 'GOOGLE_PATENTS_SA_JSON'), secret('applicationCredentialsPath', 'Application credentials key path', 'GOOGLE_APPLICATION_CREDENTIALS'), setting('projectId', 'GCP project', 'GOOGLE_PATENTS_PROJECT')], policyDomains: ['bigquery.googleapis.com'], policyPurposes: ['enrichment'], lanes: ['CONTACT_DISCOVERY'], routeDescriptor: 'google-patents-inventor-adapter' }),
  entry('samgov', 'SAM.gov', { region: 'US', policyDomains: ['sam.gov'], policyPurposes: ['intent'], lanes: ['INTENT'], routeDescriptor: 'sam-sources-sought-signal-adapter' }),
  entry('web_watch', 'Website Watch', { policyMode: 'ADVISORY', policyPurposes: ['intent'], lanes: ['INTENT'], routeDescriptor: 'website-watch-adapter' }),
  entry('email_guess', 'Email Guessing', { category: 'email_verification', policyMode: 'NONE', lanes: ['EMAIL_VERIFICATION'], routeDescriptor: 'email-guess-pipeline' }),
  entry('sandbox', 'Synthetic Sandbox', { exposure: 'TEST_ONLY', category: 'synthetic', policyMode: 'NONE', lanes: ['DISCOVERY', 'CONTACT_DISCOVERY', 'EMAIL_VERIFICATION'], routeDescriptor: 'sandbox-test-adapter' }),
]);
