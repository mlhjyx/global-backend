export type KbErrorDisposition = (typeof KB_ERROR_DISPOSITIONS)[number];
export type KbErrorStage = (typeof KB_ERROR_STAGES)[number];

const KB_ERROR_CODES = [
  'KB_STORAGE_UNAVAILABLE',
  'KB_DOCLING_UNAVAILABLE',
  'KB_DOCUMENT_INVALID',
  'KB_EMBEDDING_CONFIGURATION_INVALID',
  'KB_EMBEDDING_UNAVAILABLE',
  'KB_EMBEDDING_INVALID_RESPONSE',
  'KB_PERSIST_FAILED',
  'KB_LEASE_SUPERSEDED',
] as const;
export type KbIngestErrorCode = (typeof KB_ERROR_CODES)[number];

const KB_ERROR_DISPOSITIONS = ['retryable', 'terminal', 'superseded'] as const;
const KB_ERROR_STAGES = ['claim', 'storage', 'parse', 'embedding', 'persist'] as const;
const SAFE_KB_ERROR_MESSAGE = 'KB ingestion failed';

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

function isAllowed<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function readClassification(err: unknown): Pick<KbIngestError, 'code' | 'disposition' | 'stage'> | null {
  if (err === null || typeof err !== 'object') return null;
  try {
    // Capture data properties once. Accessors and inherited metadata are not a declaration.
    const code: unknown = Object.getOwnPropertyDescriptor(err, 'code')?.value;
    const disposition: unknown = Object.getOwnPropertyDescriptor(err, 'disposition')?.value;
    const stage: unknown = Object.getOwnPropertyDescriptor(err, 'stage')?.value;
    if (!isAllowed(code, KB_ERROR_CODES) || !isAllowed(disposition, KB_ERROR_DISPOSITIONS) || !isAllowed(stage, KB_ERROR_STAGES)) {
      return null;
    }
    return { code, disposition, stage };
  } catch {
    // A proxy may reject property inspection; unknown failures use the normal fallback.
    return null;
  }
}

export function asKbIngestError(err: unknown, fallbackStage: KbErrorStage): KbIngestError {
  const classification = readClassification(err);
  return new KbIngestError(
    classification?.code ?? (fallbackStage === 'persist' ? 'KB_PERSIST_FAILED' : 'KB_STORAGE_UNAVAILABLE'),
    classification?.disposition ?? 'retryable',
    classification?.stage ?? fallbackStage,
    SAFE_KB_ERROR_MESSAGE,
  );
}

export function errorMessage(_err: unknown): string {
  return SAFE_KB_ERROR_MESSAGE;
}
