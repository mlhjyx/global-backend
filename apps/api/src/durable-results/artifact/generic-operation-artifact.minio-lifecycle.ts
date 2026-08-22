import { createHash, createHmac } from 'node:crypto';

export type MinioLifecycleVerifierConfig = Readonly<{
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}>;

type LifecycleFetch = (
  input: string,
  init: RequestInit,
) => Promise<Pick<Response, 'body' | 'headers' | 'ok'>>;

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');
const MAX_LIFECYCLE_XML_BYTES = 64 * 1024;
const REQUIRED_ALL_VERSION_RULE_IDS = Object.freeze([
  'generic-operation-artifact-staging-ttl',
  'generic-operation-artifact-public-organization-ttl',
  'generic-operation-artifact-confidential-tenant-ttl',
  'generic-operation-artifact-personal-data-ttl',
]);

function hmac(key: string | Uint8Array, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest();
}

function requestUrl(config: MinioLifecycleVerifierConfig): URL {
  const endpoint = new URL(config.endpoint);
  if (config.forcePathStyle) {
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/u, '')}/${encodeURIComponent(config.bucket)}`;
  } else {
    endpoint.hostname = `${config.bucket}.${endpoint.hostname}`;
  }
  endpoint.search = '?lifecycle=';
  return endpoint;
}

function authorization(
  config: MinioLifecycleVerifierConfig,
  url: URL,
  now: Date,
): Readonly<Record<string, string>> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/gu, '');
  const date = amzDate.slice(0, 8);
  const canonicalHeaders =
    `host:${url.host}\n` +
    `x-amz-content-sha256:${EMPTY_SHA256}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    'GET',
    url.pathname,
    'lifecycle=',
    canonicalHeaders,
    signedHeaders,
    EMPTY_SHA256,
  ].join('\n');
  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const dateKey = hmac(`AWS4${config.secretAccessKey}`, date);
  const regionKey = hmac(dateKey, config.region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = createHmac('sha256', signingKey)
    .update(stringToSign)
    .digest('hex');
  return Object.freeze({
    Authorization:
      `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': amzDate,
  });
}

async function boundedXml(response: Pick<Response, 'body'>): Promise<string> {
  if (!response.body) throw new Error('LIFECYCLE_BODY_UNAVAILABLE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAX_LIFECYCLE_XML_BYTES) {
        throw new Error('LIFECYCLE_BODY_TOO_LARGE');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

export function hasRequiredMinioAllVersionExpiry(xml: string): boolean {
  if (
    !xml ||
    xml.length > MAX_LIFECYCLE_XML_BYTES ||
    /<!DOCTYPE|<!ENTITY/iu.test(xml)
  ) {
    return false;
  }
  const rules = [...xml.matchAll(/<Rule>([\s\S]*?)<\/Rule>/gu)].map(
    (match) => match[1] ?? '',
  );
  if (rules.length !== 7) return false;
  return REQUIRED_ALL_VERSION_RULE_IDS.every((id) => {
    const matches = rules.filter((rule) => rule.includes(`<ID>${id}</ID>`));
    return (
      matches.length === 1 &&
      /<ExpiredObjectAllVersions>\s*true\s*<\/ExpiredObjectAllVersions>/u.test(
        matches[0]!,
      )
    );
  });
}

export async function checkMinioAllVersionLifecycle(
  config: MinioLifecycleVerifierConfig,
  fetcher: LifecycleFetch = fetch,
  now: Date = new Date(),
): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_500);
  timeout.unref();
  try {
    const url = requestUrl(config);
    const response = await fetcher(url.href, {
      method: 'GET',
      headers: authorization(config, url, now),
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const contentType = response.headers.get('content-type')?.toLowerCase();
    if (!contentType?.includes('xml')) return false;
    return hasRequiredMinioAllVersionExpiry(await boundedXml(response));
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
