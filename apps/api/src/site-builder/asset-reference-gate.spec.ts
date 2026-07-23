import { describe, expect, it, vi } from 'vitest';
import { lockSiteSpecAssetsForActivation } from './asset-reference-gate';

const WS = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const ASSET = '33333333-3333-4333-8333-333333333333';
const HASH = 'a'.repeat(64);

function spec(
  manifest = true,
  props: Record<string, unknown> = { imageAssetId: ASSET },
) {
  return {
    specVersion: '1.0.0',
    assets: manifest ? { [ASSET]: { kind: 'logo', hash: HASH } } : {},
    pages: [
      {
        id: 'home',
        puck: {
          root: {},
          content: [{ type: 'Hero', props }],
        },
      },
    ],
  };
}

describe('SiteSpec activation Asset gate', () => {
  it('locks and verifies the same manifest+props Asset surface as DELETE', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: ASSET,
          siteId: SITE,
          kind: 'logo',
          processingStatus: 'ready',
          contentHash: HASH,
          deletedAt: null,
        },
      ]),
    };
    await expect(
      lockSiteSpecAssetsForActivation(tx as never, {
        workspaceId: WS,
        siteId: SITE,
        spec: spec(),
      }),
    ).resolves.toEqual([expect.objectContaining({ id: ASSET })]);
  });

  it('rejects a props reference to a real Asset omitted from the manifest', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: ASSET,
          siteId: SITE,
          kind: 'logo',
          processingStatus: 'ready',
          contentHash: HASH,
          deletedAt: null,
        },
      ]),
    };
    await expect(
      lockSiteSpecAssetsForActivation(tx as never, {
        workspaceId: WS,
        siteId: SITE,
        spec: spec(false, { imageAssetId: ASSET }),
      }),
    ).rejects.toThrow(/missing from the manifest/);
  });

  it('rejects a semantic Asset reference omitted from the manifest even when no row is visible', async () => {
    const tx = { $queryRaw: vi.fn(async () => []) };
    await expect(
      lockSiteSpecAssetsForActivation(tx as never, {
        workspaceId: WS,
        siteId: SITE,
        spec: spec(false, {
          imageAssetId: '44444444-4444-4444-8444-444444444444',
        }),
      }),
    ).rejects.toThrow(/missing from the manifest/);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('does not treat an unrelated component or business UUID as an Asset reference', async () => {
    const tx = { $queryRaw: vi.fn(async () => []) };
    await expect(
      lockSiteSpecAssetsForActivation(tx as never, {
        workspaceId: WS,
        siteId: SITE,
        spec: spec(false, {
          id: '44444444-4444-4444-8444-444444444444',
          offeringRef: '55555555-5555-4555-8555-555555555555',
        }),
      }),
    ).resolves.toEqual([]);
  });

  it.each([
    ['singular object', { imageAssetId: { value: ASSET } }],
    ['singular array', { imageAssetId: [ASSET] }],
    ['singular null', { imageAssetId: null }],
    ['plural object items', { assetIds: [{ value: ASSET }] }],
  ])(
    'fails closed for malformed %s Asset reference fields',
    async (_name, props) => {
      const tx = { $queryRaw: vi.fn(async () => []) };
      await expect(
        lockSiteSpecAssetsForActivation(tx as never, {
          workspaceId: WS,
          siteId: SITE,
          spec: spec(false, props),
        }),
      ).rejects.toThrow(/malformed/);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it('canonicalizes uppercase manifest and props UUIDs before comparing DB rows', async () => {
    const value = spec();
    value.assets = { [ASSET.toUpperCase()]: { kind: 'logo', hash: HASH } };
    value.pages[0]!.puck.content[0]!.props.imageAssetId = ASSET.toUpperCase();
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: ASSET,
          siteId: SITE,
          kind: 'logo',
          processingStatus: 'ready',
          contentHash: HASH,
          deletedAt: null,
        },
      ]),
    };
    await expect(
      lockSiteSpecAssetsForActivation(tx as never, {
        workspaceId: WS,
        siteId: SITE,
        spec: value,
      }),
    ).resolves.toHaveLength(1);
  });

  it('locks only tenant sources in SiteSpec 1.1 and accepts catalog refs without DB rows', async () => {
    const tx = {
      $queryRaw: vi.fn(async () => [
        {
          id: ASSET,
          siteId: SITE,
          kind: 'logo',
          processingStatus: 'ready',
          contentHash: HASH,
          deletedAt: null,
        },
      ]),
    };
    const value = {
      specVersion: '1.1.0',
      assets: {
        logo: {
          source: 'tenant',
          assetId: ASSET,
          kind: 'logo',
          contentHash: HASH,
          variantId: '44444444-4444-4444-8444-444444444444',
          variantHash: 'b'.repeat(64),
          mimeType: 'image/webp',
        },
        hero: {
          source: 'catalog',
          packId: 'pack',
          packVersion: '1.0.0',
          catalogAssetId: 'hero',
          sha256: 'c'.repeat(64),
          mimeType: 'image/svg+xml',
        },
      },
      pages: [
        {
          id: 'home',
          puck: {
            root: {},
            content: [
              {
                type: 'HeroBanner',
                props: { logoAssetId: 'logo', heroAssetId: 'hero' },
              },
            ],
          },
        },
      ],
    };
    await expect(
      lockSiteSpecAssetsForActivation(tx as never, {
        workspaceId: WS,
        siteId: SITE,
        spec: value,
      }),
    ).resolves.toEqual([expect.objectContaining({ id: ASSET })]);
  });

  it('rejects an undeclared logical asset reference in SiteSpec 1.1', async () => {
    const tx = { $queryRaw: vi.fn(async () => []) };
    await expect(
      lockSiteSpecAssetsForActivation(tx as never, {
        workspaceId: WS,
        siteId: SITE,
        spec: {
          specVersion: '1.1.0',
          assets: {},
          pages: [
            {
              id: 'home',
              puck: {
                root: {},
                content: [
                  {
                    type: 'HeroBanner',
                    props: { heroAssetId: 'not-declared' },
                  },
                ],
              },
            },
          ],
        },
      }),
    ).rejects.toThrow(/missing from the manifest/);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
