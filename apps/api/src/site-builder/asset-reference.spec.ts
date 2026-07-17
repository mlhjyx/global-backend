import { describe, expect, it } from 'vitest';
import {
  AssetReferenceScanError,
  extractProfileAssetReferences,
  profileUsagesForAsset,
  scanSiteSpecAssetReferences,
  siteSpecManifestAssetIds,
} from './asset-reference';

const ASSET = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ALPHA_ASSET = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

function spec() {
  return {
    specVersion: '1.0.0',
    site: {},
    assets: {
      [ASSET]: { kind: 'product_image', hash: 'a'.repeat(64) },
      [OTHER]: { kind: 'logo', hash: 'b'.repeat(64) },
    },
    copyBundles: { en: { uuidInProse: ASSET } },
    pages: [
      {
        id: 'home',
        puck: {
          root: { props: { logo: { assetId: ASSET } } },
          content: [
            {
              type: 'HeroBanner',
              props: {
                id: 'hero-main',
                image: { assetId: ASSET },
                gallery: [{ image: { assetId: ASSET } }],
                videoRef: { video: OTHER, poster: ASSET },
              },
            },
            { type: 'CertWall', props: { certs: [{ assetId: ASSET }] } },
          ],
        },
      },
    ],
  };
}

describe('MF0-B asset reference extraction', () => {
  it('scans the 1.0.0 manifest, root and arbitrary nested component props with stable pointers', () => {
    expect(scanSiteSpecAssetReferences(spec(), ASSET, 'version-1')).toEqual([
      {
        source: 'site_spec',
        siteVersionId: 'version-1',
        page: '$site',
        component: '$assets',
        fieldPath: `/assets/${ASSET}`,
      },
      {
        source: 'site_spec',
        siteVersionId: 'version-1',
        page: 'home',
        component: '$root',
        fieldPath: '/pages/0/puck/root/props/logo/assetId',
      },
      {
        source: 'site_spec',
        siteVersionId: 'version-1',
        page: 'home',
        component: 'CertWall:1',
        fieldPath: '/pages/0/puck/content/1/props/certs/0/assetId',
      },
      {
        source: 'site_spec',
        siteVersionId: 'version-1',
        page: 'home',
        component: 'hero-main',
        fieldPath: '/pages/0/puck/content/0/props/gallery/0/image/assetId',
      },
      {
        source: 'site_spec',
        siteVersionId: 'version-1',
        page: 'home',
        component: 'hero-main',
        fieldPath: '/pages/0/puck/content/0/props/image/assetId',
      },
      {
        source: 'site_spec',
        siteVersionId: 'version-1',
        page: 'home',
        component: 'hero-main',
        fieldPath: '/pages/0/puck/content/0/props/videoRef/poster',
      },
    ]);
  });

  it('does not scan prose or unrelated envelope fields', () => {
    const value = spec();
    delete value.assets[ASSET];
    value.pages[0].puck.root.props = {};
    value.pages[0].puck.content = [];
    expect(scanSiteSpecAssetReferences(value, ASSET)).toEqual([]);
  });

  it('extracts sorted UUID manifest ids for the write-side gate', () => {
    expect(siteSpecManifestAssetIds(spec())).toEqual([ASSET, OTHER]);
  });

  it('matches a manifest-only reference when the DELETE UUID uses uppercase hex', () => {
    const value = { ...spec(), assets: { [ALPHA_ASSET]: { kind: 'logo', hash: 'c'.repeat(64) } } };
    expect(scanSiteSpecAssetReferences(value, ALPHA_ASSET.toUpperCase())).toEqual([
      expect.objectContaining({
        component: '$assets',
        fieldPath: `/assets/${ALPHA_ASSET}`,
      }),
    ]);
  });

  it('rejects duplicate manifest UUIDs that differ only by letter case', () => {
    const value = {
      ...spec(),
      assets: {
        [ALPHA_ASSET]: { kind: 'logo', hash: 'c'.repeat(64) },
        [ALPHA_ASSET.toUpperCase()]: { kind: 'logo', hash: 'c'.repeat(64) },
      },
    };
    expect(() => siteSpecManifestAssetIds(value)).toThrow(/duplicate UUID/);
  });

  it('covers all three as-built Profile reference positions', () => {
    const profile = {
      brand: { logoAssetId: ASSET },
      trustAssets: {
        certifications: [{ name: 'ISO', certificateAssetIds: [OTHER, ASSET] }],
        customerCases: [{ displayLabel: 'OEM', assetIds: [ASSET] }],
      },
      contact: { publicEmails: [ASSET] },
    };
    expect(extractProfileAssetReferences(profile)).toHaveLength(4);
    expect(profileUsagesForAsset(profile, ASSET)).toEqual([
      expect.objectContaining({
        component: 'brand',
        fieldPath: '/brand/logoAssetId',
      }),
      expect.objectContaining({
        component: 'contact',
        fieldPath: '/contact/publicEmails/0',
      }),
      expect.objectContaining({
        component: 'trustAssets',
        fieldPath: '/trustAssets/certifications/0/certificateAssetIds/1',
      }),
      expect.objectContaining({
        component: 'trustAssets',
        fieldPath: '/trustAssets/customerCases/0/assetIds/0',
      }),
    ]);
  });

  it('conservatively finds an exact asset UUID in an unknown historical Profile path', () => {
    expect(profileUsagesForAsset({ legacyMedia: { hero: { source: ASSET } } }, ASSET)).toEqual([
      {
        source: 'profile',
        page: '$profile',
        component: 'legacyMedia',
        fieldPath: '/legacyMedia/hero/source',
      },
    ]);
  });

  it('matches uppercase UUID values while preserving their JSON Pointer location', () => {
    expect(profileUsagesForAsset({ legacyMedia: { source: ASSET.toUpperCase() } }, ASSET)).toEqual([
      expect.objectContaining({
        component: 'legacyMedia',
        fieldPath: '/legacyMedia/source',
      }),
    ]);
  });

  it('fails closed when a historical Profile exceeds the scan depth budget', () => {
    let profile: Record<string, unknown> = { ref: ASSET };
    for (let depth = 0; depth < 40; depth += 1) profile = { nested: profile };
    expect(() => profileUsagesForAsset(profile, ASSET)).toThrow(AssetReferenceScanError);
  });

  it('fails closed instead of filtering malformed manifest ids', () => {
    expect(() =>
      scanSiteSpecAssetReferences({ specVersion: '1.0.0', assets: { 'asset~/id': {} }, pages: [] }, ASSET),
    ).toThrow(AssetReferenceScanError);
  });

  it('fails closed for unknown versions, malformed envelopes and excessive nesting', () => {
    expect(() => scanSiteSpecAssetReferences({ specVersion: '1.1.0', assets: {}, pages: [] }, ASSET)).toThrow(
      AssetReferenceScanError,
    );
    expect(() => scanSiteSpecAssetReferences({ specVersion: '1.0.0', assets: {} }, ASSET)).toThrow(
      AssetReferenceScanError,
    );
    expect(() =>
      scanSiteSpecAssetReferences(
        {
          specVersion: '1.0.0',
          assets: {},
          pages: [{ id: 'home', puck: null }],
        },
        ASSET,
      ),
    ).toThrow(AssetReferenceScanError);
    expect(() =>
      scanSiteSpecAssetReferences(
        {
          specVersion: '1.0.0',
          assets: {},
          pages: [
            {
              id: 'home',
              puck: { root: {}, content: [{ type: 'Hero', props: null }] },
            },
          ],
        },
        ASSET,
      ),
    ).toThrow(AssetReferenceScanError);
    let nested: unknown = ASSET;
    for (let index = 0; index < 40; index += 1) nested = { child: nested };
    expect(() =>
      scanSiteSpecAssetReferences(
        {
          specVersion: '1.0.0',
          assets: {},
          pages: [{ id: 'home', puck: { root: { props: nested }, content: [] } }],
        },
        ASSET,
      ),
    ).toThrow(AssetReferenceScanError);
  });
});
