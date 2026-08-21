import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { parseEuFsf } from '../../../adapters/eu-fsf-xml';
import { parseOfacXml } from '../../../adapters/ofac-xml';
import {
  MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES,
  type SanctionsDownloadOutput,
} from '../../../tools/source-tools';
import {
  readBoundedArtifactUtf8,
  type ArtifactPayloadContract,
} from '../artifact-materializer.registry';
import { parseGenericOperationArtifactManifest } from '../generic-operation-artifact.repository';
import {
  GenericOperationArtifactError,
  invalidGenericOperationArtifact,
  type ArtifactMaterializer,
  type GenericOperationArtifactManifest,
} from '../artifact.types';

const CONTRACT: ArtifactPayloadContract = Object.freeze({
  resultSchema: 'sanctions-download/v1',
  mediaTypes: new Set(['application/xml', 'text/xml']),
  maxBytes: MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES,
});

const SAFE_XML_PARSER = new XMLParser({
  ignoreAttributes: false,
  ignoreDeclaration: true,
  maxNestedTags: 100,
  parseAttributeValue: false,
  parseTagValue: false,
  processEntities: false,
});

function validateSanctionsXml(xml: string): void {
  try {
    if (/<!DOCTYPE\b/i.test(xml) || /<!ENTITY\b/i.test(xml)) {
      return invalidGenericOperationArtifact();
    }
    if (XMLValidator.validate(xml) !== true) {
      return invalidGenericOperationArtifact();
    }
    const document = SAFE_XML_PARSER.parse(xml) as unknown;
    if (
      typeof document !== 'object' ||
      document === null ||
      Array.isArray(document) ||
      Object.getPrototypeOf(document) !== Object.prototype
    ) {
      return invalidGenericOperationArtifact();
    }
    const roots = Object.keys(document);
    if (roots.length !== 1) return invalidGenericOperationArtifact();
    if (roots[0] === 'sdnList') {
      parseOfacXml(xml);
      return;
    }
    if (roots[0] === 'export') {
      parseEuFsf(xml);
      return;
    }
    return invalidGenericOperationArtifact();
  } catch (error) {
    if (error instanceof GenericOperationArtifactError) throw error;
    return invalidGenericOperationArtifact();
  }
}

export const sanctionsDownloadMaterializer: ArtifactMaterializer<SanctionsDownloadOutput> =
  Object.freeze({
    resultSchema: 'sanctions-download/v1',
    async materialize(
      input: AsyncIterable<Uint8Array>,
      manifest: GenericOperationArtifactManifest,
    ): Promise<SanctionsDownloadOutput> {
      const boundManifest = parseGenericOperationArtifactManifest(manifest);
      const body = await readBoundedArtifactUtf8(input, boundManifest, CONTRACT);
      validateSanctionsXml(body);
      return Object.freeze({
        body,
        contentType: boundManifest.mediaType,
        lastModified: null,
      });
    },
  });
