import { describe, expect, it } from 'vitest';
import { extractDeterministicPublicWebCompany } from './public-web-deterministic-company';

function jsonLd(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
}

describe('deterministic public_web company extraction', () => {
  it.each(['Organization', 'Corporation', 'LocalBusiness'])(
    'accepts a same-site %s with an explicit bounded name',
    (type) => {
      const result = extractDeterministicPublicWebCompany(
        jsonLd({
          '@context': 'https://schema.org',
          '@type': type,
          name: 'ACME Manufacturing GmbH',
          url: 'https://www.acme.example/about',
          address: { addressCountry: 'DE' },
        }),
        'acme.example',
      );

      expect(result).toEqual({
        name: 'ACME Manufacturing GmbH',
        domain: 'acme.example',
        country: 'DE',
        organizationType: type,
        organizationUrl: 'https://www.acme.example/about',
      });
    },
  );

  it('supports arrays and @graph while ignoring nested manufacturer hypotheses', () => {
    const result = extractDeterministicPublicWebCompany(
      jsonLd({
        '@graph': [
          {
            '@type': 'Product',
            name: 'Laser X1',
            manufacturer: {
              '@type': 'Organization',
              name: 'Unverified Nested Maker',
              url: 'https://acme.example/',
            },
          },
          {
            '@type': ['Thing', 'Corporation'],
            name: 'ACME Corporation',
            url: 'https://acme.example/',
          },
        ],
      }),
      'acme.example',
    );

    expect(result?.name).toBe('ACME Corporation');
    expect(result?.organizationType).toBe('Corporation');
  });

  it('does not promote a postal code from addressCountry into country evidence', () => {
    const result = extractDeterministicPublicWebCompany(
      jsonLd({
        '@type': 'Organization',
        name: 'ACME Corporation',
        url: 'https://acme.example/',
        address: { addressCountry: '02141' },
      }),
      'acme.example',
    );

    expect(result).toEqual({
      name: 'ACME Corporation',
      domain: 'acme.example',
      organizationType: 'Organization',
      organizationUrl: 'https://acme.example/',
    });
  });

  it.each([
    ['missing URL', { '@type': 'Organization', name: 'ACME' }],
    ['foreign URL', { '@type': 'Organization', name: 'ACME', url: 'https://directory.example/acme' }],
    ['non-company type', { '@type': 'Person', name: 'ACME', url: 'https://acme.example/' }],
    ['blank name', { '@type': 'Organization', name: '   ', url: 'https://acme.example/' }],
    ['URL-shaped name', { '@type': 'Organization', name: 'https://acme.example/', url: 'https://acme.example/' }],
    ['overlong name', { '@type': 'Organization', name: 'x'.repeat(241), url: 'https://acme.example/' }],
  ])('rejects %s', (_label, node) => {
    expect(extractDeterministicPublicWebCompany(jsonLd(node), 'acme.example')).toBeNull();
  });

  it('fails closed when same-site organization declarations disagree', () => {
    expect(extractDeterministicPublicWebCompany(
      jsonLd({
        '@graph': [
          { '@type': 'Organization', name: 'ACME GmbH', url: 'https://acme.example/' },
          { '@type': 'Corporation', name: 'Different Holdings', url: 'https://acme.example/' },
        ],
      }),
      'acme.example',
    )).toBeNull();
  });

  it('skips malformed JSON-LD and rejects non-public candidate domains', () => {
    const html = [
      '<script type="application/ld+json">{broken</script>',
      jsonLd({ '@type': 'Organization', name: 'ACME', url: 'https://acme.example/' }),
    ].join('');

    expect(extractDeterministicPublicWebCompany(html, 'localhost')).toBeNull();
    expect(extractDeterministicPublicWebCompany(html, '127.0.0.1')).toBeNull();
  });
});
