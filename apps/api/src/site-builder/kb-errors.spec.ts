import { describe, expect, it, vi } from 'vitest';
import { asKbIngestError, errorMessage, KbIngestError, type KbIngestErrorCode } from './kb-errors';

const VALID = { code: 'KB_DOCUMENT_INVALID', disposition: 'terminal', stage: 'parse' } as const;
const FALLBACK = { code: 'KB_PERSIST_FAILED', disposition: 'retryable', stage: 'persist' } as const;
const CODES: KbIngestErrorCode[] = [
  'KB_STORAGE_UNAVAILABLE', 'KB_DOCLING_UNAVAILABLE', 'KB_DOCUMENT_INVALID',
  'KB_EMBEDDING_CONFIGURATION_INVALID', 'KB_EMBEDDING_UNAVAILABLE',
  'KB_EMBEDDING_INVALID_RESPONSE', 'KB_PERSIST_FAILED', 'KB_LEASE_SUPERSEDED',
];

describe('KB failure normalization', () => {
  it.each(CODES)('preserves the declared code %s without retaining raw diagnostics', (code) => {
    const error = new KbIngestError(code, 'retryable', 'embedding', 'synthetic-secret-canary', {
      cause: new Error('synthetic-cause-canary'),
    });
    const normalized = asKbIngestError(error, 'persist');
    expect(normalized).toBeInstanceOf(KbIngestError);
    expect(normalized).toMatchObject({ code, disposition: 'retryable', stage: 'embedding', message: 'KB ingestion failed' });
    expect(normalized.cause).toBeUndefined();
    expect(normalized).not.toBe(error);
  });

  it.each(['retryable', 'terminal', 'superseded'] as const)('preserves explicit %s disposition', (disposition) => {
    expect(asKbIngestError({ ...VALID, disposition }, 'persist')).toMatchObject({ ...VALID, disposition });
  });

  it.each(['claim', 'storage', 'parse', 'embedding', 'persist'] as const)('preserves explicit %s stage', (stage) => {
    expect(asKbIngestError({ ...VALID, stage }, 'persist')).toMatchObject({ ...VALID, stage });
  });

  it.each(['code', 'disposition', 'stage'] as const)('rejects unknown or coercible %s', (field) => {
    const coerce = vi.fn(() => VALID[field]);
    for (const value of ['synthetic-secret-canary', { toString: coerce }]) {
      const normalized = asKbIngestError({ ...VALID, [field]: value }, 'persist');
      expect(normalized).toMatchObject({ ...FALLBACK, message: 'KB ingestion failed' });
      expect(normalized.cause).toBeUndefined();
    }
    expect(coerce).not.toHaveBeenCalled();
  });

  it.each(['code', 'disposition', 'stage'] as const)('rejects %s getters without executing them', (field) => {
    const read = vi.fn(() => { throw new Error('getter-secret-canary'); });
    const input = { ...VALID };
    Object.defineProperty(input, field, { get: read });
    expect(asKbIngestError(input, 'persist')).toMatchObject(FALLBACK);
    expect(read).not.toHaveBeenCalled();
  });

  it('does not trust the class identity or inherited metadata', () => {
    const mutated = new KbIngestError('KB_DOCUMENT_INVALID', 'terminal', 'parse', 'canary');
    Object.assign(mutated, { code: 'synthetic-secret-canary' });
    expect(asKbIngestError(mutated, 'persist')).toMatchObject(FALLBACK);
    expect(asKbIngestError(Object.create(VALID), 'persist')).toMatchObject(FALLBACK);
  });

  it('fails closed when property inspection itself throws', () => {
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('proxy-canary'); } });
    expect(asKbIngestError(proxy, 'persist')).toMatchObject(FALLBACK);
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(asKbIngestError(revoked.proxy, 'persist')).toMatchObject(FALLBACK);
  });

  it.each([null, undefined, 1, 'synthetic-secret-canary', Object.create(null)])('normalizes unknown failures without copying text', (input) => {
    expect(asKbIngestError(input, 'storage')).toMatchObject({
      code: 'KB_STORAGE_UNAVAILABLE', disposition: 'retryable', stage: 'storage', message: 'KB ingestion failed',
    });
  });

  it('does not inspect message, cause, stack or string conversion', () => {
    const read = vi.fn(() => { throw new Error('diagnostic-secret-canary'); });
    const input = Object.assign(new Error('canary'), VALID);
    for (const field of ['message', 'cause', 'stack', 'toString']) {
      Object.defineProperty(input, field, { get: read });
    }
    expect(errorMessage(input)).toBe('KB ingestion failed');
    expect(asKbIngestError(input, 'persist')).toMatchObject({ ...VALID, message: 'KB ingestion failed' });
    expect(read).not.toHaveBeenCalled();
  });
});
