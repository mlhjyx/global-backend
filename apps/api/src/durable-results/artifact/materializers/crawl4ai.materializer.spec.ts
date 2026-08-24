import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  crawl4aiFetchMaterializer,
  crawl4aiRenderMaterializer,
} from './crawl4ai.materializer';
import {
  encoded,
  manifestFor,
  streamed,
} from './materializer-fixtures.spec-helper';

const shortHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 24);

describe('crawl4ai materializers', () => {
  it('materializes the raw markdown body with closed trusted URL/hash facts', async () => {
    const text = '# ACME\n\nbounded evidence';
    const bytes = encoded(text);
    await expect(
      crawl4aiFetchMaterializer.materialize(
        streamed(bytes),
        manifestFor('crawl4ai-fetch/v1', 'text/markdown', bytes),
        {
          sanitizedUrl: 'https://example.com/',
          contentHash: shortHash(text),
        },
      ),
    ).resolves.toEqual({
      url: 'https://example.com/',
      text,
      contentHash: shortHash(text),
    });
  });

  it('rejects missing or mismatched fetch facts and does not decode the old JSON envelope', async () => {
    const oldEnvelope = JSON.stringify({
      url: 'https://example.com/',
      text: 'old envelope',
      contentHash: shortHash('old envelope'),
    });
    const bytes = encoded(oldEnvelope);
    const manifest = manifestFor('crawl4ai-fetch/v1', 'text/markdown', bytes);
    await expect(
      crawl4aiFetchMaterializer.materialize(streamed(bytes), manifest, undefined),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
    await expect(
      crawl4aiFetchMaterializer.materialize(streamed(bytes), manifest, {
        sanitizedUrl: 'https://example.com/',
        contentHash: shortHash('old envelope'),
      }),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('materializes raw HTML without reconstructing transient headers', async () => {
    const html = '<!doctype html><html><body>ok</body></html>';
    const bytes = encoded(html);
    const output = await crawl4aiRenderMaterializer.materialize(
      streamed(bytes),
      manifestFor('crawl4ai-render/v1', 'text/html', bytes),
      {
        sanitizedUrl: 'https://example.com/',
        blocked: false,
      },
    );
    expect(output).toEqual({
      url: 'https://example.com/',
      html,
    });
    expect(output).not.toHaveProperty('headers');
  });

  it('restores only the existing explicit robots-blocked status', async () => {
    const bytes = new Uint8Array();
    await expect(
      crawl4aiRenderMaterializer.materialize(
        streamed(bytes),
        manifestFor('crawl4ai-render/v1', 'text/html', bytes),
        {
          sanitizedUrl: 'https://example.com/',
          blocked: true,
        },
      ),
    ).resolves.toEqual({
      url: 'https://example.com/',
      html: '',
      robotsBlocked: true,
    });

    const nonEmpty = encoded('<html/>');
    await expect(
      crawl4aiRenderMaterializer.materialize(
        streamed(nonEmpty),
        manifestFor('crawl4ai-render/v1', 'text/html', nonEmpty),
        {
          sanitizedUrl: 'https://example.com/',
          blocked: true,
        },
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('rejects old render JSON envelopes, wrong media, HTML above max, and bad facts', async () => {
    const oldEnvelope = encoded(JSON.stringify({
      url: 'https://example.com/',
      html: '<html/>',
    }));
    await expect(
      crawl4aiRenderMaterializer.materialize(
        streamed(oldEnvelope),
        manifestFor('crawl4ai-render/v1', 'text/html', oldEnvelope),
        { sanitizedUrl: 'https://example.com/', blocked: false },
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    const html = encoded('<html/>');
    await expect(
      crawl4aiRenderMaterializer.materialize(
        streamed(html),
        manifestFor('crawl4ai-render/v1', 'text/plain', html),
        { sanitizedUrl: 'https://example.com/', blocked: false },
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    const oversized = encoded(`<html>${'x'.repeat(3_000_001)}</html>`);
    await expect(
      crawl4aiRenderMaterializer.materialize(
        streamed(oversized),
        manifestFor('crawl4ai-render/v1', 'text/html', oversized),
        { sanitizedUrl: 'https://example.com/', blocked: false },
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    await expect(
      crawl4aiRenderMaterializer.materialize(
        streamed(html),
        manifestFor('crawl4ai-render/v1', 'text/html', html),
        { sanitizedUrl: 'https://example.com/person@example.com', blocked: false },
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });
});
