import { createHash } from 'node:crypto';
import {
  normalizeEvidenceText,
} from '../../../site-builder/agents/evidence-ref';
import {
  parseArtifactExpectedFacts,
  type Crawl4aiFetchArtifactExpectedFacts,
  type Crawl4aiRenderArtifactExpectedFacts,
} from '../artifact-expected-facts';
import {
  readBoundedArtifactUtf8,
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

/** Response headers are transient transport data and are not reconstructed. */
export interface Crawl4aiRenderOutput {
  readonly url: string;
  readonly html: string;
  readonly robotsBlocked?: true;
}

function invalid(): never {
  return invalidGenericOperationArtifact();
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function isHtmlBody(value: string): boolean {
  return /^\s*<(?:!doctype\s+html\b|[a-z][a-z0-9:-]*\b)/i.test(value);
}

export const crawl4aiFetchMaterializer: ArtifactMaterializer<Crawl4aiFetchOutput> =
  Object.freeze({
    resultSchema: 'crawl4ai-fetch/v1',
    async materialize(
      input: AsyncIterable<Uint8Array>,
      manifest: GenericOperationArtifactManifest,
      expectedFacts: unknown,
    ): Promise<Crawl4aiFetchOutput> {
      const facts = parseArtifactExpectedFacts(
        'crawl4ai-fetch/v1',
        expectedFacts,
      ) as Crawl4aiFetchArtifactExpectedFacts;
      const text = normalizeEvidenceText(
        await readBoundedArtifactUtf8(input, manifest, FETCH_CONTRACT),
      );
      if (facts.contentHash !== shortHash(text)) return invalid();
      return Object.freeze({
        url: facts.sanitizedUrl,
        text,
        contentHash: facts.contentHash,
      });
    },
  });

export const crawl4aiRenderMaterializer: ArtifactMaterializer<Crawl4aiRenderOutput> =
  Object.freeze({
    resultSchema: 'crawl4ai-render/v1',
    async materialize(
      input: AsyncIterable<Uint8Array>,
      manifest: GenericOperationArtifactManifest,
      expectedFacts: unknown,
    ): Promise<Crawl4aiRenderOutput> {
      const facts = parseArtifactExpectedFacts(
        'crawl4ai-render/v1',
        expectedFacts,
      ) as Crawl4aiRenderArtifactExpectedFacts;
      const html = await readBoundedArtifactUtf8(
        input,
        manifest,
        RENDER_CONTRACT,
      );
      if (facts.blocked) {
        if (html !== '') return invalid();
        return Object.freeze({
          url: facts.sanitizedUrl,
          html: '',
          robotsBlocked: true,
        });
      }
      if (!isHtmlBody(html)) return invalid();
      return Object.freeze({
        url: facts.sanitizedUrl,
        html,
      });
    },
  });

export const crawl4aiMaterializers = Object.freeze([
  crawl4aiFetchMaterializer,
  crawl4aiRenderMaterializer,
] as const);
