import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { AuthGuard } from '../auth/auth.guard';
import { REQUIRED_SCOPES_METADATA } from '../auth/require-scopes.decorator';
import { ScopesGuard } from '../auth/scopes.guard';
import { RunTraceController } from './run-trace.controller';
import { decodeRunTraceCursor, encodeRunTraceCursor } from './run-trace.service';

describe('RunTraceController authorization topology', () => {
  it('runs authentication before scope enforcement', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, RunTraceController)).toEqual([
      AuthGuard,
      ScopesGuard,
    ]);
  });

  it('requires tenant acquisition:read on the timeline read', () => {
    expect(
      Reflect.getMetadata(REQUIRED_SCOPES_METADATA, RunTraceController.prototype.list),
    ).toEqual(['acquisition:read']);
  });
});

describe('run trace cursor codec', () => {
  const row = {
    id: '70000000-0000-4000-8000-000000000007',
    createdAt: new Date('2026-11-08T10:00:00.000Z'),
  };

  it('round-trips a (created_at, id) keyset cursor', () => {
    const cursor = encodeRunTraceCursor(row);
    expect(cursor).not.toContain('|');
    expect(decodeRunTraceCursor(cursor)).toEqual(row);
  });

  it('rejects malformed cursors instead of guessing', () => {
    expect(decodeRunTraceCursor('not-base64url!')).toBeNull();
    expect(decodeRunTraceCursor(Buffer.from('missing-separator').toString('base64url'))).toBeNull();
    expect(
      decodeRunTraceCursor(Buffer.from('not-a-date|70000000-0000-4000-8000-000000000007').toString('base64url')),
    ).toBeNull();
    expect(
      decodeRunTraceCursor(Buffer.from('2026-11-08T10:00:00.000Z|not-a-uuid').toString('base64url')),
    ).toBeNull();
  });
});
