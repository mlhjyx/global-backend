import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const IMAGE_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const USERNAME_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const SINGLE_MANIFEST_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const MANIFEST_ACCEPT = [...SINGLE_MANIFEST_MEDIA_TYPES].join(', ');

function inputError() {
  return new Error('GHCR_INPUT_INVALID');
}

function validateInputs({ image, tag, username, token }) {
  if (
    typeof image !== 'string' ||
    image.length > 200 ||
    !IMAGE_PATTERN.test(image) ||
    typeof tag !== 'string' ||
    !SHA_PATTERN.test(tag) ||
    typeof username !== 'string' ||
    !USERNAME_PATTERN.test(username) ||
    typeof token !== 'string' ||
    token.length < 1 ||
    token.length > 4096 ||
    /[\0\r\n]/.test(token)
  ) {
    throw inputError();
  }
}

async function readBoundedText(response) {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_TOKEN_RESPONSE_BYTES) {
    throw new Error('GHCR_TOKEN_RESPONSE_INVALID');
  }
  if (!response.body) throw new Error('GHCR_TOKEN_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_TOKEN_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error('GHCR_TOKEN_RESPONSE_INVALID');
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function requestSignal() {
  return AbortSignal.timeout(10_000);
}

export async function resolveGhcrManifest({
  image,
  tag,
  username,
  token,
  fetchFn = fetch,
}) {
  validateInputs({ image, tag, username, token });
  const tokenUrl = new URL('https://ghcr.io/token');
  tokenUrl.searchParams.set('service', 'ghcr.io');
  tokenUrl.searchParams.set('scope', `repository:${image}:pull`);
  const basic = Buffer.from(`${username}:${token}`).toString('base64');
  let tokenResponse;
  try {
    tokenResponse = await fetchFn(tokenUrl, {
      method: 'GET',
      redirect: 'error',
      signal: requestSignal(),
      headers: { authorization: `Basic ${basic}` },
    });
  } catch {
    throw new Error('GHCR_TOKEN_UNAVAILABLE');
  }
  if (tokenResponse.status !== 200) {
    throw new Error('GHCR_TOKEN_UNAVAILABLE');
  }
  let registryToken;
  try {
    const payload = JSON.parse(await readBoundedText(tokenResponse));
    registryToken = payload.token ?? payload.access_token;
  } catch {
    throw new Error('GHCR_TOKEN_RESPONSE_INVALID');
  }
  if (
    typeof registryToken !== 'string' ||
    registryToken.length < 1 ||
    registryToken.length > 16_384 ||
    /[\0\r\n]/.test(registryToken)
  ) {
    throw new Error('GHCR_TOKEN_RESPONSE_INVALID');
  }

  let manifestResponse;
  try {
    manifestResponse = await fetchFn(
      `https://ghcr.io/v2/${image}/manifests/${tag}`,
      {
        method: 'HEAD',
        redirect: 'error',
        signal: requestSignal(),
        headers: {
          accept: MANIFEST_ACCEPT,
          authorization: `Bearer ${registryToken}`,
        },
      },
    );
  } catch {
    throw new Error('GHCR_MANIFEST_UNAVAILABLE');
  }
  if (manifestResponse.status === 404) {
    return Object.freeze({ status: 'NOT_FOUND' });
  }
  if (manifestResponse.status !== 200) {
    throw new Error('GHCR_MANIFEST_UNAVAILABLE');
  }
  const mediaType = (manifestResponse.headers.get('content-type') ?? '')
    .split(';', 1)[0]
    .trim()
    .toLowerCase();
  if (!SINGLE_MANIFEST_MEDIA_TYPES.has(mediaType)) {
    throw new Error('GHCR_MANIFEST_MEDIA_TYPE_INVALID');
  }
  const digest = manifestResponse.headers.get('docker-content-digest');
  if (!digest || !DIGEST_PATTERN.test(digest)) {
    throw new Error('GHCR_MANIFEST_DIGEST_INVALID');
  }
  return Object.freeze({ status: 'FOUND', digest });
}

function parseCli(argv) {
  if (argv[0] !== 'resolve') throw inputError();
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || values.has(key)) {
      throw inputError();
    }
    values.set(key, value);
  }
  const image = values.get('--image');
  const tag = values.get('--tag');
  const githubOutput = values.get('--github-output');
  const waitMsText = values.get('--wait-ms') ?? '0';
  if (
    !image ||
    !tag ||
    !githubOutput ||
    /[\0\r\n]/.test(githubOutput) ||
    !/^\d+$/.test(waitMsText)
  ) {
    throw inputError();
  }
  const waitMs = Number(waitMsText);
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
    throw inputError();
  }
  return { image, tag, githubOutput, waitMs };
}

async function resolveWithWait(options, waitMs) {
  const deadline = Date.now() + waitMs;
  while (true) {
    const result = await resolveGhcrManifest(options);
    if (result.status === 'FOUND' || Date.now() >= deadline) return result;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main() {
  const { image, tag, githubOutput, waitMs } = parseCli(process.argv.slice(2));
  const result = await resolveWithWait(
    {
      image,
      tag,
      username: process.env.GHCR_USERNAME,
      token: process.env.GHCR_TOKEN,
    },
    waitMs,
  );
  if (result.status === 'NOT_FOUND') {
    await appendFile(githubOutput, 'exists=false\n', { encoding: 'utf8' });
    console.log(JSON.stringify({ status: result.status }));
    return;
  }
  const imageReference = `ghcr.io/${image}@${result.digest}`;
  await appendFile(
    githubOutput,
    `exists=true\nimage_digest=${result.digest}\nimage_reference=${imageReference}\n`,
    { encoding: 'utf8' },
  );
  console.log(
    JSON.stringify({
      status: result.status,
      digest: result.digest,
      image_reference: imageReference,
    }),
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
