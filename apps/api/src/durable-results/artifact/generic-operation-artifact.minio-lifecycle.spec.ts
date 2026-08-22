import { describe, expect, it, vi } from 'vitest';
import {
  checkMinioAllVersionLifecycle,
  hasRequiredMinioAllVersionExpiry,
} from './generic-operation-artifact.minio-lifecycle';

const ttlIds = [
  'generic-operation-artifact-staging-ttl',
  'generic-operation-artifact-public-organization-ttl',
  'generic-operation-artifact-confidential-tenant-ttl',
  'generic-operation-artifact-personal-data-ttl',
] as const;

function lifecycleXml(missing?: string): string {
  const ttlRules = ttlIds
    .map(
      (id) =>
        `<Rule><ID>${id}</ID><Status>Enabled</Status>` +
        (id === missing
          ? ''
          : '<ExpiredObjectAllVersions>true</ExpiredObjectAllVersions>') +
        '</Rule>',
    )
    .join('');
  return (
    '<LifecycleConfiguration>' +
    ttlRules +
    '<Rule><ID>generic-operation-artifact-staging-delete-markers</ID></Rule>' +
    '<Rule><ID>generic-operation-artifact-final-delete-markers</ID></Rule>' +
    '<Rule><ID>generic-operation-artifact-readiness-cleanup</ID></Rule>' +
    '</LifecycleConfiguration>'
  );
}

describe('MinIO all-version lifecycle verifier', () => {
  it('accepts exactly seven rules with all four TTL rules deleting all versions', () => {
    expect(hasRequiredMinioAllVersionExpiry(lifecycleXml())).toBe(true);
  });

  it('rejects a single missing extension, duplicate rule and XML entity declaration', () => {
    expect(hasRequiredMinioAllVersionExpiry(lifecycleXml(ttlIds[3]))).toBe(
      false,
    );
    expect(
      hasRequiredMinioAllVersionExpiry(
        lifecycleXml().replace(
          '</LifecycleConfiguration>',
          `<Rule><ID>${ttlIds[0]}</ID><ExpiredObjectAllVersions>true</ExpiredObjectAllVersions></Rule></LifecycleConfiguration>`,
        ),
      ),
    ).toBe(false);
    expect(
      hasRequiredMinioAllVersionExpiry(
        `<!DOCTYPE x [<!ENTITY e "x">]>${lifecycleXml()}`,
      ),
    ).toBe(false);
  });

  it('sends one bounded redirect-free SigV4 lifecycle read', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(lifecycleXml(), {
          status: 200,
          headers: { 'content-type': 'application/xml' },
        }),
    );

    await expect(
      checkMinioAllVersionLifecycle(
        {
          endpoint: 'http://127.0.0.1:19000/',
          bucket: 'operation-artifacts-test',
          region: 'us-east-1',
          accessKeyId: 'runtime-artifact',
          secretAccessKey: 'must-never-be-returned',
          forcePathStyle: true,
        },
        fetcher,
        new Date('2026-08-22T00:00:00.000Z'),
      ),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith(
      'http://127.0.0.1:19000/operation-artifacts-test?lifecycle=',
      expect.objectContaining({
        method: 'GET',
        redirect: 'error',
        headers: expect.objectContaining({
          Authorization: expect.stringContaining(
            'Credential=runtime-artifact/20260822/us-east-1/s3/aws4_request',
          ),
        }),
      }),
    );
    expect(
      JSON.stringify(
        await checkMinioAllVersionLifecycle(
          {
            endpoint: 'http://127.0.0.1:19000/',
            bucket: 'operation-artifacts-test',
            region: 'us-east-1',
            accessKeyId: 'runtime-artifact',
            secretAccessKey: 'must-never-be-returned',
            forcePathStyle: true,
          },
          vi.fn(async () => new Response('', { status: 403 })),
        ),
      ),
    ).not.toContain('must-never-be-returned');
  });
});
