import { PLATFORM_JSON_TRANSPORT_RESPONSE_MAX_BYTES } from '../platform-authority/platform-execution-contract';
import { decodeJsonBytes } from './bounded-fetch-response';
import { requestPublicHttp, type PublicHttpRequestOptions, type PublicUrlResolver } from './guarded-http';

export type DiscoverySourceDispatch = <T>(send: (signal: AbortSignal) => Promise<T>) => Promise<T>;

/** Resolve and vet before the fence, then perform one pinned, bounded request with no redirects. */
export async function requestDiscoverySourceJson<T extends object>(
  url: string | URL,
  request: Pick<PublicHttpRequestOptions, 'method' | 'headers' | 'body'> & {
    timeoutMs: number;
    source: string;
    notFound?: T;
  },
  dispatch: DiscoverySourceDispatch,
  resolver?: PublicUrlResolver,
): Promise<T> {
  const { source, notFound, ...options } = request;
  const response = await requestPublicHttp(url.toString(), {
    ...options,
    maxBytes: PLATFORM_JSON_TRANSPORT_RESPONSE_MAX_BYTES,
    maxRedirects: 0,
  }, { dispatchPhysicalWire: dispatch, resolver });
  if (response.status === 404 && notFound !== undefined) return notFound;
  if (!response.ok) throw new Error(`${source} HTTP ${response.status}`);
  const invalidCode = `${source}_NATIVE_RESPONSE_INVALID`;
  const json = decodeJsonBytes<unknown>(response.body, invalidCode);
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(invalidCode);
  return json as T;
}
