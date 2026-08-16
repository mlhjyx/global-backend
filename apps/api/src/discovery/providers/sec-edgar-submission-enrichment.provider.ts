import type {
  CompanyEnrichmentAdapter,
  CompanyEnrichmentInput,
  EnrichmentResult,
  ExecutionContext,
} from '../provider-contract';
import { normalizeCikIdentifier } from '../organization-identity-v2';
import type {
  SecEdgarSubmissionFetchInput,
  SecEdgarSubmissionFetchOutput,
} from '../../tools/source-tools';
import type { ExecutionBroker, ToolResult } from '../../tools/tool-contract';

const DIRECTORY_SOURCE_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const DIRECTORY_PARSER_VERSION = 'sec-edgar-company-tickers-exchange/1';
const SUBMISSION_PARSER_VERSION = 'sec-edgar-submissions/2';
const LICENSE = 'US-GOV-PUBLIC-INFO';

export const SEC_EDGAR_SUBMISSION_OBSERVATION_VERSION =
  'sec-edgar-submission-observation/v1';

export class SecEdgarSubmissionEnrichmentProvider implements CompanyEnrichmentAdapter {
  readonly key = 'sec_edgar';

  constructor(private readonly deps?: { broker?: ExecutionBroker }) {}

  async enrichCompany(
    input: CompanyEnrichmentInput,
    ctx: ExecutionContext,
  ): Promise<EnrichmentResult> {
    const broker = this.deps?.broker;
    const anchor = trustedDirectoryAnchor(input);
    if (!broker || !anchor || input.purpose !== 'fit_evidence') return miss();

    const output = await broker.invoke<SecEdgarSubmissionFetchInput, SecEdgarSubmissionFetchOutput>(
      'sec-edgar.submission.fetch',
      { cik: anchor.cik, expectedName: input.name },
      { ...ctx, purpose: 'enrichment' },
    );
    const organization = requiredSubmissionOrganization(output, anchor.cik, input.name);
    const provenance = requiredSubmissionProvenance(output, anchor.cik);
    const externalId = `sec-edgar-submission:${anchor.cik}`;
    const identifiers = [{ scheme: 'cik', jurisdiction: 'US', value: anchor.cik }];
    const submissionObservation = {
      sec_edgar_submission: {
        schema_version: SEC_EDGAR_SUBMISSION_OBSERVATION_VERSION,
        cik: anchor.cik,
        entity_type: organization.entityType,
        semantic_scope: 'sec_filer_classification_only',
      },
    };

    return {
      matched: true,
      confidence: 1,
      attributes: {
        submission_schema_version: SEC_EDGAR_SUBMISSION_OBSERVATION_VERSION,
        submission_entity_type: organization.entityType,
        submission_semantic_scope: 'sec_filer_classification_only',
      },
      provenance,
      rawObservation: {
        externalId,
        sourceClass: 'company_registry',
        license: LICENSE,
        payload: {
          externalId,
          name: organization.name,
          identifiers,
          attributes: submissionObservation,
          license: LICENSE,
          provenance,
        },
      },
      costCents: output.costCents,
    };
  }
}

function trustedDirectoryAnchor(
  input: CompanyEnrichmentInput,
): { cik: string } | null {
  const inputName = normalizeName(input.name);
  if (!input.identitySnapshot?.trim() || !inputName || input.name.length > 300) return null;

  const cikClaims = (input.identifiers ?? []).filter(
    (identifier) => identifier.scheme.trim().toLocaleLowerCase('en-US') === 'cik',
  );
  if (cikClaims.length !== 1) return null;
  const claim = cikClaims[0]!;
  if (claim.jurisdiction?.trim().toLocaleUpperCase('en-US') !== 'US') return null;
  const cik = normalizeCikIdentifier(claim.value);
  if (!cik) return null;

  const bindings = (input.sourceBindings ?? []).filter(
    (binding) => binding.providerKey === 'sec_edgar',
  );
  if (bindings.length !== 1) return null;
  const binding = bindings[0]!;
  const bindingCik = normalizeCikIdentifier(binding.identifier.value);
  if (
    !binding.rawRecordId.trim() ||
    binding.externalId !== `sec-edgar:${cik}` ||
    binding.identifier.scheme.trim().toLocaleLowerCase('en-US') !== 'cik' ||
    binding.identifier.jurisdiction?.trim().toLocaleUpperCase('en-US') !== 'US' ||
    bindingCik !== cik ||
    normalizeName(binding.name) !== inputName ||
    binding.sourceUrl !== DIRECTORY_SOURCE_URL ||
    binding.parserVersion !== DIRECTORY_PARSER_VERSION
  ) return null;

  return { cik };
}

function requiredSubmissionOrganization(
  output: ToolResult<SecEdgarSubmissionFetchOutput>,
  requestedCik: string,
  expectedName: string,
): SecEdgarSubmissionFetchOutput['organizations'][number] {
  const organizations = output.data.organizations;
  if (!Array.isArray(organizations) || organizations.length !== 1) {
    throw new Error('SEC_EDGAR_SUBMISSION_RESULT_INVALID');
  }
  const organization = organizations[0]!;
  const exactKeys = Object.keys(organization).sort().join(',') === 'cik,entityType,name';
  if (
    !exactKeys ||
    normalizeCikIdentifier(organization.cik) !== requestedCik ||
    typeof organization.name !== 'string' ||
    !organization.name.trim() ||
    organization.name.length > 300 ||
    normalizeName(organization.name) !== normalizeName(expectedName) ||
    organization.entityType !== 'operating'
  ) {
    throw new Error('SEC_EDGAR_SUBMISSION_RESULT_INVALID');
  }
  return organization;
}

function requiredSubmissionProvenance(
  output: ToolResult<SecEdgarSubmissionFetchOutput>,
  cik: string,
): NonNullable<EnrichmentResult['provenance']> {
  const provenance = output.provenance;
  if (
    provenance?.sourceUrl !== `https://data.sec.gov/submissions/CIK${cik}.json` ||
    provenance.parserVersion !== SUBMISSION_PARSER_VERSION ||
    !provenance.contentHash ||
    !/^[a-f0-9]{64}$/u.test(provenance.contentHash) ||
    Number.isNaN(new Date(provenance.fetchedAt).getTime())
  ) {
    throw new Error('SEC_EDGAR_SUBMISSION_PROVENANCE_REQUIRED');
  }
  return {
    sourceUrl: provenance.sourceUrl,
    fetchedAt: provenance.fetchedAt,
    contentHash: provenance.contentHash,
    parserVersion: provenance.parserVersion,
  };
}

function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replaceAll(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

function miss(): EnrichmentResult {
  return { matched: false, confidence: 0, attributes: {}, costCents: 0 };
}
