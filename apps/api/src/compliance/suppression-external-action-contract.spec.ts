import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('suppression external-action and PII projection topology', () => {
  it('manual and backlog email guessing pass a per-candidate authorization callback', () => {
    const service = read('apps/api/src/discovery/discovery.service.ts');
    const manual = service.slice(service.indexOf('async guessEmailsForCompany'), service.indexOf('async verifyContactPoint'));
    const backlogSource = read('apps/api/src/temporal/backlog.activities.ts');
    const backlog = backlogSource.slice(backlogSource.indexOf('async guessEmailsBacklog'), backlogSource.indexOf('\n  };'));
    expect(manual).toContain('authorizeCandidate:');
    expect(backlog).toContain('authorizeCandidate:');
  });

  it('the acquisition-read company list cannot project named contacts or contact points', () => {
    const service = read('apps/api/src/discovery/discovery.service.ts');
    const list = service.slice(service.indexOf('listCanonicalCompanies'), service.indexOf('async getCanonicalCompany'));
    expect(list).not.toContain('contacts');
    expect(list).not.toContain('contactPoints');
  });
});
