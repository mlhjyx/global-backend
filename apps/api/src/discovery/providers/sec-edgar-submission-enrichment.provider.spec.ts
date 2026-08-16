import { describe, expect, it, vi } from 'vitest';

import type { CompanyEnrichmentInput } from '../provider-contract';
import type { ExecutionBroker } from '../../tools/tool-contract';
import {
  SEC_EDGAR_SUBMISSION_OBSERVATION_VERSION,
  SecEdgarSubmissionEnrichmentProvider,
} from './sec-edgar-submission-enrichment.provider';

const CIK = '0000000123';
const DIRECTORY_URL = 'https://www.sec.gov/files/company_tickers_exchange.json';
const SUBMISSION_URL = `https://data.sec.gov/submissions/CIK${CIK}.json`;
const PROVENANCE = {
  sourceUrl: SUBMISSION_URL,
  fetchedAt: '2026-08-14T03:00:00.000Z',
  contentHash: 'a'.repeat(64),
  parserVersion: 'sec-edgar-submissions/2',
};

function input(overrides: Partial<CompanyEnrichmentInput> = {}): CompanyEnrichmentInput {
  return {
    name: 'ACME CORPORATION',
    purpose: 'fit_evidence',
    identifiers: [{ scheme: 'cik', jurisdiction: 'US', value: CIK }],
    sourceBindings: [{
      providerKey: 'sec_edgar',
      rawRecordId: 'raw-directory-1',
      externalId: `sec-edgar:${CIK}`,
      name: 'ACME CORPORATION',
      identifier: { scheme: 'cik', jurisdiction: 'US', value: CIK },
      sourceUrl: DIRECTORY_URL,
      parserVersion: 'sec-edgar-company-tickers-exchange/1',
    }],
    identitySnapshot: 'snapshot-v1',
    ...overrides,
  };
}

function brokerResult(record: Record<string, unknown> = {
  cik: CIK,
  name: 'ACME CORPORATION',
  entityType: 'operating',
}) {
  return {
    data: { organizations: [record] },
    costCents: 0,
    provenance: PROVENANCE,
  };
}

describe('SecEdgarSubmissionEnrichmentProvider', () => {
  it.each([
    ['missing CIK', input({ identifiers: [] })],
    ['multiple CIKs', input({ identifiers: [
      { scheme: 'cik', jurisdiction: 'US', value: CIK },
      { scheme: 'cik', jurisdiction: 'US', value: '0000000456' },
    ] })],
    ['wrong jurisdiction', input({ identifiers: [{ scheme: 'cik', jurisdiction: 'CA', value: CIK }] })],
    ['wrong purpose', input({ purpose: 'deep_enrichment' })],
    ['missing ACTIVE snapshot', input({ identitySnapshot: undefined })],
    ['missing directory binding', input({ sourceBindings: [] })],
    ['multiple directory bindings', input({ sourceBindings: [
      input().sourceBindings![0]!,
      { ...input().sourceBindings![0]!, rawRecordId: 'raw-directory-2' },
    ] })],
    ['untrusted binding URL', input({ sourceBindings: [{
      ...input().sourceBindings![0]!, sourceUrl: 'https://data.sec.gov/submissions/index.json',
    }] })],
    ['binding parser drift', input({ sourceBindings: [{
      ...input().sourceBindings![0]!, parserVersion: 'sec-edgar-company-tickers-exchange/2',
    }] })],
    ['binding name mismatch', input({ sourceBindings: [{
      ...input().sourceBindings![0]!, name: 'DIFFERENT CORPORATION',
    }] })],
    ['binding CIK mismatch', input({ sourceBindings: [{
      ...input().sourceBindings![0]!,
      externalId: 'sec-edgar:0000000456',
      identifier: { scheme: 'cik', jurisdiction: 'US', value: '0000000456' },
    }] })],
  ])('does not call SEC for %s', async (_label, company) => {
    const invoke = vi.fn();
    const provider = new SecEdgarSubmissionEnrichmentProvider({
      broker: { invoke } as unknown as ExecutionBroker,
    });

    await expect(provider.enrichCompany(company, { workspaceId: 'ws-1' })).resolves.toEqual({
      matched: false,
      confidence: 0,
      attributes: {},
      costCents: 0,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fetches an exact ACTIVE-directory-bound CIK and emits only the sanitized observation whitelist', async () => {
    const invoke = vi.fn(async () => brokerResult());
    const provider = new SecEdgarSubmissionEnrichmentProvider({
      broker: { invoke } as unknown as ExecutionBroker,
    });

    const result = await provider.enrichCompany(input(), {
      workspaceId: 'ws-1',
      runId: 'run-1',
      correlationId: 'corr-1',
    });

    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      'sec-edgar.submission.fetch',
      { cik: CIK, expectedName: 'ACME CORPORATION' },
      {
        workspaceId: 'ws-1',
        runId: 'run-1',
        correlationId: 'corr-1',
        purpose: 'enrichment',
      },
    );
    expect(result).toEqual({
      matched: true,
      confidence: 1,
      attributes: {
        submission_schema_version: SEC_EDGAR_SUBMISSION_OBSERVATION_VERSION,
        submission_entity_type: 'operating',
        submission_semantic_scope: 'sec_filer_classification_only',
      },
      provenance: PROVENANCE,
      rawObservation: {
        externalId: `sec-edgar-submission:${CIK}`,
        sourceClass: 'company_registry',
        license: 'US-GOV-PUBLIC-INFO',
        payload: {
          externalId: `sec-edgar-submission:${CIK}`,
          name: 'ACME CORPORATION',
          identifiers: [{ scheme: 'cik', jurisdiction: 'US', value: CIK }],
          attributes: {
            sec_edgar_submission: {
              schema_version: SEC_EDGAR_SUBMISSION_OBSERVATION_VERSION,
              cik: CIK,
              entity_type: 'operating',
              semantic_scope: 'sec_filer_classification_only',
            },
          },
          license: 'US-GOV-PUBLIC-INFO',
          provenance: PROVENANCE,
        },
      },
      costCents: 0,
    });
    expect(JSON.stringify(result)).not.toMatch(/ticker|exchange|sic|state|filing|address|phone|ein|website/iu);
  });

  it('rejects broker output outside the exact submission whitelist', async () => {
    const invoke = vi.fn(async () => brokerResult({
      cik: CIK,
      name: 'ACME CORPORATION',
      entityType: 'operating',
      ticker: 'ACME',
    }));
    const provider = new SecEdgarSubmissionEnrichmentProvider({
      broker: { invoke } as unknown as ExecutionBroker,
    });

    await expect(provider.enrichCompany(input(), { workspaceId: 'ws-1' }))
      .rejects.toThrow('SEC_EDGAR_SUBMISSION_RESULT_INVALID');
  });

  it('does not call SEC for an empty company name', async () => {
    const invoke = vi.fn();
    const provider = new SecEdgarSubmissionEnrichmentProvider({
      broker: { invoke } as unknown as ExecutionBroker,
    });

    await expect(provider.enrichCompany(input({
      name: ' ',
      sourceBindings: [{ ...input().sourceBindings![0]!, name: ' ' }],
    }), { workspaceId: 'ws-1' })).resolves.toMatchObject({ matched: false });
    expect(invoke).not.toHaveBeenCalled();
  });
});
