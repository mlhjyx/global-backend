import { describe, expect, it } from 'vitest';
import { MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES } from '../../../tools/source-tools';
import { sanctionsDownloadMaterializer } from './sanctions-download.materializer';
import {
  encoded,
  manifestFor,
  streamed,
} from './materializer-fixtures.spec-helper';

const OFAC_XML = `<?xml version="1.0" encoding="UTF-8"?>
<sdnList>
  <publshInformation><Publish_Date>08/21/2026</Publish_Date><Record_Count>1</Record_Count></publshInformation>
  <sdnEntry><uid>1</uid><lastName>ACME ENTITY</lastName><sdnType>Entity</sdnType></sdnEntry>
</sdnList>`;

const EU_XML = `<?xml version="1.0" encoding="UTF-8"?>
<export generationDate="2026-08-21T00:00:00.000Z">
  <sanctionEntity logicalId="1"><subjectType code="enterprise"/><nameAlias wholeName="ACME EU" strong="true"/></sanctionEntity>
</export>`;

describe('sanctionsDownloadMaterializer', () => {
  it.each([
    ['application/xml', OFAC_XML],
    ['text/xml', EU_XML],
  ])('materializes bounded, business-parser-compatible %s XML from split UTF-8 chunks', async (mediaType, xml) => {
    const bytes = encoded(xml);
    await expect(
      sanctionsDownloadMaterializer.materialize(
        streamed(bytes, [1, 1, 2, 7]),
        manifestFor('sanctions-download/v1', mediaType, bytes),
      ),
    ).resolves.toEqual({
      body: xml,
      contentType: mediaType,
      lastModified: null,
    });
  });

  it('rejects invalid UTF-8 and media mismatch with only the bounded artifact error', async () => {
    const invalidUtf8 = Uint8Array.of(0x3c, 0x61, 0x3e, 0xc3, 0x28, 0x3c, 0x2f, 0x61, 0x3e);
    await expect(
      sanctionsDownloadMaterializer.materialize(
        streamed(invalidUtf8),
        manifestFor('sanctions-download/v1', 'application/xml', invalidUtf8),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    const xml = encoded(OFAC_XML);
    await expect(
      sanctionsDownloadMaterializer.materialize(
        streamed(xml),
        manifestFor('sanctions-download/v1', 'application/json', xml),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it.each([
    ['internal entity', '<!DOCTYPE sdnList [<!ENTITY x "expanded">]><sdnList><sdnEntry><lastName>&x;</lastName></sdnEntry></sdnList>'],
    ['nested expansion', '<!DOCTYPE sdnList [<!ENTITY a "A"><!ENTITY b "&a;&a;&a;&a;">]><sdnList>&b;</sdnList>'],
    ['external entity', '<!DOCTYPE sdnList [<!ENTITY x SYSTEM "file:///etc/passwd">]><sdnList>&x;</sdnList>'],
  ])('rejects XML %s without resolving or expanding it', async (_name, xml) => {
    const bytes = encoded(xml);
    await expect(
      sanctionsDownloadMaterializer.materialize(
        streamed(bytes),
        manifestFor('sanctions-download/v1', 'application/xml', bytes),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('rejects malformed/trailing XML and declared input above the sanctions business cap', async () => {
    const trailing = encoded(`${OFAC_XML}<export/>`);
    await expect(
      sanctionsDownloadMaterializer.materialize(
        streamed(trailing),
        manifestFor('sanctions-download/v1', 'application/xml', trailing),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    const empty = new Uint8Array();
    const manifest = {
      ...manifestFor('sanctions-download/v1', 'application/xml', empty),
      sizeBytes: String(MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES + 1),
    };
    await expect(
      sanctionsDownloadMaterializer.materialize(streamed(empty), manifest),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it.each([
    ['malformed XML', '<sdnList>'],
    ['multiple roots', '<sdnList/><export/>'],
    ['unknown root', '<html/>'],
    ['business-parser nesting overflow', `<sdnList>${'<x>'.repeat(101)}${'</x>'.repeat(101)}</sdnList>`],
  ])('rejects %s', async (_name, xml) => {
    const bytes = encoded(xml);
    await expect(
      sanctionsDownloadMaterializer.materialize(
        streamed(bytes),
        manifestFor('sanctions-download/v1', 'application/xml', bytes),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('snapshots manifest media facts before consuming an adversarial stream', async () => {
    const bytes = encoded(OFAC_XML);
    const manifest = {
      ...manifestFor('sanctions-download/v1', 'application/xml', bytes),
    };
    async function* mutatingStream(): AsyncIterable<Uint8Array> {
      manifest.mediaType = 'application/json';
      yield bytes;
    }
    await expect(
      sanctionsDownloadMaterializer.materialize(mutatingStream(), manifest),
    ).resolves.toMatchObject({ contentType: 'application/xml' });
  });
});
