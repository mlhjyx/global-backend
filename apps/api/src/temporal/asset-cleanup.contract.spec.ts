import { describe, expect, it } from 'vitest';
import {
  assetCleanupPayload,
  AssetCleanupContractError,
  parseAssetCleanupCommand,
  matchesAssetCleanupPayload,
} from './asset-cleanup.contract';

const EVENT = '11111111-1111-4111-8111-111111111111';
const WS = '22222222-2222-4222-8222-222222222222';
const SITE = '33333333-3333-4333-8333-333333333333';
const ASSET = '44444444-4444-4444-8444-444444444444';
const V1 = '55555555-5555-4555-8555-555555555555';
const V2 = '66666666-6666-4666-8666-666666666666';
const SOURCE = 'a'.repeat(64);
const CHILD = 'b'.repeat(64);
const TOKEN = '77777777-7777-4777-8777-777777777777';

function canonical() {
  return {
    eventId: EVENT,
    workspaceId: WS,
    siteId: SITE,
    assetId: ASSET,
    objectClass: 'canonical',
    reason: 'asset_deleted',
    canonical: {
      objectKey: `ws/${WS}/${SITE}/product_image/${SOURCE}.jpg`,
      contentHash: SOURCE,
    },
    variants: [
      {
        id: V1,
        objectKey: `ws/${WS}/${SITE}/variants/${ASSET}/${SOURCE}.webp`,
        contentHash: 'c'.repeat(64),
        recipeHash: SOURCE,
        sourceVariantId: null,
        status: 'ready',
      },
      {
        id: V2,
        objectKey: `ws/${WS}/${SITE}/variants/${ASSET}/${CHILD}.avif`,
        contentHash: null,
        recipeHash: CHILD,
        sourceVariantId: V1,
        status: 'failed',
      },
    ],
  };
}

describe('MF0-B canonical cleanup contract', () => {
  it('accepts an exact sorted frozen plan and produces its Outbox payload', () => {
    const command = parseAssetCleanupCommand(canonical());
    expect(command.objectClass).toBe('canonical');
    expect(assetCleanupPayload(command)).toEqual({
      assetId: ASSET,
      siteId: SITE,
      objectClass: 'canonical',
      reason: 'asset_deleted',
      canonical: canonical().canonical,
      variants: canonical().variants,
    });
  });

  it('compares jsonb payloads independent of nested object key order', () => {
    const command = parseAssetCleanupCommand(canonical());
    const payload = assetCleanupPayload(command);
    expect(
      matchesAssetCleanupPayload(
        {
          variants: (payload.variants as unknown[]).map((variant) => {
            const row = variant as Record<string, unknown>;
            return Object.fromEntries(Object.entries(row).reverse());
          }),
          canonical: Object.fromEntries(Object.entries(payload.canonical as Record<string, unknown>).reverse()),
          reason: payload.reason,
          objectClass: payload.objectClass,
          siteId: payload.siteId,
          assetId: payload.assetId,
        },
        command,
      ),
    ).toBe(true);
  });

  it('accepts a producer-isolated attempt key only when token, asset and recipe provenance match', () => {
    const value = canonical();
    value.variants[0] = {
      ...value.variants[0],
      attemptKeys: [`ws/${WS}/${SITE}/variant-attempts/${ASSET}/${TOKEN}/${SOURCE}.webp`],
    } as typeof value.variants[number] & { attemptKeys: string[] };
    const parsed = parseAssetCleanupCommand(value);
    expect(parsed.objectClass).toBe('canonical');
    if (parsed.objectClass !== 'canonical') throw new Error('test command mismatch');
    expect(parsed.variants[0]?.attemptKeys?.[0]).toContain(TOKEN);
    value.variants[0].attemptKeys = [`ws/${WS}/${SITE}/variant-attempts/${ASSET}/${TOKEN}/${CHILD}.webp`];
    expect(() => parseAssetCleanupCommand(value)).toThrow(/attempt key/);
  });

  it.each([
    ['unknown field', { ...canonical(), surprise: true }],
    [
      'wrong canonical scope',
      {
        ...canonical(),
        canonical: { ...canonical().canonical, objectKey: 'other' },
      },
    ],
    [
      'processing variant',
      {
        ...canonical(),
        variants: [{ ...canonical().variants[0], status: 'processing' }],
      },
    ],
    ['missing source', { ...canonical(), variants: [{ ...canonical().variants[1] }] }],
    ['unsorted variants', { ...canonical(), variants: [...canonical().variants].reverse() }],
  ])('fails closed for %s', (_label, value) => {
    expect(() => parseAssetCleanupCommand(value)).toThrow(AssetCleanupContractError);
  });

  it('rejects a cyclic frozen Variant graph before a tombstone can be emitted', () => {
    const value = canonical();
    value.variants[0].sourceVariantId = V2;
    expect(() => parseAssetCleanupCommand(value)).toThrow(/cycle/);
  });

  it('rejects plans above the proven 128-Variant execution budget', () => {
    const value = canonical();
    value.variants = Array.from({ length: 129 }, (_unused, index) => {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const recipeHash = index.toString(16).padStart(64, '0');
      return {
        id,
        objectKey: `ws/${WS}/${SITE}/variants/${ASSET}/${recipeHash}.webp`,
        contentHash: 'c'.repeat(64),
        recipeHash,
        sourceVariantId: null,
        status: 'ready' as const,
      };
    });
    expect(() => parseAssetCleanupCommand(value)).toThrow(/bounded array/);
  });

  it('rejects a plan whose canonical, variants and attempts exceed 128 total objects', () => {
    const value = canonical();
    value.variants = Array.from({ length: 64 }, (_unused, index) => {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const recipeHash = index.toString(16).padStart(64, '0');
      return {
        id,
        objectKey: `ws/${WS}/${SITE}/variants/${ASSET}/${recipeHash}.webp`,
        contentHash: 'c'.repeat(64),
        recipeHash,
        sourceVariantId: null,
        status: 'ready' as const,
        attemptKeys: [
          `ws/${WS}/${SITE}/variant-attempts/${ASSET}/${TOKEN}/${recipeHash}.webp`,
        ],
      };
    });
    expect(() => parseAssetCleanupCommand(value)).toThrow(/128 total objects/);
  });

  it('replays the legacy upper bound of 128 variants plus canonical when no attempt field exists', () => {
    const value = canonical();
    value.variants = Array.from({ length: 128 }, (_unused, index) => {
      const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
      const recipeHash = index.toString(16).padStart(64, '0');
      return {
        id,
        objectKey: `ws/${WS}/${SITE}/variants/${ASSET}/${recipeHash}.webp`,
        contentHash: 'c'.repeat(64),
        recipeHash,
        sourceVariantId: null,
        status: 'ready' as const,
      };
    });
    expect(parseAssetCleanupCommand(value)).toMatchObject({ objectClass: 'canonical' });
  });
});
