/**
 * Wire-level helpers for OpenAICompatibleProvider:
 *  - temperature omission for models that reject `temperature` (e.g., claude-*-5-5, claude-fable-5-*)
 *  - Anthropic Messages protocol compatibility (never combine `thinking` with `temperature` or forced `tool_choice: any`)
 *  - Bounded SSE stream reading (prevents unbounded heap growth from `response.text()`)
 *  - Bounded HTTP 429 retry with Retry-After / exponential backoff for unsettled calls only
 */

export const MAX_SSE_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_429_MAX_RETRIES = 2;
const DEFAULT_429_BASE_DELAY_MS = 500;
const DEFAULT_429_MAX_DELAY_MS = 10_000;

const TEMPERATURE_DEPRECATED_MODEL_RE =
  /^claude-(?:haiku-5-5|sonnet-5-5|fable-5-\d+)(?:$|[-@:])/iu;

export function modelDeprecatesTemperature(model: string): boolean {
  return TEMPERATURE_DEPRECATED_MODEL_RE.test(model.trim());
}

export function wireTemperatureField(
  model: string,
  temperature: number | undefined,
  fallback = 0.2,
): { temperature?: number } {
  if (modelDeprecatesTemperature(model)) return {};
  return { temperature: temperature ?? fallback };
}

export function buildAnthropicMessagesControlFields(opts: {
  model: string;
  temperature?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  outputSchema?: Record<string, unknown>;
}): Record<string, unknown> {
  // Anthropic forbids non-default temperature when thinking is enabled or on 5.5/fable models.
  const enableThinking = Boolean(opts.reasoningEffort);
  const omitTemp = enableThinking || modelDeprecatesTemperature(opts.model);
  return {
    ...(omitTemp ? {} : { temperature: opts.temperature ?? 0.2 }),
    ...(enableThinking
      ? {
          thinking: { type: 'adaptive' },
          output_config: { effort: opts.reasoningEffort },
        }
      : {}),
    ...(opts.outputSchema
      ? {
          tools: [
            {
              name: 'json',
              description: 'Respond with a JSON object.',
              input_schema: opts.outputSchema,
            },
          ],
          tool_choice: { type: 'any', disable_parallel_tool_use: true },
        }
      : {}),
  };
}

export class SseResponseTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`SSE response exceeded ${maxBytes} bytes`);
    this.name = 'SseResponseTooLargeError';
  }
}

export function classifyBoundedStreamReadError(err: unknown): {
  reason: string;
  reasonCode: string;
} {
  return err instanceof SseResponseTooLargeError
    ? {
        reason: 'stream response exceeded maximum size',
        reasonCode: 'CHAT_COMPLETIONS_STREAM_TOO_LARGE',
      }
    : {
        reason: 'stream body unavailable',
        reasonCode: 'CHAT_COMPLETIONS_STREAM_UNREADABLE',
      };
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = MAX_SSE_RESPONSE_BYTES,
): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new SseResponseTooLargeError(maxBytes);
    }
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let totalBytes = 0;
  const chunks: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel().catch(() => undefined);
          throw new SseResponseTooLargeError(maxBytes);
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
    }
    chunks.push(decoder.decode());
    return chunks.join('');
  } finally {
    reader.releaseLock();
  }
}

function retryAfterMs(response: Response, attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const header = response.headers?.get?.('retry-after')?.trim();
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(maxDelayMs, Math.round(seconds * 1_000));
    }
    const when = Date.parse(header);
    if (Number.isFinite(when)) {
      return Math.min(maxDelayMs, Math.max(0, when - Date.now()));
    }
  }
  return Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
}

async function sleepWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Unsettled-only HTTP 429 retry wrapper. Never used on `ctx.paidCost` wires
 * where each physical attempt owns a unique settlement nonce.
 */
export async function fetchWith429Backoff(
  url: string,
  init: RequestInit,
  opts: { maxRetries?: number; baseDelayMs?: number; maxDelayMs?: number } = {},
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? DEFAULT_429_MAX_RETRIES;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_429_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_429_MAX_DELAY_MS;
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= maxRetries) return res;
    const delayMs = retryAfterMs(res, attempt, baseDelayMs, maxDelayMs);
    await res.body?.cancel?.().catch(() => undefined);
    await sleepWithSignal(delayMs, init.signal);
    attempt += 1;
  }
}

const UPSTREAM_CHANNEL_EXHAUSTED_RE =
  /grouped routing channel has been exhausted|channel[^.\n]{0,60}exhausted|no available channel/iu;

/**
 * Inspect a non-OK gateway HTTP 403 response safely (bounded to 4KB, never returning raw body)
 * to distinguish transient upstream channel/pool exhaustion (e.g. 4router grouped channel pool empty)
 * from permanent auth/permission denials. Always consumes or cancels the body stream cleanly.
 */
export async function detectUpstreamChannelExhausted(response: Response): Promise<boolean> {
  if (response.status !== 403) {
    await response.body?.cancel?.().catch(() => undefined);
    return false;
  }
  try {
    const snippet = await readBoundedResponseText(response, 4_096);
    return UPSTREAM_CHANNEL_EXHAUSTED_RE.test(snippet);
  } catch {
    await response.body?.cancel?.().catch(() => undefined);
    return false;
  }
}
