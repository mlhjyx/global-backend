import { describe, expect, it } from 'vitest';
import {
  AssetCleanupRedriveEvent,
  assertAssetCleanupRedrivable,
  validateAssetCleanupRedriveEvent,
} from './asset-cleanup.redrive';

const EVENT: AssetCleanupRedriveEvent = {
  eventId: '44444444-4444-4444-8444-444444444444',
  workspaceId: '11111111-1111-4111-8111-111111111111',
  eventType: 'AssetObjectCleanupRequested',
  schemaVersion: 1,
  aggregateType: 'Asset',
  aggregateId: '33333333-3333-4333-8333-333333333333',
  payload: {
    assetId: '33333333-3333-4333-8333-333333333333',
    siteId: '22222222-2222-4222-8222-222222222222',
    objectKey:
      'ws/11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222/uploads/33333333-3333-4333-8333-333333333333',
    objectClass: 'staging',
    reason: 'commit_succeeded',
    notBefore: '2026-07-17T08:15:00.000Z',
  },
  publishedAt: new Date(),
  parkedAt: null,
};

describe('asset cleanup redrive safety gate', () => {
  it('accepts only an exact staging Outbox command', () => {
    expect(validateAssetCleanupRedriveEvent(EVENT)).toMatchObject({
      eventId: EVENT.eventId,
      objectClass: 'staging',
    });
  });

  it.each([
    ['canonical', { ...EVENT.payload as object, objectClass: 'canonical', blockedUntil: 'scanner' }],
    ['extra field', { ...EVENT.payload as object, unexpected: true }],
    ['wrong key', { ...EVENT.payload as object, objectKey: 'ws/other/uploads/object' }],
  ])('rejects %s payloads', (_name, payload) => {
    expect(() => validateAssetCleanupRedriveEvent({ ...EVENT, payload })).toThrow();
  });

  it.each(['NOT_FOUND', 'FAILED', 'CANCELLED', 'TERMINATED', 'TIMED_OUT'] as const)(
    'allows %s for explicit operator redrive',
    (status) => expect(() => assertAssetCleanupRedrivable(status)).not.toThrow(),
  );

  it.each(['RUNNING', 'COMPLETED', 'CONTINUED_AS_NEW', 'PAUSED', 'UNKNOWN'] as const)(
    'rejects %s to prevent duplicate or destructive execution',
    (status) => expect(() => assertAssetCleanupRedrivable(status)).toThrow(),
  );
});
