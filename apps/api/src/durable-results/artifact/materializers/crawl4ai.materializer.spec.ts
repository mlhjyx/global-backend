import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  crawl4aiFetchMaterializer,
  crawl4aiRenderMaterializer,
} from './crawl4ai.materializer';
import {
  jsonBytes,
  manifestFor,
  streamed,
} from './materializer-fixtures.spec-helper';

const shortHash = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 24);

describe('crawl4ai materializers', () => {
  it('restores the exact bounded fetch result and verifies its content hash', async () => {
    const text = '# ACME\n\nbounded evidence';
    const bytes = jsonBytes({
      url: 'https://example.com/',
      text,
      contentHash: shortHash(text),
    });
    const output = await crawl4aiFetchMaterializer.materialize(
      streamed(bytes, [2, 1, 4]),
      manifestFor('crawl4ai-fetch/v1', 'text/markdown', bytes),
    );
    expect(output).toEqual({
      url: 'https://example.com/',
      text,
      contentHash: shortHash(text),
    });
    expect(Object.keys(output).sort()).toEqual(['contentHash', 'text', 'url']);
  });

  it('restores render output without persisting or returning raw response headers', async () => {
    const bytes = jsonBytes({
      url: 'https://example.com/',
      html: '<!doctype html><html><body>ok</body></html>',
      robotsBlocked: false,
    });
    const output = await crawl4aiRenderMaterializer.materialize(
      streamed(bytes),
      manifestFor('crawl4ai-render/v1', 'text/html', bytes),
    );
    expect(output).toEqual({
      url: 'https://example.com/',
      html: '<!doctype html><html><body>ok</body></html>',
      headers: {},
      robotsBlocked: false,
    });
    expect(output.headers).toEqual({});
  });

  it('restores the render shape without the optional robots flag', async () => {
    const bytes = jsonBytes({
      url: 'https://example.com/',
      html: '<html/>',
    });
    await expect(
      crawl4aiRenderMaterializer.materialize(
        streamed(bytes),
        manifestFor('crawl4ai-render/v1', 'text/html', bytes),
      ),
    ).resolves.toEqual({
      url: 'https://example.com/',
      html: '<html/>',
      headers: {},
    });
  });

  it.each([
    ['missing fetch url', { text: 'x', contentHash: shortHash('x') }],
    ['wrong fetch hash', { url: 'https://example.com/', text: 'x', contentHash: '0'.repeat(24) }],
    ['invalid fetch url', { url: 'file:///tmp/private', text: 'x', contentHash: shortHash('x') }],
    ['invalid fetch text', { url: 'https://example.com/', text: 1, contentHash: shortHash('x') }],
    ['raw render headers', { url: 'https://example.com/', html: '<html/>', headers: { cookie: 'secret' } }],
    ['render token', { url: 'https://example.com/', html: '<html/>', token: 'secret' }],
    ['render invalid robots flag', { url: 'https://example.com/', html: '<html/>', robotsBlocked: 'false' }],
  ])('rejects %s', async (name, value) => {
    const isRender = name.includes('render');
    const schema = isRender ? 'crawl4ai-render/v1' : 'crawl4ai-fetch/v1';
    const mediaType = isRender ? 'text/html' : 'text/markdown';
    const materializer = isRender ? crawl4aiRenderMaterializer : crawl4aiFetchMaterializer;
    const bytes = jsonBytes(value);
    await expect(
      materializer.materialize(
        streamed(bytes),
        manifestFor(schema, mediaType, bytes),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('rejects media mismatch and HTML above the fixed artifact maximum', async () => {
    const valid = jsonBytes({
      url: 'https://example.com/',
      text: '',
      contentHash: shortHash(''),
    });
    await expect(
      crawl4aiFetchMaterializer.materialize(
        streamed(valid),
        manifestFor('crawl4ai-fetch/v1', 'text/html', valid),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    const oversized = jsonBytes({
      url: 'https://example.com/',
      html: 'x'.repeat(3_000_001),
    });
    await expect(
      crawl4aiRenderMaterializer.materialize(
        streamed(oversized),
        manifestFor('crawl4ai-render/v1', 'text/html', oversized),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });

  it('rejects over-depth JSON and trailing documents before result restoration', async () => {
    const deep = new TextEncoder().encode(`${'{"x":'.repeat(33)}null${'}'.repeat(33)}`);
    await expect(
      crawl4aiFetchMaterializer.materialize(
        streamed(deep),
        manifestFor('crawl4ai-fetch/v1', 'text/markdown', deep),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');

    const trailing = new TextEncoder().encode(
      `${JSON.stringify({ url: 'https://example.com/', html: '<html/>' })}[]`,
    );
    await expect(
      crawl4aiRenderMaterializer.materialize(
        streamed(trailing),
        manifestFor('crawl4ai-render/v1', 'text/html', trailing),
      ),
    ).rejects.toThrow('GENERIC_OPERATION_ARTIFACT_INVALID');
  });
});
