import { describe, expect, it } from 'vitest';
import { buildDemoSpec } from './demo-spec';
import {
  applyBuildScope,
  BuildActiveSpecInvalidError,
  BuildTargetAmbiguousError,
  BuildTargetNotFoundError,
} from './build-scope';

const intake = {
  company: { nameZh: '安可', nameEn: 'Acme' },
  industry: 'pumps',
  products: ['pumps'],
  targetMarkets: ['DE'],
  hasWebsite: false,
  businessEmail: 'sales@acme.test',
};
const active = buildDemoSpec({ siteName: 'Old', intake });
const candidate = buildDemoSpec({ siteName: 'New', intake });

describe('applyBuildScope', () => {
  it('returns the full candidate for an unfiltered site build', () => {
    expect(applyBuildScope(active, candidate, { scope: 'site' })).toBe(
      candidate,
    );
  });

  it('replaces only a requested page and its referenced copy', () => {
    const out = applyBuildScope(active, candidate, {
      scope: 'page',
      targetId: 'products',
    });
    expect(out.pages.find((page) => page.id === 'home')).toEqual(
      active.pages.find((page) => page.id === 'home'),
    );
    expect(out.pages.find((page) => page.id === 'products')).toEqual(
      candidate.pages.find((page) => page.id === 'products'),
    );
    expect(out.copyBundles.en['seo.products.title']).toBe('Products — New');
    expect(out.copyBundles.en['seo.home.title']).toBe('Old — Pumps Supplier');
  });

  it('replaces only requested pages for options.pages', () => {
    const out = applyBuildScope(active, candidate, {
      scope: 'site',
      options: { pages: ['home', 'contact'], locales: ['en'] },
    });
    expect(out.pages.find((page) => page.id === 'products')).toEqual(
      active.pages.find((page) => page.id === 'products'),
    );
    expect(out.copyBundles.en['seo.contact.title']).toBe('Contact — New');
  });

  it('replaces one unique section without changing its sibling blocks', () => {
    const targetId = 'AboutBlock-demo-1';
    const out = applyBuildScope(active, candidate, {
      scope: 'section',
      targetId,
    });
    const before = active.pages[0].puck.content;
    const after = out.pages[0].puck.content;
    expect(after[0]).toEqual(before[0]);
    expect(after.find((block) => block.props.id === targetId)).toEqual(
      candidate.pages[0].puck.content.find(
        (block) => block.props.id === targetId,
      ),
    );
  });

  it('fails closed for missing or duplicate targets', () => {
    expect(() =>
      applyBuildScope(active, candidate, {
        scope: 'page',
        targetId: 'missing',
      }),
    ).toThrow(BuildTargetNotFoundError);
    const duplicate = structuredClone(active);
    duplicate.pages.push({ ...duplicate.pages[0], path: '/duplicate' });
    expect(() =>
      applyBuildScope(duplicate, candidate, {
        scope: 'page',
        targetId: 'home',
      }),
    ).toThrow(BuildTargetAmbiguousError);
  });

  it('maps malformed active blocks to the stable dirty-spec error', () => {
    const malformed = structuredClone(active) as unknown as Record<
      string,
      unknown
    >;
    const pages = malformed.pages as Array<Record<string, unknown>>;
    const puck = pages[0].puck as Record<string, unknown>;
    puck.content = [null];
    expect(() =>
      applyBuildScope(malformed as never, candidate, {
        scope: 'section',
        targetId: 'AboutBlock-demo-1',
      }),
    ).toThrow(BuildActiveSpecInvalidError);
  });
});
