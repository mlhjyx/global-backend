import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDockerImageConfigPath } from './docker-image-config-path.mjs';

const HEX = 'a'.repeat(64);

test('accepts the bounded classic Docker save config path', () => {
  assert.deepEqual(
    parseDockerImageConfigPath(
      JSON.stringify([{ Config: `${HEX}.json`, RepoTags: null, Layers: [] }]),
    ),
    { path: `${HEX}.json`, digest: `sha256:${HEX}` },
  );
});

test('accepts the bounded OCI/containerd Docker save config blob path', () => {
  assert.deepEqual(
    parseDockerImageConfigPath(
      JSON.stringify([
        { Config: `blobs/sha256/${HEX}`, RepoTags: null, Layers: [] },
      ]),
    ),
    { path: `blobs/sha256/${HEX}`, digest: `sha256:${HEX}` },
  );
});

test('rejects multiple manifests, traversal, alternate algorithms, and malformed digests', () => {
  for (const value of [
    [],
    [{ Config: `${HEX}.json` }, { Config: `${'b'.repeat(64)}.json` }],
    [{ Config: `../${HEX}.json` }],
    [{ Config: `blobs/sha512/${HEX}` }],
    [{ Config: `blobs/sha256/${HEX}.json` }],
    [{ Config: `${HEX.toUpperCase()}.json` }],
    [{ Config: 'config.json' }],
  ]) {
    assert.throws(
      () => parseDockerImageConfigPath(JSON.stringify(value)),
      /DOCKER_IMAGE_CONFIG_PATH_INVALID/,
    );
  }
});

test('rejects an oversized or invalid Docker save manifest before parsing a path', () => {
  assert.throws(
    () => parseDockerImageConfigPath(' '.repeat(1024 * 1024 + 1)),
    /DOCKER_IMAGE_SAVE_MANIFEST_INVALID/,
  );
  assert.throws(
    () => parseDockerImageConfigPath('{not-json'),
    /DOCKER_IMAGE_SAVE_MANIFEST_INVALID/,
  );
});
