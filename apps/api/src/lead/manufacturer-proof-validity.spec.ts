import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { EVIDENCE, COMPANY_INPUT, NOW, WS } from '../discovery/manufacturer-network.test-fixture';
import { loadManufacturerProofExpiries } from './manufacturer-proof-validity';

const subject = { ...COMPANY_INPUT, attributes: { manufacturer_network: { evidence: EVIDENCE } } };
const fields = [{ entityId: subject.id, field: 'manufacturer_network.evidence' }];
function row(value = EVIDENCE) {
  return { companyId: subject.id, workspaceId: WS, providerKey: 'manufacturer_network',
    license: value.licenseLabel, allowedActions: value.allowedActions, sourceUrl: value.sourceUrl,
    fetchedAt: new Date(value.fetchedAt), value, proofMatched: true };
}
function fixture(rows = [row()]) {
  const query = vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows);
  const tx = { $queryRaw: query } as never;
  return { query, tx, read: (companies = [subject], currentFields = fields, now = NOW) =>
    loadManufacturerProofExpiries(tx, WS, companies, currentFields, now) };
}

describe('current manufacturer proof validity', () => {
  it('authenticates the latest FE through the SELECT-only proof table, with bounded parameterized reads', async () => {
    const h = fixture();
    expect((await h.read()).get(subject.id)).toBe(EVIDENCE.expiresAt);
    expect(h.query).toHaveBeenCalledTimes(1);
    const [strings, ...values] = h.query.mock.calls[0]!;
    const sql = Prisma.sql(strings, ...values);
    expect(sql.sql).toContain('JOIN LATERAL');
    expect(sql.sql).toContain('ORDER BY f.fetched_at DESC, f.id DESC LIMIT 1');
    expect(sql.sql).toContain('p.evidence = current_field.value');
    expect(sql.values).toEqual([WS, 'manufacturer_network.evidence', WS, subject.id]);
    expect(sql.sql).not.toMatch(/expires_at\s*>|clock_timestamp|\b(?:INSERT|UPDATE|DELETE)\b/iu);
  });
  it('keeps an expired authenticated proof deadline instead of dropping it', async () => {
    expect((await fixture().read([subject], fields, new Date('2026-12-01T00:00:00Z'))).get(subject.id))
      .toBe(EVIDENCE.expiresAt);
  });
  it('does not read or change the legacy path when no current manufacturer field exists', async () => {
    const h = fixture();
    expect((await h.read([{ ...subject, attributes: {} }], [])).size).toBe(0);
    expect(h.query).not.toHaveBeenCalled();
    expect((await h.read([], fields)).size).toBe(0);
  });
  it('reads the current FE even if its canonical namespace is missing, and never trusts a bare namespace', async () => {
    expect((await fixture().read([{ ...subject, attributes: {} }])).get(subject.id)).toBe(EVIDENCE.expiresAt);
    expect((await fixture([]).read()).get(subject.id)).toBeNull();
    expect((await fixture().read([{ ...subject, attributes: { manufacturer_network: { expiresAt: '2099-01-01' } } }]))
      .get(subject.id)).toBe(EVIDENCE.expiresAt);
  });
  it.each([
    { proofMatched: false }, { proofMatched: 'true' }, { workspaceId: subject.id },
    { providerKey: 'public_web' }, { license: 'other' }, { allowedActions: ['display'] },
    { sourceUrl: 'https://other.example/detail' }, { fetchedAt: new Date('2026-11-19T00:00:00Z') },
    { fetchedAt: new Date('invalid') }, { value: null }, { value: { ...EVIDENCE, expiresAt: 'invalid' } },
    { value: { ...EVIDENCE, expiresAt: EVIDENCE.fetchedAt } },
    { value: { ...EVIDENCE, companyId: WS } }, { value: { ...EVIDENCE, workspaceId: subject.id } },
    { value: { ...EVIDENCE, targetDomain: 'other.example' } }, { value: { ...EVIDENCE, targetName: 'Other Pumps' } },
    { value: { ...EVIDENCE, country: 'FR' } },
  ])('refuses unverified, malformed or mismatched current fields without falling back to old proofs: %j', async mutation => {
    const h = fixture([{ ...row(), ...mutation } as ReturnType<typeof row>]);
    expect((await h.read()).get(subject.id)).toBeNull();
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it('refuses a future capture even when its schema/expiry order is valid', async () => {
    const e = { ...EVIDENCE, fetchedAt: '2026-11-22T00:00:00.000Z', expiresAt: '2026-11-23T00:00:00.000Z' };
    expect((await fixture([row(e)]).read()).get(subject.id)).toBeNull();
  });
  it.each([{ country: 'FR' }, { domain: null }, { name: 'Different Pumps' }])('matches the normal current company identity: %j', async identity => {
    expect((await fixture().read([{ ...subject, ...identity } as typeof subject])).get(subject.id)).toBeNull();
  });
  it('never assigns a foreign row to the requested company', async () => {
    const h = fixture([{ ...row(), companyId: WS }]);
    expect((await h.read()).get(subject.id)).toBeNull();
  });
  it('propagates a failed read rather than manufacturing a generic future deadline', async () => {
    const h = fixture(); h.query.mockRejectedValueOnce(new Error('read unavailable'));
    await expect(h.read()).rejects.toThrow('read unavailable');
  });
});
