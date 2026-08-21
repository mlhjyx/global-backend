import { types as nodeUtilTypes } from 'node:util';
import { sanitizeEvidenceUrl } from '../../site-builder/agents/evidence-ref';
import { invalidGenericOperationArtifact } from './artifact.types';

/**
 * Small non-body facts required to reconstruct the existing product shapes.
 * A future repository migration must persist/load these with the exact
 * operation manifest; this parser closes their shape but does not invent DB
 * provenance or accept headers, credentials, prompts, tokens, or PII fields.
 */

export type ArtifactExpectedFactsSchema =
  | 'http-get/v1'
  | 'crawl4ai-fetch/v1'
  | 'crawl4ai-render/v1';

export interface HttpGetArtifactExpectedFacts {
  readonly status: number;
  readonly ok: boolean;
  readonly sanitizedUrl: string | null;
  readonly blocked: string | null;
}

export interface Crawl4aiFetchArtifactExpectedFacts {
  readonly sanitizedUrl: string;
  readonly contentHash: string;
}

export interface Crawl4aiRenderArtifactExpectedFacts {
  readonly sanitizedUrl: string;
  readonly blocked: boolean;
}

export type ArtifactExpectedFacts =
  | HttpGetArtifactExpectedFacts
  | Crawl4aiFetchArtifactExpectedFacts
  | Crawl4aiRenderArtifactExpectedFacts;

const BLOCKED_CODE = /^[a-z][a-z0-9_]{0,79}$/;
const CONTENT_HASH = /^[0-9a-f]{24}$/;

function invalid(): never {
  return invalidGenericOperationArtifact();
}

function snapshotClosed(
  value: unknown,
  expectedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      nodeUtilTypes.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return invalid();
    }
    const expected = new Set(expectedKeys);
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== expected.size ||
      keys.some((key) => typeof key !== 'string' || !expected.has(key))
    ) {
      return invalid();
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        !descriptor?.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      ) {
        return invalid();
      }
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: descriptor.value,
        writable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return invalid();
  }
}

function assertSanitizedUrl(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length > 2_000 ||
    sanitizeEvidenceUrl(value) !== value
  ) {
    invalid();
  }
}

function parseHttpGet(value: unknown): HttpGetArtifactExpectedFacts {
  const facts = snapshotClosed(value, [
    'status',
    'ok',
    'sanitizedUrl',
    'blocked',
  ]);
  if (
    typeof facts.status !== 'number' ||
    !Number.isSafeInteger(facts.status) ||
    facts.status < 0 ||
    facts.status > 599 ||
    typeof facts.ok !== 'boolean'
  ) {
    return invalid();
  }
  if (facts.status === 0) {
    if (
      facts.ok ||
      facts.sanitizedUrl !== null ||
      typeof facts.blocked !== 'string' ||
      !BLOCKED_CODE.test(facts.blocked)
    ) {
      return invalid();
    }
  } else {
    if (
      facts.ok !== (facts.status >= 200 && facts.status < 300) ||
      facts.blocked !== null
    ) {
      return invalid();
    }
    assertSanitizedUrl(facts.sanitizedUrl);
  }
  return facts as unknown as HttpGetArtifactExpectedFacts;
}

function parseCrawl4aiFetch(
  value: unknown,
): Crawl4aiFetchArtifactExpectedFacts {
  const facts = snapshotClosed(value, ['sanitizedUrl', 'contentHash']);
  assertSanitizedUrl(facts.sanitizedUrl);
  if (
    typeof facts.contentHash !== 'string' ||
    !CONTENT_HASH.test(facts.contentHash)
  ) {
    return invalid();
  }
  return facts as unknown as Crawl4aiFetchArtifactExpectedFacts;
}

function parseCrawl4aiRender(
  value: unknown,
): Crawl4aiRenderArtifactExpectedFacts {
  const facts = snapshotClosed(value, ['sanitizedUrl', 'blocked']);
  assertSanitizedUrl(facts.sanitizedUrl);
  if (typeof facts.blocked !== 'boolean') return invalid();
  return facts as unknown as Crawl4aiRenderArtifactExpectedFacts;
}

export function parseArtifactExpectedFacts(
  resultSchema: ArtifactExpectedFactsSchema,
  value: unknown,
): ArtifactExpectedFacts {
  if (resultSchema === 'http-get/v1') return parseHttpGet(value);
  if (resultSchema === 'crawl4ai-fetch/v1') return parseCrawl4aiFetch(value);
  if (resultSchema === 'crawl4ai-render/v1') return parseCrawl4aiRender(value);
  return invalid();
}
