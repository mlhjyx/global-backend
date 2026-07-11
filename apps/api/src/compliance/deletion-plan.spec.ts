import { describe, expect, it } from 'vitest';
import { buildSuppressionEntries } from './deletion-plan';
import { blindContactKey } from './pii-crypto';
import { contactIdentity } from '../discovery/identity';

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

  it('contact subject with person context: adds a blinded, email-independent contact_key (Codex P1)', () => {
    const e = buildSuppressionEntries({
      subjectType: 'contact',
      emails: ['klaus@acme.com'],
      contactName: 'Klaus Löschmann',
      companyKey: 'd:acme.com',
    });
    expect(e).toContainEqual({ type: 'email', value: 'klaus@acme.com', reason: 'legal' });
    const personKey = blindContactKey(contactIdentity({ fullName: 'Klaus Löschmann' }, 'd:acme.com')).toLowerCase();
    expect(e).toContainEqual({ type: 'contact_key', value: personKey, reason: 'legal' });
    // 🔴 person key 是盲化 HMAC（bi:v1:）——禁联表不存人名明文
    expect(personKey.startsWith('bi:v1:')).toBe(true);
    expect(JSON.stringify(e).toLowerCase()).not.toContain('löschmann');
  });

  it('contact subject without company context: no person key (backward compatible)', () => {
    expect(buildSuppressionEntries({ subjectType: 'contact', emails: ['a@b.com'] })).toEqual([
      { type: 'email', value: 'a@b.com', reason: 'legal' },
    ]);
  });

  it('company subject: never emits a contact_key even if person context is passed', () => {
    const e = buildSuppressionEntries({
      subjectType: 'company',
      emails: [],
      domain: 'acme.com',
      companyName: 'Acme',
      contactName: 'Someone',
      companyKey: 'd:acme.com',
    });
    expect(e.some((x) => x.type === 'contact_key')).toBe(false);
  });
});
