import { createHash } from 'node:crypto';
import type { CrawlHtmlResult } from '../../../adapters/web-crawler';
import {
  normalizeEvidenceText,
  sanitizeEvidenceUrl,
} from '../../../site-builder/agents/evidence-ref';
import {
  closedJsonRecord,
  readBoundedArtifactJson,
  type ArtifactPayloadContract,
} from '../artifact-materializer.registry';
import {
  invalidGenericOperationArtifact,
  type ArtifactMaterializer,
  type GenericOperationArtifactManifest,
} from '../artifact.types';

const MAX_FETCH_BYTES = 300_000;
const MAX_RENDER_BYTES = 3_000_000;
const FETCH_CONTRACT: ArtifactPayloadContract = Object.freeze({
  resultSchema: 'crawl4ai-fetch/v1',
  mediaTypes: new Set(['text/markdown']),
  maxBytes: MAX_FETCH_BYTES,
});
const RENDER_CONTRACT: ArtifactPayloadContract = Object.freeze({
  resultSchema: 'crawl4ai-render/v1',
  mediaTypes: new Set(['text/html']),
  maxBytes: MAX_RENDER_BYTES,
});

export interface Crawl4aiFetchOutput {
  readonly url: string;
  readonly text: string;
  readonly contentHash: string;
}

export type Crawl4aiRenderOutput = CrawlHtmlResult & {
  readonly robotsBlocked?: boolean;
};

function invalid(): never {
  return invalidGenericOperationArtifact();
}

function safeUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2_000) return invalid();
  const sanitized = sanitizeEvidenceUrl(value);
  if (!sanitized) return invalid();
  return sanitized;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export const crawl4aiFetchMaterializer: ArtifactMaterializer<Crawl4aiFetchOutput> =
  Object.freeze({
    resultSchema: 'crawl4ai-fetch/v1',
    async materialize(
      input: AsyncIterable<Uint8Array>,
      manifest: GenericOperationArtifactManifest,
    ): Promise<Crawl4aiFetchOutput> {
      const value = closedJsonRecord(
        await readBoundedArtifactJson(input, manifest, FETCH_CONTRACT),
        ['url', 'text', 'contentHash'],
      );
      if (
        typeof value.text !== 'string' ||
        typeof value.contentHash !== 'string'
      ) {
        return invalid();
      }
      const text = normalizeEvidenceText(value.text);
      if (
        Buffer.byteLength(text, 'utf8') > MAX_FETCH_BYTES ||
        value.contentHash !== shortHash(text)
      ) {
        return invalid();
      }
      return Object.freeze({
        url: safeUrl(value.url),
        text,
        contentHash: value.contentHash,
      });
    },
  });

export const crawl4aiRenderMaterializer: ArtifactMaterializer<Crawl4aiRenderOutput> =
  Object.freeze({
    resultSchema: 'crawl4ai-render/v1',
    async materialize(
      input: AsyncIterable<Uint8Array>,
      manifest: GenericOperationArtifactManifest,
    ): Promise<Crawl4aiRenderOutput> {
      const value = closedJsonRecord(
        await readBoundedArtifactJson(input, manifest, RENDER_CONTRACT),
        ['url', 'html'],
        ['robotsBlocked'],
      );
      if (
        typeof value.html !== 'string' ||
        Buffer.byteLength(value.html, 'utf8') > MAX_RENDER_BYTES ||
        (value.robotsBlocked !== undefined &&
          typeof value.robotsBlocked !== 'boolean')
      ) {
        return invalid();
      }
      return Object.freeze({
        url: safeUrl(value.url),
        html: value.html,
        headers: Object.freeze({}),
        ...(value.robotsBlocked === undefined
          ? {}
          : { robotsBlocked: value.robotsBlocked }),
      });
    },
  });

export const crawl4aiMaterializers = Object.freeze([
  crawl4aiFetchMaterializer,
  crawl4aiRenderMaterializer,
] as const);
