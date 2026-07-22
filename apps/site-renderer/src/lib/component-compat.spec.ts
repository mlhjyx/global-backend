import { describe, expect, it } from 'vitest';
import { resolveServiceRowsCta } from './component-compat';

describe('ServiceRows 1.0 CTA compatibility', () => {
  it('preserves a legacy label when the page id uses its historical default', () => {
    expect(resolveServiceRowsCta(undefined, 'services.book', undefined)).toEqual({
      labelKey: 'services.book',
      pageId: 'services',
    });
  });

  it('preserves a legacy page id when the label uses its historical default', () => {
    expect(resolveServiceRowsCta(undefined, undefined, 'contact-us')).toEqual({
      labelKey: 'cta.learnMore',
      pageId: 'contact-us',
    });
  });

  it('gives the closed qualified CTA precedence over legacy props', () => {
    expect(resolveServiceRowsCta(
      { labelKey: 'services.cta', pageId: 'contact-us' },
      'services.book',
      'services',
    )).toEqual({ labelKey: 'services.cta', pageId: 'contact-us' });
  });
});
