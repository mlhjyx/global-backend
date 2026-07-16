export type KbErrorDisposition = 'retryable' | 'terminal' | 'superseded';
export type KbErrorStage = 'claim' | 'storage' | 'parse' | 'embedding' | 'persist';

export type KbIngestErrorCode =
  | 'KB_STORAGE_UNAVAILABLE'
  | 'KB_DOCLING_UNAVAILABLE'
  | 'KB_DOCUMENT_INVALID'
  | 'KB_EMBEDDING_UNAVAILABLE'
  | 'KB_EMBEDDING_INVALID_RESPONSE'
  | 'KB_PERSIST_FAILED'
  | 'KB_LEASE_SUPERSEDED';

/**
 * Internal KB state-machine error. Classification is explicit at the dependency boundary;
 * callers must never infer retryability from human-readable messages.
 */
export class KbIngestError extends Error {
  constructor(
    readonly code: KbIngestErrorCode,
    readonly disposition: KbErrorDisposition,
    readonly stage: KbErrorStage,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'KbIngestError';
  }
}

export function asKbIngestError(err: unknown, fallbackStage: KbErrorStage): KbIngestError {
  if (err instanceof KbIngestError) return err;
  if (
    err !== null &&
    typeof err === 'object' &&
    typeof (err as { code?: unknown }).code === 'string' &&
    ['retryable', 'terminal', 'superseded'].includes(
      String((err as { disposition?: unknown }).disposition),
    ) &&
    ['claim', 'storage', 'parse', 'embedding', 'persist'].includes(
      String((err as { stage?: unknown }).stage),
    )
  ) {
    const typed = err as {
      code: KbIngestErrorCode;
      disposition: KbErrorDisposition;
      stage: KbErrorStage;
    };
    return new KbIngestError(
      typed.code,
      typed.disposition,
      typed.stage,
      errorMessage(err),
      err instanceof Error ? { cause: err } : undefined,
    );
  }
  return new KbIngestError(
    fallbackStage === 'persist' ? 'KB_PERSIST_FAILED' : 'KB_STORAGE_UNAVAILABLE',
    'retryable',
    fallbackStage,
    errorMessage(err),
    err instanceof Error ? { cause: err } : undefined,
  );
}

export function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 2000);
}
