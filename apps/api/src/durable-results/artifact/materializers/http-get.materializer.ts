import {
  parseArtifactExpectedFacts,
  type HttpGetArtifactExpectedFacts,
} from '../artifact-expected-facts';
import type { HttpGetOutput } from '../../../tools/source-tools';
import {
  readBoundedArtifactUtf8,
  type ArtifactPayloadContract,
} from '../artifact-materializer.registry';
import {
  invalidGenericOperationArtifact,
  type ArtifactMaterializer,
  type GenericOperationArtifactManifest,
} from '../artifact.types';

const MAX_HTTP_GET_ARTIFACT_BYTES = 3_000_000;
const CONTRACT: ArtifactPayloadContract = Object.freeze({
  resultSchema: 'http-get/v1',
  mediaTypes: new Set(['text/plain']),
  maxBytes: MAX_HTTP_GET_ARTIFACT_BYTES,
});

function invalid(): never {
  return invalidGenericOperationArtifact();
}

export const httpGetMaterializer: ArtifactMaterializer<HttpGetOutput> =
  Object.freeze({
    resultSchema: 'http-get/v1',
    async materialize(
      input: AsyncIterable<Uint8Array>,
      manifest: GenericOperationArtifactManifest,
      expectedFacts: unknown,
    ): Promise<HttpGetOutput> {
      const facts = parseArtifactExpectedFacts(
        'http-get/v1',
        expectedFacts,
      ) as HttpGetArtifactExpectedFacts;
      const text = await readBoundedArtifactUtf8(input, manifest, CONTRACT);
      if (facts.blocked !== null) {
        if (text !== '') return invalid();
        return Object.freeze({
          status: 0,
          ok: false,
          mediaType: 'text/plain',
          text: '',
          blocked: facts.blocked,
        });
      }
      if (facts.sanitizedUrl === null) return invalid();
      return Object.freeze({
        status: facts.status,
        ok: facts.ok,
        mediaType: 'text/plain',
        text,
        finalUrl: facts.sanitizedUrl,
      });
    },
  });
