import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_MANIFEST_BYTES = 1024 * 1024;
const CLASSIC_CONFIG = /^([0-9a-f]{64})\.json$/;
const OCI_CONFIG = /^blobs\/sha256\/([0-9a-f]{64})$/;

export function parseDockerImageConfigPath(contents) {
  const bytes = Buffer.isBuffer(contents)
    ? contents
    : Buffer.from(contents instanceof Uint8Array ? contents : String(contents));
  if (bytes.length < 2 || bytes.length > MAX_MANIFEST_BYTES) {
    throw new Error('DOCKER_IMAGE_SAVE_MANIFEST_INVALID');
  }
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('DOCKER_IMAGE_SAVE_MANIFEST_INVALID');
  }
  if (!Array.isArray(manifest) || manifest.length !== 1) {
    throw new Error('DOCKER_IMAGE_CONFIG_PATH_INVALID');
  }
  const path = manifest[0]?.Config;
  if (typeof path !== 'string') {
    throw new Error('DOCKER_IMAGE_CONFIG_PATH_INVALID');
  }
  const match = path.match(CLASSIC_CONFIG) ?? path.match(OCI_CONFIG);
  if (!match) throw new Error('DOCKER_IMAGE_CONFIG_PATH_INVALID');
  return Object.freeze({ path, digest: `sha256:${match[1]}` });
}

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_MANIFEST_BYTES) {
      throw new Error('DOCKER_IMAGE_SAVE_MANIFEST_INVALID');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function main() {
  const result = parseDockerImageConfigPath(await readStdin());
  process.stdout.write(result.path);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main();
}
