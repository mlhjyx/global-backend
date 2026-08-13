import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewUrlFor } from './preview-url';

afterEach(() => vi.unstubAllEnvs());

describe('previewUrlFor', () => {
  it.each(['draft', 'building', 'failed'])('does not expose non-previewable status %s', (status) => {
    expect(previewUrlFor({ slug: 'acme', status })).toBeNull();
  });

  it('uses the local default only for ready/published artifacts', () => {
    expect(previewUrlFor({ slug: 'acme', status: 'ready' })).toBe(
      'http://localhost:3000/preview/acme/',
    );
    expect(previewUrlFor({ slug: 'acme', status: 'published' })).toBe(
      'http://localhost:3000/preview/acme/',
    );
  });

  it('applies the configured deployment pattern without changing the slug', () => {
    vi.stubEnv('PREVIEW_URL_PATTERN', 'https://{slug}.preview.example.test/');
    expect(previewUrlFor({ slug: 'acme-eu', status: 'ready' })).toBe(
      'https://acme-eu.preview.example.test/',
    );
  });
});
