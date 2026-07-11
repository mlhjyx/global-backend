import { describe, expect, it } from 'vitest';
import { buildSuppressionEntries } from './deletion-plan';

describe('deletion-plan buildSuppressionEntries', () => {
  it('contact subject: only lowercased, deduped email entries — never freezes the whole company', () => {
    const e = buildSuppressionEntries({
      subjectType: 'contact',
      emails: ['A.Smith@Acme.com', 'a.smith@acme.com', ' '],
      domain: 'acme.com',
      companyName: 'Acme GmbH',
    });
    expect(e).toEqual([{ type: 'email', value: 'a.smith@acme.com', reason: 'legal' }]);
  });

  it('company subject: emails + domain + company_name, all deduped/lowercased', () => {
    const e = buildSuppressionEntries({
      subjectType: 'company',
      emails: ['info@acme.com', 'INFO@acme.com'],
      domain: 'Acme.com',
      companyName: 'Acme GmbH',
    });
    expect(e).toEqual([
      { type: 'email', value: 'info@acme.com', reason: 'legal' },
      { type: 'domain', value: 'acme.com', reason: 'legal' },
      { type: 'company_name', value: 'acme gmbh', reason: 'legal' },
    ]);
  });

  it('skips empty/whitespace values', () => {
    expect(
      buildSuppressionEntries({ subjectType: 'company', emails: [''], domain: null, companyName: '  ' }),
    ).toEqual([]);
  });
});
