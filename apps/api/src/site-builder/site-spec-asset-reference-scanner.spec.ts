import { describe, expect, it } from 'vitest';
import { SiteSpecAssetReferenceScanner } from './site-spec-asset-reference-scanner';

const ASSET = '11111111-1111-4111-8111-111111111111';

describe('SiteSpecAssetReferenceScanner', () => {
  it('combines Profile and the current active SiteVersion without scanning historical versions', async () => {
    const calls: unknown[] = [];
    const tx = {
      site: {
        findUnique: async () => ({
          profile: { brand: { logoAssetId: ASSET } },
          activeVersionId: 'active-version',
        }),
      },
      siteVersion: {
        findFirst: async (args: unknown) => {
          calls.push(args);
          return {
            id: 'active-version',
            specVersion: '1.0.0',
            spec: {
              specVersion: '1.0.0',
              assets: { [ASSET]: { kind: 'logo', hash: 'a'.repeat(64) } },
              pages: [],
            },
          };
        },
      },
    };

    const usages = await new SiteSpecAssetReferenceScanner().scan(tx as never, {
      siteId: 'site-1',
      assetId: ASSET,
    });

    expect(calls).toEqual([
      expect.objectContaining({
        where: { id: 'active-version', siteId: 'site-1' },
      }),
    ]);
    expect(usages).toEqual([
      expect.objectContaining({ source: 'profile', page: '$profile' }),
      expect.objectContaining({
        source: 'site_spec',
        siteVersionId: 'active-version',
      }),
    ]);
  });

  it('fails closed when the DB specVersion disagrees with the supported contract', async () => {
    const tx = {
      site: {
        findUnique: async () => ({
          profile: null,
          activeVersionId: 'active-version',
        }),
      },
      siteVersion: {
        findFirst: async () => ({
          id: 'active-version',
          specVersion: '1.1.0',
          spec: { specVersion: '1.0.0', assets: {}, pages: [] },
        }),
      },
    };
    await expect(
      new SiteSpecAssetReferenceScanner().scan(tx as never, {
        siteId: 'site-1',
        assetId: ASSET,
      }),
    ).rejects.toThrow(/specVersion/);
  });

  it('fails closed when the active pointer cannot be resolved', async () => {
    const tx = {
      site: {
        findUnique: async () => ({ profile: null, activeVersionId: 'missing' }),
      },
      siteVersion: { findFirst: async () => null },
    };
    await expect(
      new SiteSpecAssetReferenceScanner().scan(tx as never, {
        siteId: 'site-1',
        assetId: ASSET,
      }),
    ).rejects.toThrow(/active SiteVersion pointer/);
  });
});
