import { sanitizeEvidenceUrl } from '../../../site-builder/agents/evidence-ref';
import type { HttpGetOutput } from '../../../tools/source-tools';
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

const MAX_HTTP_GET_ARTIFACT_BYTES = 3_000_000;
const CONTRACT: ArtifactPayloadContract = Object.freeze({
  resultSchema: 'http-get/v1',
  mediaTypes: new Set(['text/plain']),
  maxBytes: MAX_HTTP_GET_ARTIFACT_BYTES,
});
const BLOCKED_CODE = /^[a-z][a-z0-9_]{0,79}$/;

function invalid(): never {
  return invalidGenericOperationArtifact();
}

function boundedUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_000) return invalid();
  const sanitized = sanitizeEvidenceUrl(value);
  if (!sanitized) return invalid();
  return sanitized;
}

export const httpGetMaterializer: ArtifactMaterializer<HttpGetOutput> =
  Object.freeze({
    resultSchema: 'http-get/v1',
    async materialize(
      input: AsyncIterable<Uint8Array>,
      manifest: GenericOperationArtifactManifest,
    ): Promise<HttpGetOutput> {
      const value = closedJsonRecord(
        await readBoundedArtifactJson(input, manifest, CONTRACT),
        ['status', 'ok', 'mediaType', 'text'],
        ['finalUrl', 'blocked'],
      );
      if (
        typeof value.status !== 'number' ||
        !Number.isSafeInteger(value.status) ||
        value.status < 0 ||
        value.status > 599 ||
        typeof value.ok !== 'boolean' ||
        value.ok !== (value.status >= 200 && value.status < 300) ||
        value.mediaType !== 'text/plain' ||
        typeof value.text !== 'string' ||
        Buffer.byteLength(value.text, 'utf8') > MAX_HTTP_GET_ARTIFACT_BYTES
      ) {
        return invalid();
      }
      const finalUrl =
        value.finalUrl === undefined ? undefined : boundedUrl(value.finalUrl);
      const blocked = value.blocked;
      if (
        (blocked !== undefined &&
          (typeof blocked !== 'string' || !BLOCKED_CODE.test(blocked))) ||
        (value.status === 0 && blocked === undefined) ||
        (blocked !== undefined &&
          (value.status !== 0 || value.ok || value.text !== '' || finalUrl !== undefined))
      ) {
        return invalid();
      }
      return Object.freeze({
        status: value.status,
        ok: value.ok,
        mediaType: 'text/plain',
        text: value.text,
        ...(finalUrl === undefined ? {} : { finalUrl }),
        ...(blocked === undefined ? {} : { blocked }),
      });
    },
  });
