import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SiteSpec } from '@global/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  R1_RENDERER_COMPONENT_TYPES,
  assertReleaseContract,
  buildReleaseArtifact,
  uploadReleaseArtifact,
} from './release-artifact';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function spec(types: readonly string[] = ['StatementBlock'], blockProps: Record<string, unknown> = { labelKey: 'l', statementKey: 's' }): SiteSpec {
  return {
    specVersion: '1.0.0',
    site: {
      defaultLocale: 'en',
      locales: ['en'],
      theme: { preset: 'precision-light' },
      nav: [{ labelKey: 'nav.home', pageId: 'home' }],
      seoGlobal: { siteName: 'Acme' },
    },
    pages: [
      {
        id: 'home',
        path: '/',
        puck: {
          root: {},
          content: types.map((type, index) => ({
            type,
            props: { id: `block-${index}`, ...blockProps },
          })),
        },
        seo: { titleKey: 'seo.title', descriptionKey: 'seo.description' },
      },
    ],
    assets: {},
    copyBundles: {
      en: {
        'nav.home': 'Home',
        'seo.title': 'Acme',
        'seo.description': 'Acme site',
      },
    },
  };
}

const identity = {
  releaseId: '50000000-0000-0000-0000-000000000001',
  workspaceId: '10000000-0000-0000-0000-000000000001',
  siteId: '20000000-0000-0000-0000-000000000001',
  siteVersionId: '40000000-0000-0000-0000-000000000001',
  buildRunId: '30000000-0000-0000-0000-000000000001',
  producerToken: '60000000-0000-0000-0000-000000000001',
  artifactPrefix:
    'sites/20000000-0000-0000-0000-000000000001/releases/50000000-0000-0000-0000-000000000001',
  releaseCreatedAt: new Date('2026-07-20T00:00:00.000Z'),
  buildIdentity: 'site-renderer@1.0.0+test',
};

describe('R1 release contract gate', () => {
  it('accepts only the exact SiteSpec contract and current closed renderer registry', () => {
    expect(R1_RENDERER_COMPONENT_TYPES).toEqual([
      'AboutBlock',
      'CertWall',
      'CtaBanner',
      'FaqAccordion',
      'HeroBanner',
      'InquiryForm',
      'MapLocation',
      'ProcessTimeline',
      'ProductGrid',
      'StatsBand',
    ]);
    // { id } 缺必填 props -> validateBlock zod parse fail-closed（INVALID_BLOCK_PROPS）
    expect(() =>
      assertReleaseContract(spec(R1_RENDERER_COMPONENT_TYPES), '1.0.0'),
    ).toThrow('INVALID_BLOCK_PROPS');
    // 合法 props（StatementBlock 必填 labelKey/statementKey）-> 通过
    expect(() =>
      assertReleaseContract(spec(['StatementBlock'], { labelKey: 'k', statementKey: 's' }), '1.0.0'),
    ).not.toThrow();
  });

  it('fails closed on an unknown component before renderer publication', () => {
    expect(() =>
      assertReleaseContract(spec(['StatementBlock', 'InventedWidget']), '1.0.0'),
    ).toThrow('UNKNOWN_COMPONENT_TYPE: InventedWidget');
  });

  it('fails closed when either stored or embedded specVersion is unsupported', () => {
    expect(() => assertReleaseContract(spec(), '2.0.0')).toThrow(
      'SITE_RELEASE_UNSUPPORTED_SPEC_VERSION',
    );
    const mismatched = spec();
    mismatched.specVersion = '1.1.0';
    expect(() => assertReleaseContract(mismatched, '1.0.0')).toThrow(
      'SITE_RELEASE_UNSUPPORTED_SPEC_VERSION',
    );
  });
});

describe('R1 deterministic release artifact', () => {
  it('sorts files, freezes digests, and isolates keys by producer token', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'r1-release-'));
    roots.push(root);
    await mkdir(path.join(root, 'assets'));
    await writeFile(path.join(root, 'z.html'), '<h1>Z</h1>');
    await writeFile(path.join(root, 'assets', 'app.css'), 'body{}');

    const first = await buildReleaseArtifact({
      ...identity,
      root,
      spec: spec(),
      storedSpecVersion: '1.0.0',
    });
    const replay = await buildReleaseArtifact({
      ...identity,
      root,
      spec: spec(),
      storedSpecVersion: '1.0.0',
    });

    expect(first.files.map((file) => file.path)).toEqual([
      'assets/app.css',
      'z.html',
    ]);
    expect(first.files[0]?.objectKey).toBe(
      `${identity.artifactPrefix}/attempts/${identity.producerToken}/files/assets/app.css`,
    );
    expect(first.manifestObjectKey).toBe(
      `${identity.artifactPrefix}/attempts/${identity.producerToken}/release-manifest.json`,
    );
    expect(first.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.manifestDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(first.manifest.files).toEqual(
      first.files.map(({ data: _data, ...file }) => file),
    );
    expect(replay.manifestBytes).toEqual(first.manifestBytes);
    expect(replay.manifestDigest).toBe(first.manifestDigest);
  });

  it('rejects symlinks instead of escaping or aliasing the renderer output', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'r1-release-'));
    roots.push(root);
    await writeFile(path.join(root, 'index.html'), 'safe');
    await symlink(path.join(root, 'index.html'), path.join(root, 'alias.html'));

    await expect(
      buildReleaseArtifact({
        ...identity,
        root,
        spec: spec(),
        storedSpecVersion: '1.0.0',
      }),
    ).rejects.toThrow('SITE_RELEASE_SYMLINK_FORBIDDEN');
  });

  it('makes ACK-loss retries idempotent and verifies every stored digest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'r1-release-'));
    roots.push(root);
    await writeFile(path.join(root, 'index.html'), 'hello');
    const release = await buildReleaseArtifact({
      ...identity,
      root,
      spec: spec(),
      storedSpecVersion: '1.0.0',
    });
    const objects = new Map<string, Buffer>();
    const storage = {
      putBufferImmutable: vi.fn(
        async (key: string, data: Buffer): Promise<'created' | 'exists'> => {
          if (objects.has(key)) return 'exists';
          objects.set(key, Buffer.from(data));
          return 'created';
        },
      ),
      hashObject: vi.fn(async (key: string) => {
        const data = objects.get(key);
        if (!data) throw new Error(`missing ${key}`);
        return {
          sha256: createHash('sha256').update(data).digest('hex'),
          head: data.subarray(0, 16),
          size: data.length,
        };
      }),
    };

    await uploadReleaseArtifact(release, storage);
    await uploadReleaseArtifact(release, storage);

    expect(objects.size).toBe(2);
    expect(storage.putBufferImmutable).toHaveBeenCalledTimes(4);
    expect(storage.hashObject).toHaveBeenCalledTimes(4);
  });

  it('fails closed when an existing object does not match its manifest digest', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'r1-release-'));
    roots.push(root);
    await writeFile(path.join(root, 'index.html'), 'expected');
    const release = await buildReleaseArtifact({
      ...identity,
      root,
      spec: spec(),
      storedSpecVersion: '1.0.0',
    });
    const storage = {
      putBufferImmutable: vi.fn(async () => 'exists' as const),
      hashObject: vi.fn(async () => ({
        sha256: createHash('sha256').update('different').digest('hex'),
        head: Buffer.alloc(0),
        size: 9,
      })),
    };

    await expect(uploadReleaseArtifact(release, storage)).rejects.toThrow(
      'SITE_RELEASE_OBJECT_INTEGRITY_MISMATCH',
    );
  });
});
