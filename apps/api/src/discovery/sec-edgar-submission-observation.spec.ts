import { describe, expect, it } from 'vitest';
import {
  validateSecEdgarDirectoryRawPayload,
  validateSecEdgarSubmissionObservation,
} from './sec-edgar-submission-observation';

const provenance = {
  sourceUrl: 'https://data.sec.gov/submissions/CIK0000000123.json',
  fetchedAt: '2026-08-14T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  parserVersion: 'sec-edgar-submissions/2',
};

describe('SEC EDGAR submissions persisted-observation boundary', () => {
  it('accepts only a directory Raw whose name and CIK match the active canonical binding', () => {
    expect(validateSecEdgarDirectoryRawPayload({
      externalId: 'sec-edgar:0000000123',
      name: 'ACME CORPORATION',
      identifiers: [{ scheme: 'cik', jurisdiction: 'US', value: '0000000123' }],
      attributes: { sec_edgar: { cik: '0000000123', ticker: 'ACME' } },
    }, {
      companyName: 'ACME CORPORATION',
      activeCik: '0000000123',
    })).toEqual({ name: 'ACME CORPORATION', cik: '0000000123' });

    for (const payload of [
      { externalId: 'sec-edgar:0000000123', name: 'OTHER', identifiers: [{ scheme: 'cik', jurisdiction: 'US', value: '0000000123' }] },
      { externalId: 'sec-edgar:0000000999', name: 'ACME CORPORATION', identifiers: [{ scheme: 'cik', jurisdiction: 'US', value: '0000000999' }] },
      { externalId: 'sec-edgar:0000000123', name: 'ACME CORPORATION', identifiers: [{ scheme: 'cik', jurisdiction: 'GB', value: '0000000123' }] },
      { externalId: 'sec-edgar:0000000123', name: 'ACME CORPORATION' },
    ]) {
      expect(() => validateSecEdgarDirectoryRawPayload(payload, {
        companyName: 'ACME CORPORATION',
        activeCik: '0000000123',
      })).toThrow('SEC_EDGAR_DIRECTORY_RAW_BINDING_INVALID');
    }
  });

  it('admits an exact sanitized submissions projection and rejects extra or personal fields', () => {
    const observation = {
      externalId: 'sec-edgar-submission:0000000123',
      sourceClass: 'company_registry' as const,
      license: 'US-GOV-PUBLIC-INFO',
      payload: {
        externalId: 'sec-edgar-submission:0000000123',
        name: 'ACME CORPORATION',
        identifiers: [{ scheme: 'cik', jurisdiction: 'US', value: '0000000123' }],
        attributes: {
          sec_edgar_submission: {
            schema_version: 'sec-edgar-submission-observation/v1',
            cik: '0000000123',
            entity_type: 'operating',
            semantic_scope: 'sec_filer_classification_only',
          },
        },
        license: 'US-GOV-PUBLIC-INFO',
        provenance,
      },
    };

    expect(validateSecEdgarSubmissionObservation(observation, {
      companyName: 'ACME CORPORATION',
      activeCik: '0000000123',
      provenance,
    })).toEqual(observation.payload);

    for (const [key, value] of [
      ['filings', { recent: { form: ['10-K'] } }],
      ['formerNames', [{ name: 'PERSON' }]],
      ['addresses', { business: { street1: 'SECRET' } }],
      ['ein', '12-3456789'],
      ['phone', '555-0100'],
      ['website', 'https://untrusted.example'],
    ] as const) {
      expect(() => validateSecEdgarSubmissionObservation({
        ...observation,
        payload: { ...observation.payload, [key]: value },
      }, {
        companyName: 'ACME CORPORATION',
        activeCik: '0000000123',
        provenance,
      })).toThrow('SEC_EDGAR_SUBMISSION_OBSERVATION_INVALID');
    }

    for (const identifiers of [
      [],
      [
        { scheme: 'cik', jurisdiction: 'US', value: '0000000123' },
        { scheme: 'cik', jurisdiction: 'US', value: '0000000123' },
      ],
      [{ scheme: 'cik', jurisdiction: 'US', value: '0000000123', extra: 'forbidden' }],
    ]) {
      expect(() => validateSecEdgarSubmissionObservation({
        ...observation,
        payload: { ...observation.payload, identifiers },
      }, {
        companyName: 'ACME CORPORATION',
        activeCik: '0000000123',
        provenance,
      })).toThrow('SEC_EDGAR_SUBMISSION_OBSERVATION_INVALID');
    }
  });
});
