import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveGhcrManifest } from './ghcr-runtime-publication.mjs';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;
const fixtureValue = (...parts) => parts.join('-');
const TEST_WORKFLOW_CREDENTIAL = fixtureValue('workflow', 'fixture');
const TEST_REGISTRY_BEARER = fixtureValue('registry', 'fixture');

function response(status, body = '', headers = {}) {
  return new Response(body, { status, headers });
}

test('resolves an exact SHA tag through bounded GHCR token and manifest requests', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) {
      return response(200, JSON.stringify({ token: TEST_REGISTRY_BEARER }), {
        'content-type': 'application/json',
      });
    }
    return response(200, '', {
      'content-type': 'application/vnd.oci.image.manifest.v1+json',
      'docker-content-digest': DIGEST,
    });
  };

  const result = await resolveGhcrManifest({
    image: 'mlhjyx/global-backend',
    tag: SHA,
    username: 'publisher',
    token: TEST_WORKFLOW_CREDENTIAL,
    fetchFn,
  });

  assert.deepEqual(result, { status: 'FOUND', digest: DIGEST });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /^https:\/\/ghcr\.io\/token\?/);
  assert.match(calls[0].url, /scope=repository%3Amlhjyx%2Fglobal-backend%3Apull/);
  assert.equal(
    calls[0].init.headers.authorization,
    `Basic ${Buffer.from(`publisher:${TEST_WORKFLOW_CREDENTIAL}`).toString('base64')}`,
  );
  assert.equal(calls[1].init.method, 'HEAD');
  assert.equal(calls[1].init.redirect, 'error');
  assert.equal(calls[1].init.headers.authorization, `Bearer ${TEST_REGISTRY_BEARER}`);
});

test('returns NOT_FOUND only for an authenticated manifest 404', async () => {
  let call = 0;
  const result = await resolveGhcrManifest({
    image: 'mlhjyx/global-backend',
    tag: SHA,
    username: 'publisher',
    token: TEST_WORKFLOW_CREDENTIAL,
    fetchFn: async () => {
      call += 1;
      return call === 1
        ? response(200, JSON.stringify({ token: TEST_REGISTRY_BEARER }))
        : response(404);
    },
  });
  assert.deepEqual(result, { status: 'NOT_FOUND' });
});

test('fails closed for token errors, manifest errors, and malformed digests', async () => {
  await assert.rejects(
    resolveGhcrManifest({
      image: 'mlhjyx/global-backend',
      tag: SHA,
      username: 'publisher',
      token: TEST_WORKFLOW_CREDENTIAL,
      fetchFn: async () => response(503),
    }),
    /GHCR_TOKEN_UNAVAILABLE/,
  );

  for (const [status, digest, expected] of [
    [503, null, 'GHCR_MANIFEST_UNAVAILABLE'],
    [200, 'sha256:not-a-digest', 'GHCR_MANIFEST_DIGEST_INVALID'],
  ]) {
    let call = 0;
    await assert.rejects(
      resolveGhcrManifest({
        image: 'mlhjyx/global-backend',
        tag: SHA,
        username: 'publisher',
        token: TEST_WORKFLOW_CREDENTIAL,
        fetchFn: async () => {
          call += 1;
          return call === 1
            ? response(200, JSON.stringify({ token: TEST_REGISTRY_BEARER }))
            : response(
                status,
                '',
                digest
                  ? {
                      'content-type': 'application/vnd.oci.image.manifest.v1+json',
                      'docker-content-digest': digest,
                    }
                  : {},
              );
        },
      }),
      new RegExp(expected),
    );
  }
});

test('rejects OCI indexes and Docker manifest lists instead of attesting unseen platforms', async () => {
  for (const mediaType of [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
  ]) {
    let call = 0;
    await assert.rejects(
      resolveGhcrManifest({
        image: 'mlhjyx/global-backend',
        tag: SHA,
        username: 'publisher',
        token: TEST_WORKFLOW_CREDENTIAL,
        fetchFn: async () => {
          call += 1;
          return call === 1
            ? response(200, JSON.stringify({ token: TEST_REGISTRY_BEARER }))
            : response(200, '', {
                'content-type': mediaType,
                'docker-content-digest': DIGEST,
              });
        },
      }),
      /GHCR_MANIFEST_MEDIA_TYPE_INVALID/,
    );
  }
});

test('rejects unbounded image, tag, and credential inputs before network access', async () => {
  const fetchFn = async () => {
    throw new Error('network must not be reached');
  };
  for (const input of [
    { image: '../escape', tag: SHA, username: 'publisher', token: TEST_WORKFLOW_CREDENTIAL },
    { image: 'mlhjyx/global-backend', tag: 'main', username: 'publisher', token: TEST_WORKFLOW_CREDENTIAL },
    { image: 'mlhjyx/global-backend', tag: SHA, username: 'bad\nuser', token: TEST_WORKFLOW_CREDENTIAL },
    { image: 'mlhjyx/global-backend', tag: SHA, username: 'publisher', token: String() },
  ]) {
    await assert.rejects(
      resolveGhcrManifest({ ...input, fetchFn }),
      /GHCR_INPUT_INVALID/,
    );
  }
});
