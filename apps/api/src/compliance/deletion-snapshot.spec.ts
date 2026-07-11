import { describe, expect, it } from 'vitest';
import {
  DELETION_RULE_VERSION,
  buildDeletionCompletedPayload,
  classifyDeletionCompleted,
  countsFromLocated,
} from './deletion-snapshot';
import { ErasureCounts, LocatedErasureTargets } from './deletion.types';

const zero: ErasureCounts = {
  contactsErased: 0,
  contactPointsErased: 0,
  fieldEvidenceErased: 0,
  signalsRevoked: 0,
  companiesSuppressed: 0,
  leadsRescoreRequested: 0,
};

const located: LocatedErasureTargets = {
  subjectType: 'company',
  subjectId: 'c1',
  contactIds: ['a', 'b'],
  contactPointsCount: 5,
  fieldEvidenceCount: 7,
  companyIdsToSuppress: ['c1'],
  signalsToRevoke: 0,
  affectedIcpIds: ['i1', 'i2'],
};

describe('deletion-snapshot', () => {
  it('derives counts from the located snapshot', () => {
    expect(countsFromLocated(located)).toEqual({
      contactsErased: 2,
      contactPointsErased: 5,
      fieldEvidenceErased: 7,
      signalsRevoked: 0,
      companiesSuppressed: 1,
      leadsRescoreRequested: 2,
    });
  });

  it('builds a minimized payload with only counts + refs — no PII keys', () => {
    const p = buildDeletionCompletedPayload({
      deletionRequestId: 'req1',
      subjectType: 'contact',
      subjectId: 'subj1',
      counts: countsFromLocated(located),
      erasedAt: '2026-07-11T00:00:00.000Z',
    });
    expect(p.snapshot_version).toBe(1);
    expect(p.deletion_request_id).toBe('req1');
    expect(p.subject_type).toBe('contact');
    expect(p.subject_ref).toBe('subj1');
    expect(p.contacts_erased).toBe(2);
    expect(p.signals_revoked).toBe(0);
    expect(p.rule_version).toBe(DELETION_RULE_VERSION);
    expect(p.erased_at).toBe('2026-07-11T00:00:00.000Z');
    // 🔴 内容最小化：payload 键里绝不出现 name/email/value/full 之类 PII 字段名
    expect(Object.keys(p).join(',')).not.toMatch(/name|email|value|full/i);
  });

  it('classifies erasure touching a named person as RESTRICTED, else CONFIDENTIAL', () => {
    expect(classifyDeletionCompleted({ ...zero, contactsErased: 1 })).toBe('RESTRICTED');
    expect(classifyDeletionCompleted({ ...zero, companiesSuppressed: 1 })).toBe('CONFIDENTIAL');
    expect(classifyDeletionCompleted(zero)).toBe('CONFIDENTIAL');
  });
});
