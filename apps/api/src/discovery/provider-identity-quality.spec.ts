import { describe, expect, it } from 'vitest';
import { ProviderIdentityQualityTracker } from './provider-identity-quality';

describe('ProviderIdentityQualityTracker', () => {
  it('keeps observable identity quality counts separate by provider', () => {
    const tracker = new ProviderIdentityQualityTracker();

    tracker.recordAccepted('wikidata', {
      name: 'Acme GmbH',
      domain: 'acme.example',
      identifiers: [
        { scheme: 'wikidata-qid', value: 'Q123' },
        { scheme: 'lei', value: '529900T8BM49AURSDO55' },
      ],
    });
    tracker.recordBound('wikidata', 'company-1', false);
    tracker.recordAccepted('wikidata', {
      name: 'Acme GmbH',
      domain: 'acme.example',
      identifiers: [{ scheme: 'wikidata-qid', value: 'Q123' }],
    });
    tracker.recordBound('wikidata', 'company-1', true);
    tracker.recordAccepted('registry', {
      name: 'Other GmbH',
      identifiers: [{ scheme: 'siren', value: '552100554' }],
    });
    tracker.recordConflict('registry');
    tracker.recordSuppressed('registry');

    expect(tracker.snapshot()).toEqual({
      registry: {
        acceptedRows: 1,
        namedRows: 1,
        domainRows: 0,
        authorityIdentifierRows: 1,
        officialRegistrationRows: 1,
        boundRows: 0,
        uniqueCompanies: 0,
        conflictRows: 1,
        suppressedRows: 1,
        replayedRows: 0,
      },
      wikidata: {
        acceptedRows: 2,
        namedRows: 2,
        domainRows: 2,
        authorityIdentifierRows: 2,
        officialRegistrationRows: 1,
        boundRows: 2,
        uniqueCompanies: 1,
        conflictRows: 0,
        suppressedRows: 0,
        replayedRows: 1,
      },
    });
  });

  it('returns a detached deterministic snapshot', () => {
    const tracker = new ProviderIdentityQualityTracker();
    tracker.recordAccepted('z-provider', { name: 'Zed' });
    tracker.recordAccepted('a-provider', { name: 'Alpha' });

    const first = tracker.snapshot();
    first['a-provider'].acceptedRows = 99;

    expect(Object.keys(tracker.snapshot())).toEqual(['a-provider', 'z-provider']);
    expect(tracker.snapshot()['a-provider'].acceptedRows).toBe(1);
  });

  it('counts NPI, CNPJ, ROR and CIK identifiers as official registrations', () => {
    const tracker = new ProviderIdentityQualityTracker();
    tracker.recordAccepted('nppes', {
      name: 'Organization Unit',
      identifiers: [{ scheme: 'us_npi', value: '1234567893' }],
    });
    tracker.recordAccepted('brazil_pncp', {
      name: 'Municipio de Exemplo',
      identifiers: [{ scheme: 'br-cnpj', value: '11222333000181' }],
    });
    tracker.recordAccepted('ror', {
      name: 'University of Oxford',
      identifiers: [{ scheme: 'ror-id', value: 'https://ror.org/052gg0110' }],
    });
    tracker.recordAccepted('sec_edgar', {
      name: 'ACME CORPORATION',
      identifiers: [{ scheme: 'cik', value: '0000000123' }],
    });

    expect(tracker.snapshot().nppes.officialRegistrationRows).toBe(1);
    expect(tracker.snapshot().brazil_pncp.officialRegistrationRows).toBe(1);
    expect(tracker.snapshot().ror.officialRegistrationRows).toBe(1);
    expect(tracker.snapshot().sec_edgar.officialRegistrationRows).toBe(1);
  });
});
