import {
  EgressBlockedError,
  requestPublicHttp,
  type PublicHttpResponse,
} from '../adapters/guarded-http';
import type { ParsedSanctionsList } from '../adapters/ofac-xml';
import { validateSanctionsXml } from '../durable-results/artifact/materializers/sanctions-download.materializer';
import { PLATFORM_ROBOTS_REDIRECT_MAX } from '../platform-authority/platform-execution-contract';
import {
  DEFAULT_SANCTIONS_UA,
  MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES,
  type SanctionsDownloadInput,
  type SanctionsDownloadOutput,
} from '../tools/source-tools';
import type { ExecutionBroker, ToolContext, ToolResult } from '../tools/tool-contract';
import { sanctionsParserFor } from './sanctions-refresh.service';
import { SANCTIONS_SOURCE_SEEDS } from './sanctions-seed';

/**
 * Operator download of the official sanctions lists (B0, plan 2026-10-10 §2): no platform
 * schedule, no budget receipt. In place of the ToolBroker's held `sanctions-download/v1` call it
 * enforces, per list:
 *  - the source row must name its official endpoint exactly (U.S. Treasury OFAC or EU Financial
 *    Sanctions Files, as seeded) — any other URL, host, scheme, path or format is refused;
 *  - the ToolBroker's own source_policy decision (unregistered / SUSPENDED / purpose fail closed);
 *  - the guarded HTTP adapter: public targets only, every redirect hop re-resolved and pinned,
 *    redirect, size and per-hop deadline caps, an https final hop, XML media type, strict UTF-8,
 *    and the artifact path's XML safety gate.
 * The body goes to SanctionsRefreshService, whose parsers keep entities only; this module keeps
 * counts and hosts, never the body's names or the redirect's signed query string.
 */

export type PublicHttpRequester = typeof requestPublicHttp;

export class SanctionsOperatorRefreshError extends Error {
  constructor(
    readonly code: string,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'SanctionsOperatorRefreshError';
  }
}

export interface OfficialSanctionsEndpoint {
  readonly key: string;
  readonly url: string;
  readonly format: string;
  readonly host: string;
}

/** Government publisher host per source key; a seed pointing anywhere else fails closed. */
const PUBLISHER_HOSTS: ReadonlyMap<string, string> = new Map([
  ['ofac_sdn', 'sanctionslistservice.ofac.treas.gov'],
  ['ofac_consolidated', 'sanctionslistservice.ofac.treas.gov'],
  ['eu_fsf', 'webgate.ec.europa.eu'],
]);

/** The three official endpoints, in key order, as seeded and checked against their publisher. */
export function officialSanctionsEndpoints(): readonly OfficialSanctionsEndpoint[] {
  return SANCTIONS_SOURCE_SEEDS.map((seed) => {
    const url = new URL(seed.url);
    const host = PUBLISHER_HOSTS.get(seed.key);
    if (!host || url.protocol !== 'https:' || url.hostname !== host || url.port || url.username || url.password) {
      throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_SEED_NOT_OFFICIAL', seed.key);
    }
    return Object.freeze({ key: seed.key, url: seed.url, format: seed.format, host });
  }).sort((left, right) => left.key.localeCompare(right.key));
}

/** A source row is admitted only when its key, URL and format are exactly an official endpoint's. */
export function assertOfficialSanctionsSource(row: {
  readonly key: string;
  readonly url: string;
  readonly format: string;
}): OfficialSanctionsEndpoint {
  const endpoint = officialSanctionsEndpoints().find((candidate) => candidate.key === row.key);
  if (!endpoint || row.url !== endpoint.url || row.format !== endpoint.format) {
    throw new SanctionsOperatorRefreshError(
      'SANCTIONS_OPERATOR_SOURCE_NOT_OFFICIAL',
      `${row.key} must download ${endpoint ? `from ${endpoint.host} with format ${endpoint.format}` : 'from a known official list'}`,
    );
  }
  return endpoint;
}

export interface SanctionsListCensus {
  publishDate: string | null;
  /** Published entries of every subject type. */
  entries: number;
  /** Entities the refresh persists. */
  kept: number;
  /** Entity entries without a stable id or name, skipped by the parser. */
  invalidEntities: number;
  subjectTypes: Record<string, number>;
  /** Every non-entity subject type (individuals, vessels, aircraft, persons): counted, never kept. */
  dropped: Record<string, number>;
}

const ENTITY_SUBJECT_TYPE: ReadonlyMap<string, string> = new Map([
  ['ofac_sdn_xml', 'Entity'],
  ['eu_fsf_xml', 'enterprise'],
]);

/** What a parsed list holds: kept entities against every dropped subject type. */
export function censusOfParsedList(format: string, parsed: ParsedSanctionsList): SanctionsListCensus {
  const entityType = ENTITY_SUBJECT_TYPE.get(format);
  if (!entityType) throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_FORMAT_UNSUPPORTED', format);
  const types = Object.entries(parsed.subjectTypes);
  return {
    publishDate: parsed.publishDate,
    entries: types.reduce((sum, [, count]) => sum + count, 0),
    kept: parsed.entities.length,
    invalidEntities: (parsed.subjectTypes[entityType] ?? 0) - parsed.entities.length,
    subjectTypes: { ...parsed.subjectTypes },
    dropped: Object.fromEntries(types.filter(([type]) => type !== entityType)),
  };
}

/** Parse a list with the refresh service's own parser and take its census. */
export function parseSanctionsListForOperator(format: string, xml: string): ParsedSanctionsList {
  const parse = sanctionsParserFor(format);
  if (!parse) throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_FORMAT_UNSUPPORTED', format);
  return parse(xml);
}

export function censusSanctionsList(format: string, xml: string): SanctionsListCensus {
  return censusOfParsedList(format, parseSanctionsListForOperator(format, xml));
}

/** Download facts safe to print: hosts and sizes, never the signed redirect URL or the body. */
export interface SanctionsListDownloadFacts {
  key: string;
  format: string;
  host: string;
  finalHost: string;
  bytes: number;
  contentType: string;
  lastModified: string | null;
  elapsedMs: number;
}

export interface SanctionsListDownload extends SanctionsListDownloadFacts {
  body: string;
}

export interface ServedSanctionsList {
  download: SanctionsListDownloadFacts;
  census: SanctionsListCensus;
}

const XML_MEDIA_TYPES = new Set(['application/xml', 'text/xml']);
const SANCTIONS_PURPOSE = 'sanctions_screening';
const SANCTIONS_TOOL_ID = 'sanctions.download';

export interface OperatorSanctionsDownloadsDeps {
  /** Validated rows selected for this run; nothing else is downloadable. */
  endpoints: readonly OfficialSanctionsEndpoint[];
  /** The ToolBroker's source_policy decision (single point of truth). */
  sourcePolicy: Pick<ExecutionBroker, 'checkSourcePolicy'>;
  /** Per-hop deadline for the guarded adapter's operator ceiling. */
  timeoutMs: number;
  request?: PublicHttpRequester;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Attempts per list and the pause before each retry; only transient transport failures retry.
 * On the dev host the guard's DNS-over-HTTPS answers time out in short bursts, so the last pause
 * is long enough to leave one.
 */
const DOWNLOAD_ATTEMPTS = 4;
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000] as const;
const TRANSIENT_FAILURE = /^SANCTIONS_OPERATOR_DOWNLOAD_(FAILED|BLOCKED: dns_lookup_failed$|HTTP_(429|5\d\d):)/;

function isTransientDownloadFailure(error: unknown): boolean {
  return error instanceof SanctionsOperatorRefreshError && TRANSIENT_FAILURE.test(error.message);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The operator's download port, also handed to SanctionsRefreshService as its broker: it serves
 * `sanctions.download` for a selected official endpoint and nothing else, without a durable
 * receipt, so the service persists through its unreceipted owner transaction.
 */
export class OperatorSanctionsDownloads implements ExecutionBroker {
  private readonly byKey: ReadonlyMap<string, OfficialSanctionsEndpoint>;
  private readonly servedByKey = new Map<string, ServedSanctionsList>();

  constructor(private readonly deps: OperatorSanctionsDownloadsDeps) {
    this.byKey = new Map(deps.endpoints.map((endpoint) => [endpoint.key, endpoint]));
  }

  checkSourcePolicy(
    toolId: string,
    domain: string,
    purpose?: string | string[],
  ): ReturnType<ExecutionBroker['checkSourcePolicy']> {
    return this.deps.sourcePolicy.checkSourcePolicy(toolId, domain, purpose);
  }

  async invoke<I, O>(toolId: string, input: I, _ctx: ToolContext): Promise<ToolResult<O>> {
    if (toolId !== SANCTIONS_TOOL_ID) {
      throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_TOOL_UNSUPPORTED', toolId);
    }
    const { url, userAgent } = input as SanctionsDownloadInput;
    const endpoint = [...this.byKey.values()].find((candidate) => candidate.url === url);
    if (!endpoint) throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_SOURCE_NOT_SELECTED');
    const { body, ...download } = await this.download(endpoint.key, userAgent);
    this.servedByKey.set(endpoint.key, { download, census: censusSanctionsList(endpoint.format, body) });
    const data: SanctionsDownloadOutput = {
      body,
      contentType: download.contentType,
      lastModified: download.lastModified,
    };
    return { data, costCents: 0 } as ToolResult<O>;
  }

  /** What was served to the refresh service for a key, if its download succeeded. */
  served(key: string): ServedSanctionsList | undefined {
    return this.servedByKey.get(key);
  }

  async download(key: string, userAgent?: string): Promise<SanctionsListDownload> {
    const endpoint = this.byKey.get(key);
    if (!endpoint) throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_SOURCE_NOT_SELECTED', key);
    await this.assertSourcePolicy(endpoint);
    const now = this.deps.now ?? Date.now;
    const started = now();
    this.deps.log?.(`${key}: downloading from ${endpoint.host} (deadline ${Math.round(this.deps.timeoutMs / 1000)} s per hop)`);
    for (let attempt = 1; ; attempt += 1) {
      try {
        const download = acceptedDownload(endpoint, await this.fetch(endpoint, userAgent), now() - started);
        this.deps.log?.(
          `${key}: ${download.bytes} bytes via ${download.finalHost} in ${Math.round(download.elapsedMs / 1000)} s`,
        );
        return download;
      } catch (error) {
        if (attempt >= DOWNLOAD_ATTEMPTS || !isTransientDownloadFailure(error)) throw error;
        const delay = RETRY_DELAYS_MS[attempt - 1]!;
        this.deps.log?.(
          `${key}: attempt ${attempt} of ${DOWNLOAD_ATTEMPTS} failed (${(error as Error).message}); retrying in ${delay / 1000} s`,
        );
        await (this.deps.sleep ?? pause)(delay);
      }
    }
  }

  private async assertSourcePolicy(endpoint: OfficialSanctionsEndpoint): Promise<void> {
    const decision = await this.deps.sourcePolicy.checkSourcePolicy(SANCTIONS_TOOL_ID, endpoint.host, SANCTIONS_PURPOSE);
    if (decision.allowed) return;
    const reason = (decision.reason ?? 'policy_unavailable').toUpperCase();
    throw new SanctionsOperatorRefreshError(`SANCTIONS_OPERATOR_SOURCE_POLICY_${reason}`, endpoint.host);
  }

  private async fetch(endpoint: OfficialSanctionsEndpoint, userAgent?: string): Promise<PublicHttpResponse> {
    const request = this.deps.request ?? requestPublicHttp;
    try {
      return await request(endpoint.url, {
        headers: { 'user-agent': userAgent ?? DEFAULT_SANCTIONS_UA },
        operatorTimeoutMs: this.deps.timeoutMs,
        maxBytes: MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES,
        maxRedirects: PLATFORM_ROBOTS_REDIRECT_MAX,
      });
    } catch (error) {
      throw downloadFailure(error);
    }
  }
}

const MAX_FAILURE_DETAIL = 160;

/**
 * One plain error per failed download. The refresh service rethrows any failure it cannot
 * classify as an ordinary one (fail closed), so a socket reset with Node's extra fields would stop
 * every remaining list; normalised, it marks this list FAILED and the run goes on.
 */
function downloadFailure(error: unknown): SanctionsOperatorRefreshError {
  if (error instanceof EgressBlockedError) {
    return error.code === 'response_too_large'
      ? new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_DOWNLOAD_TOO_LARGE', `limit ${MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES} bytes`)
      : new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_DOWNLOAD_BLOCKED', error.code);
  }
  const code = (error as { code?: unknown } | null)?.code;
  const detail = typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
  return new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_DOWNLOAD_FAILED', detail.slice(0, MAX_FAILURE_DETAIL));
}

function acceptedDownload(
  endpoint: OfficialSanctionsEndpoint,
  response: PublicHttpResponse,
  elapsedMs: number,
): SanctionsListDownload {
  if (!response.ok) {
    throw new SanctionsOperatorRefreshError(`SANCTIONS_OPERATOR_DOWNLOAD_HTTP_${response.status}`, endpoint.key);
  }
  const final = new URL(response.finalUrl);
  if (final.protocol !== 'https:') {
    throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_DOWNLOAD_NOT_HTTPS', final.hostname);
  }
  const contentType = (response.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (!XML_MEDIA_TYPES.has(contentType)) {
    throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_DOWNLOAD_MEDIA_TYPE_INVALID', contentType || 'missing');
  }
  let body: string;
  try {
    body = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
  } catch {
    throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_DOWNLOAD_UTF8_INVALID', endpoint.key);
  }
  try {
    validateSanctionsXml(body);
  } catch {
    throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_DOWNLOAD_XML_INVALID', endpoint.key);
  }
  return {
    key: endpoint.key,
    format: endpoint.format,
    host: endpoint.host,
    finalHost: final.hostname,
    bytes: response.body.length,
    contentType,
    lastModified: response.headers['last-modified'] ?? null,
    elapsedMs,
    body,
  };
}
