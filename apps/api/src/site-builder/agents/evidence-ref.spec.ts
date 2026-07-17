import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  freezeEvidenceSource,
  resolveEvidenceReference,
  type FrozenEvidenceSource,
} from './evidence-ref';

const sha256 = (text: string): string =>
  createHash('sha256').update(text, 'utf8').digest('hex');

const uploadSource = (
  over: Partial<FrozenEvidenceSource> = {},
): FrozenEvidenceSource => ({
  sourceKey: 'kb_document:doc-1',
  sourceType: 'upload',
  sourceRole: 'fact_candidate',
  hashAlgorithm: 'sha256',
  contentHash: sha256('泵😀最高工作压力 400 bar。'),
  normalizationVersion: 'evidence-text/1',
  snapshotText: '泵😀最高工作压力 400 bar。',
  provenance: {
    documentId: 'doc-1',
    chunkIds: ['chunk-1'],
    parserVersion: 'docling/1',
  },
  ...over,
});

describe('freezeEvidenceSource — Evidence 2.0 frozen corpus', () => {
  it('scrubs PII before normalizing and hashing the exact prompt corpus', () => {
    const source = freezeEvidenceSource({
      sourceKey: 'intake:profile-v1',
      sourceType: 'intake',
      sourceRole: 'fact_candidate',
      rawText: 'Sales: alice@example.com\r\nPressure:  400 bar',
      provenance: { profileVersionId: 'profile-v1' },
    });

    expect(source.snapshotText).toBe(
      'Sales: [redacted-email]\nPressure: 400 bar',
    );
    expect(source.contentHash).toBe(sha256(source.snapshotText));
    expect(source.snapshotText).not.toContain('alice@example.com');
  });

  it('keeps upstream object/crawl hash distinct from the frozen prompt hash', () => {
    const source = freezeEvidenceSource({
      sourceKey: 'kb_document:doc-1',
      sourceType: 'upload',
      sourceRole: 'fact_candidate',
      rawText: 'sanitized and bounded prompt text',
      upstreamContentHash: 'a'.repeat(64),
      provenance: { assetId: 'asset-1', chunkIds: ['chunk-1'] },
    });

    expect(source.upstreamContentHash).toBe('a'.repeat(64));
    expect(source.contentHash).toBe(sha256(source.snapshotText));
    expect(source.contentHash).not.toBe(source.upstreamContentHash);
  });

  it('redacts URL credentials, fragments and sensitive query values', () => {
    const source = freezeEvidenceSource({
      sourceKey: 'storefront:https://acme.example/catalog',
      sourceType: 'storefront',
      sourceRole: 'fact_candidate',
      rawText: 'Pumps up to 400 bar.',
      displayUrl:
        'https://user:pass@Acme.example/catalog?token=secret&utm_source=test#team',
      provenance: { parserVersion: 'crawl4ai/1' },
    });

    expect(source.displayUrl).toBe(
      'https://acme.example/catalog?token=%5Bredacted%5D&utm_source=test',
    );
  });

  it('redacts camel-case credential query values without redacting benign keys', () => {
    const source = freezeEvidenceSource({
      sourceKey: 'storefront:https://acme.example/catalog',
      sourceType: 'storefront',
      sourceRole: 'fact_candidate',
      rawText: 'Pumps up to 400 bar.',
      displayUrl:
        'https://acme.example/catalog?apiKey=secret-1&accessToken=secret-2&clientSecret=secret-3&authorizationCode=secret-4&hockey=keep',
      provenance: { parserVersion: 'crawl4ai/1' },
    });

    expect(source.displayUrl).toBe(
      'https://acme.example/catalog?apiKey=%5Bredacted%5D&accessToken=%5Bredacted%5D&clientSecret=%5Bredacted%5D&authorizationCode=%5Bredacted%5D&hockey=keep',
    );
  });

  it('redacts PII in URL path/query metadata and drops overlong display URLs', () => {
    const source = freezeEvidenceSource({
      sourceKey: 'web_research:directory',
      sourceType: 'web_research',
      sourceRole: 'research_hint',
      rawText: 'Directory snippet about Acme pumps.',
      displayUrl:
        'https://directory.example/contact/alice%40example.com?email=bob%40example.com&phone=%2B49%2030%201234567',
      provenance: { parserVersion: 'searxng-snippet/1' },
    });

    const decoded = decodeURIComponent(source.displayUrl ?? '');
    expect(decoded).not.toContain('alice@example.com');
    expect(decoded).not.toContain('bob@example.com');
    expect(decoded).not.toContain('+49 30 1234567');
    expect(decoded).toContain('[redacted-email]');
    expect(decoded).toContain('[redacted-phone]');

    const overlong = freezeEvidenceSource({
      sourceKey: 'storefront:overlong',
      sourceType: 'storefront',
      sourceRole: 'fact_candidate',
      rawText: 'Acme storefront.',
      displayUrl: `https://acme.example/${'x'.repeat(2_100)}`,
      provenance: { parserVersion: 'crawl4ai/1' },
    });
    expect(overlong.displayUrl).toBeUndefined();
  });
});

describe('resolveEvidenceReference — exact quote/hash/source binding', () => {
  it('requires an exact quote for every new fact and records Unicode code-point selectors', () => {
    const source = uploadSource();
    const resolved = resolveEvidenceReference(
      {
        sourceId: '11111111-1111-4111-8111-111111111111',
        sourceType: 'upload',
        contentHash: source.contentHash,
        quote: '最高工作压力 400 bar',
      },
      new Map([['11111111-1111-4111-8111-111111111111', source]]),
      { evidenceRefId: '22222222-2222-4222-8222-222222222222' },
    );

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.ref).toMatchObject({
      version: 2,
      sourceId: '11111111-1111-4111-8111-111111111111',
      sourceRole: 'fact_candidate',
      hashAlgorithm: 'sha256',
      contentHash: source.contentHash,
      quote: '最高工作压力 400 bar',
      selector: { start: 2, end: 16 },
    });
  });

  it('rejects missing quotes and punctuation/case-normalized near matches', () => {
    const source = uploadSource({
      snapshotText: 'Acme’s pump—rated to 400 bar.',
      contentHash: sha256('Acme’s pump—rated to 400 bar.'),
    });
    const sources = new Map([['source-1', source]]);

    expect(
      resolveEvidenceReference(
        {
          sourceId: 'source-1',
          sourceType: 'upload',
          contentHash: source.contentHash,
        },
        sources,
        { evidenceRefId: 'ref-1' },
      ),
    ).toMatchObject({ ok: false, reason: 'missing_quote' });
    expect(
      resolveEvidenceReference(
        {
          sourceId: 'source-1',
          sourceType: 'upload',
          contentHash: source.contentHash,
          quote: "acme's pump - rated to 400 bar",
        },
        sources,
        { evidenceRefId: 'ref-2' },
      ),
    ).toMatchObject({ ok: false, reason: 'unsupported_quote' });
  });

  it('rejects a real source ID paired with the wrong frozen hash or source type', () => {
    const source = uploadSource();
    const sources = new Map([['source-1', source]]);

    expect(
      resolveEvidenceReference(
        {
          sourceId: 'source-1',
          sourceType: 'upload',
          contentHash: 'b'.repeat(64),
          quote: '最高工作压力 400 bar',
        },
        sources,
        { evidenceRefId: 'ref-1' },
      ),
    ).toMatchObject({ ok: false, reason: 'source_hash_mismatch' });
    expect(
      resolveEvidenceReference(
        {
          sourceId: 'source-1',
          sourceType: 'intake',
          contentHash: source.contentHash,
          quote: '最高工作压力 400 bar',
        },
        sources,
        { evidenceRefId: 'ref-2' },
      ),
    ).toMatchObject({ ok: false, reason: 'source_type_mismatch' });
  });

  it('carries a web-search snippet only as research_hint provenance', () => {
    const source = uploadSource({
      sourceType: 'web_research',
      sourceRole: 'research_hint',
      displayUrl: 'https://directory.example/acme',
    });
    const resolved = resolveEvidenceReference(
      {
        sourceId: 'source-1',
        sourceType: 'web_research',
        contentHash: source.contentHash,
        quote: '最高工作压力 400 bar',
      },
      new Map([['source-1', source]]),
      { evidenceRefId: 'ref-1' },
    );

    expect(resolved).toMatchObject({
      ok: true,
      ref: { sourceRole: 'research_hint' },
    });
  });
});
