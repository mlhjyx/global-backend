import { afterEach, describe, expect, it, vi } from 'vitest';
import { PII_PURPOSE, encryptPiiCandidates } from '../compliance/pii-crypto';
import {
  mergeOrReparentContactPoint,
  upsertGuessedEmailPoint,
  upsertObservedContactPoint,
  upsertProviderEmailPoint,
} from './contact-point-writer';

const WS = '00000000-0000-4000-8000-0000000000aa';
const K1 = '0'.repeat(64);
const K2 = '2'.repeat(64);
const LEGACY_V1 = 'a'.repeat(64);

describe('contact-point-writer · keyring rotation window candidate lookup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('upsertObservedContactPoint reuses existing old-key row via value IN candidates without inserting duplicate', async () => {
    vi.stubEnv('PII_KEYRING_JSON', JSON.stringify({ activeKeyId: 'k2', keys: { k1: K1, k2: K2 } }));
    vi.stubEnv('PII_ENCRYPTION_KEY', LEGACY_V1);

    const expectedCandidates = encryptPiiCandidates('anna@acme.example', {
      workspaceId: WS,
      purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
    });
    expect(expectedCandidates).toHaveLength(3);

    const findFirst = vi.fn(async () => ({ id: 'pt-k1-existing' }));
    const upsert = vi.fn(async () => ({ id: 'pt-dup' }));
    const tx = { contactPoint: { findFirst, upsert } } as never;

    await upsertObservedContactPoint(tx, {
      workspaceId: WS,
      contactId: 'ct-1',
      type: 'email',
      value: 'anna@acme.example',
      sourceType: 'contact_page',
      emailType: 'personal',
    });

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contactId: 'ct-1',
          type: 'email',
          value: { in: expectedCandidates },
        },
        select: { id: true },
      }),
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('upsertObservedContactPoint skips extra findFirst for non-PII types and steady-state single-key keyring', async () => {
    vi.stubEnv('PII_KEYRING_JSON', JSON.stringify({ activeKeyId: 'k2', keys: { k2: K2 } }));
    vi.stubEnv('PII_ENCRYPTION_KEY', '');

    const findFirst = vi.fn(async () => null);
    const upsert = vi.fn(async () => ({ id: 'pt-1' }));
    const tx = { contactPoint: { findFirst, upsert } } as never;

    await upsertObservedContactPoint(tx, {
      workspaceId: WS,
      contactId: 'ct-1',
      type: 'email',
      value: 'anna@acme.example',
      sourceType: 'contact_page',
    });
    await upsertObservedContactPoint(tx, {
      workspaceId: WS,
      contactId: 'ct-1',
      type: 'external_id',
      value: 'uk-ch:12345',
      sourceType: 'directory',
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('upsertGuessedEmailPoint updates matched old-key row in place by id instead of inserting duplicate', async () => {
    vi.stubEnv('PII_KEYRING_JSON', JSON.stringify({ activeKeyId: 'k2', keys: { k1: K1, k2: K2 } }));
    vi.stubEnv('PII_ENCRYPTION_KEY', '');

    const expectedCandidates = encryptPiiCandidates('anna@acme.example', {
      workspaceId: WS,
      purpose: PII_PURPOSE.CONTACT_POINT_VALUE,
    });
    expect(expectedCandidates).toHaveLength(2);

    const findFirst = vi.fn(async () => ({ id: 'pt-k1-existing' }));
    const update = vi.fn(async () => ({ id: 'pt-k1-existing' }));
    const upsert = vi.fn(async () => ({ id: 'pt-dup' }));
    const tx = { contactPoint: { findFirst, update, upsert } } as never;
    const now = new Date('2026-11-26T00:00:00.000Z');

    const res = await upsertGuessedEmailPoint(tx, {
      workspaceId: WS,
      contactId: 'ct-1',
      email: 'anna@acme.example',
      status: 'VALID',
      verifiedAt: now,
      emailType: 'personal',
      sourceType: 'pattern_guess',
      verificationMethod: 'smtp_rcpt',
      catchAll: 'not_catch_all',
      legalBasis: 'legitimate_interest',
      verificationState: 'VALID',
      catchAllClass: 'not_catch_all',
      verificationProvider: 'smtp_self',
      confidence: 95,
      validSince: now,
      nextReverifyAt: new Date('2027-02-24T00:00:00.000Z'),
    });

    expect(res).toEqual({ id: 'pt-k1-existing' });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          contactId: 'ct-1',
          type: 'email',
          value: { in: expectedCandidates },
        },
        select: { id: true },
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'pt-k1-existing' },
        data: expect.objectContaining({
          status: 'VALID',
          verificationState: 'VALID',
          validSince: now,
        }),
        select: { id: true },
      }),
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('upsertProviderEmailPoint returns existing old-key VALID/INVALID state without inserting duplicate UNKNOWN row', async () => {
    vi.stubEnv('PII_KEYRING_JSON', JSON.stringify({ activeKeyId: 'k2', keys: { k1: K1, k2: K2 } }));
    vi.stubEnv('PII_ENCRYPTION_KEY', '');

    const validSince = new Date('2026-10-01T00:00:00.000Z');
    const nextReverifyAt = new Date('2026-12-30T00:00:00.000Z');
    const findFirst = vi.fn(async () => ({
      id: 'pt-k1-valid',
      verificationState: 'VALID',
      validSince,
      nextReverifyAt,
    }));
    const upsert = vi.fn(async () => ({
      id: 'pt-dup-unknown',
      verificationState: 'UNKNOWN',
      validSince: null,
      nextReverifyAt: null,
    }));
    const tx = { contactPoint: { findFirst, upsert } } as never;

    const snapshot = await upsertProviderEmailPoint(tx, {
      workspaceId: WS,
      contactId: 'ct-1',
      email: 'anna@acme.example',
      emailType: 'personal',
      legalBasis: 'legitimate_interest',
    });

    expect(snapshot).toEqual({
      id: 'pt-k1-valid',
      verificationState: 'VALID',
      validSince,
      nextReverifyAt,
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('mergeOrReparentContactPoint deletes weaker row before rekeying or reparenting stronger row', async () => {
    const ops: Array<{ op: 'delete' | 'update'; id: string; data?: Record<string, unknown> }> = [];
    const tx = {
      contactPoint: {
        delete: vi.fn(async ({ where }: { where: { id: string } }) => {
          ops.push({ op: 'delete', id: where.id });
          return {};
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          ops.push({ op: 'update', id: where.id, data });
          return {};
        }),
      },
    } as never;

    await mergeOrReparentContactPoint(tx, {
      kind: 'replace_weaker_and_rekey',
      weakerPointId: 'pt-weak',
      survivorPointId: 'pt-strong',
      value: 'enc:v2:k2:abc:def:ghi',
      domainBlindKey: 'bi:v2:k2:' + 'f'.repeat(64),
    });

    await mergeOrReparentContactPoint(tx, {
      kind: 'replace_weaker_and_reparent',
      weakerPointId: 'pt-to-weak',
      survivorPointId: 'pt-from-strong',
      targetContactId: 'ct-to',
    });

    await mergeOrReparentContactPoint(tx, {
      kind: 'delete_duplicate',
      duplicatePointId: 'pt-dup',
    });

    expect(ops).toEqual([
      { op: 'delete', id: 'pt-weak' },
      {
        op: 'update',
        id: 'pt-strong',
        data: { value: 'enc:v2:k2:abc:def:ghi', domainBlindKey: 'bi:v2:k2:' + 'f'.repeat(64) },
      },
      { op: 'delete', id: 'pt-to-weak' },
      { op: 'update', id: 'pt-from-strong', data: { contactId: 'ct-to' } },
      { op: 'delete', id: 'pt-dup' },
    ]);
  });
});
