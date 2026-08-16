import { createHash } from 'node:crypto';
import { isValidCnpjIdentifier } from '../discovery/organization-identity-v2';
import { requestPublicHttp } from './guarded-http';

/**
 * Keyless official procurement wire clients.
 *
 * These functions are intentionally business-light: they make bounded HTTP
 * reads, validate the minimum public organization/procurement shape and return
 * a hash of the exact response body. ToolBroker policy/rate/trace belongs to
 * the Tool wrapper; company identity and scoring belong to later layers.
 */

export type BeforeRequest = () => Promise<void>;

export interface ProcurementProvenance {
  sourceUrl: string;
  fetchedAt: string;
  contentHash: string;
  parserVersion: string;
}

export interface ProcurementPage<T> {
  records: T[];
  nextCursor?: string;
  total?: number;
  provenance: ProcurementProvenance;
}

export interface WorldBankNotice {
  id: string;
  organizationName: string;
  organizationRole: 'procurement_buyer_or_implementing_agency';
  signalStage: 'published_notice';
  /** Organization country asserted by the contact block; safe for weak identity. */
  country?: string;
  /** Project geography is procurement evidence only and must never become organization identity. */
  projectCountry?: string;
  projectId?: string;
  projectName?: string;
  title: string;
  method?: string;
  deadline?: string;
}

export interface UkProcurementOrganization {
  externalId: string;
  ocid: string;
  releaseId: string;
  organizationName: string;
  organizationRole: 'buyer' | 'supplier';
  signalStage: 'planning_or_tender' | 'awarded';
  /** Source-local party identifier. It is evidence only, never a strong organization identifier. */
  sourcePartyId?: string;
  country?: string;
  /** UK constituent inferred only from this party's structured address evidence. */
  region?: 'England' | 'Scotland' | 'Wales' | 'Northern Ireland';
  /** Source-declared URL. It is evidence only, never an identity domain without later verification. */
  declaredUrl?: string;
  title: string;
  description?: string;
  status?: string;
  date?: string;
  noticeUrl?: string;
  deadline?: string;
  estimatedValue?: number;
  currency?: string;
  classificationIds?: string[];
}

export type UkOcdsStage = 'planning' | 'tender' | 'award';

export interface BrazilPncpNotice {
  controlNumber: string;
  organizationName: string;
  organizationRole: 'buyer';
  signalStage: 'open_for_proposals';
  /** Official CNPJ admitted only after checksum validation and exact control-prefix agreement. */
  buyerCnpjClaim?: string;
  title: string;
  method?: string;
  deadline?: string;
  estimatedValue?: number;
  noticeUrl?: string;
  unitMunicipality?: string;
  unitState?: string;
  unitIbgeCode?: string;
}

export interface SingaporeGebizAward {
  externalId: string;
  tenderNumber: string;
  organizationName: string;
  organizationRole: 'supplier';
  signalStage: 'awarded_historical';
  title: string;
  buyerAgency: string;
  awardDate?: string;
  status?: string;
  amount?: number;
}

/**
 * One federal contract award returned by the official USAspending API.
 * Awarding agency and recipient are deliberately kept separate: the former is
 * the buyer, while the latter is a historical awarded supplier.
 */
export interface UsaSpendingAward {
  awardId: string;
  generatedInternalId?: string;
  recipientName: string;
  awardingAgency: string;
  awardingSubAgency?: string;
  amount?: number;
  description?: string;
  startDate?: string;
  endDate?: string;
}

export type ContractsFinderOrganization = UkProcurementOrganization;

const WORLD_BANK_URL = 'https://search.worldbank.org/api/v2/procnotices';
const UK_FTS_URL = 'https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages';
const PNCP_URL = 'https://pncp.gov.br/api/consulta/v1/contratacoes/proposta';
const GEBIZ_URL = 'https://data.gov.sg/api/action/datastore_search';
const CONTRACTS_FINDER_URL = 'https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search';
const USASPENDING_URL = 'https://api.usaspending.gov/api/v2/search/spending_by_award/';
export const GEBIZ_DATASET_ID = 'd_acde1106003906a75c3fa052592f2fcb';

const REDIRECT_LIMIT = 3;
const DEFAULT_TIMEOUT_MS = 20_000;
const TRANSIENT_RETRY_LIMIT = 2;
const TRANSIENT_RETRY_BASE_MS = 1_000;
// Discovery activities have a two-minute start-to-close window. Respect small
// Retry-After values but cap hostile/accidental large values so three bounded
// attempts cannot pin one activity indefinitely.
const TRANSIENT_RETRY_DELAY_CAP_MS = 10_000;

type JsonObject = Record<string, unknown>;

interface BoundedJsonResponse {
  payload: JsonObject;
  status: number;
  provenance: ProcurementProvenance;
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizedComparisonText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replaceAll(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function containsContactLikeText(value: string): boolean {
  return /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(value)
    || /https?:\/\//iu.test(value)
    || /(?:^|\s)\+?\d[\d\s().-]{6,}\d(?:\s|$)/u.test(value);
}

function worldBankOrganizationName(value: unknown, projectName: string | undefined): string | undefined {
  const organization = boundedText(value, 300);
  if (
    !organization
    || containsContactLikeText(organization)
    || /^(?:unknown|n\/?a|none|null|-+)$/iu.test(organization)
  ) return undefined;
  if (projectName && normalizedComparisonText(organization) === normalizedComparisonText(projectName)) return undefined;
  return organization;
}

function worldBankPublicText(value: unknown, maximum: number): string | undefined {
  const candidate = boundedText(value, maximum);
  return candidate && !containsContactLikeText(candidate) ? candidate : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizedPositiveInteger(value: number | undefined, fallback: number, maximum: number, minimum = 1): number {
  const integer = Number.isFinite(value) ? Math.trunc(value!) : fallback;
  return Math.min(Math.max(integer, minimum), maximum);
}

function assertDateTime(value: string, field: string): string {
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|[+-]\d{2}:\d{2})?$/u.exec(normalized);
  const offset = match?.[7];
  const offsetParts = offset && offset !== 'Z' ? /^([+-])(\d{2}):(\d{2})$/u.exec(offset) : null;
  const validOffset = !offsetParts || (Number(offsetParts[2]) <= 23 && Number(offsetParts[3]) <= 59);
  if (!match || !isValidUtcDateTime(match) || !validOffset || Number.isNaN(Date.parse(normalized))) {
    throw new Error(`${field} must be an ISO date-time without fractional seconds`);
  }
  return normalized;
}

function assertCompactDate(value: string): string {
  const normalized = value.trim();
  const match = /^(\d{4})(\d{2})(\d{2})$/u.exec(normalized);
  if (!match) throw new Error('dateFinal must be YYYYMMDD');
  if (!isValidUtcDateTime([match[0], match[1], match[2], match[3], '00', '00', '00'])) {
    throw new Error('dateFinal must be a valid calendar date');
  }
  return normalized;
}

function assertIsoDate(value: string, field: string): string {
  const normalized = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(normalized);
  if (!match || !isValidUtcDateTime([match[0], match[1], match[2], match[3], '00', '00', '00'])) {
    throw new Error(`${field} must be a valid YYYY-MM-DD date`);
  }
  return normalized;
}

function isValidUtcDateTime(match: RegExpExecArray | string[]): boolean {
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const values = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const [year, month, day, hour, minute, second] = values;
  if (values.some((value) => !Number.isInteger(value))) return false;
  const date = new Date(Date.UTC(year!, month! - 1, day!, hour!, minute!, second!));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month! - 1
    && date.getUTCDate() === day
    && date.getUTCHours() === hour
    && date.getUTCMinutes() === minute
    && date.getUTCSeconds() === second;
}

function safeCursor(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > 300 || !/^[A-Za-z0-9=_-]+$/u.test(normalized)) {
    throw new Error('procurement cursor is invalid');
  }
  return normalized;
}

function readOcdsCursor(
  value: string | undefined,
  lowerBoundField: 'updatedFrom' | 'publishedFrom',
  upperBoundField: 'updatedTo' | 'publishedTo',
): { cursor: string; lowerBound: string; upperBound: string } | null {
  if (!value) return null;
  try {
    const parsed = object(JSON.parse(value));
    const cursor = parsed && safeCursor(text(parsed.cursor));
    const lowerBound = parsed && text(parsed[lowerBoundField]);
    const upperBound = parsed && text(parsed[upperBoundField]);
    if (!cursor || !lowerBound || !upperBound) throw new Error('missing cursor snapshot fields');
    return {
      cursor,
      lowerBound: assertDateTime(lowerBound, lowerBoundField),
      upperBound: assertDateTime(upperBound, upperBoundField),
    };
  } catch (error) {
    throw new Error('UK OCDS cursor must be the opaque cursor returned by the previous page', { cause: error });
  }
}

function pathMatchesAllowedPrefix(pathname: string, prefix: string): boolean {
  const normalizedPrefix = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return pathname === normalizedPrefix || pathname.startsWith(`${normalizedPrefix}/`);
}

async function fetchBoundedJson(input: {
  url: URL;
  init?: RequestInit;
  allowedHosts: readonly string[];
  allowedPathPrefixes: readonly string[];
  timeoutMs?: number;
  maximumBytes: number;
  parserVersion: string;
  beforeRequest?: BeforeRequest;
}): Promise<BoundedJsonResponse> {
  const rawMethod = input.init?.method?.toUpperCase() ?? 'GET';
  if (rawMethod !== 'GET' && rawMethod !== 'HEAD' && rawMethod !== 'POST') {
    throw new Error(`unsupported public procurement method: ${rawMethod}`);
  }
  const method: 'GET' | 'HEAD' | 'POST' = rawMethod;
  const requestBody = input.init?.body;
  if (requestBody != null && typeof requestBody !== 'string' && !Buffer.isBuffer(requestBody)) {
    throw new Error('public procurement request body must be text');
  }
  const initialRequestBody: string | Buffer | undefined = requestBody ?? undefined;
  const normalizedHeaders = new Headers(input.init?.headers);
  if (!normalizedHeaders.has('accept')) normalizedHeaders.set('accept', 'application/json');
  const headers = Object.fromEntries(normalizedHeaders.entries());
  let lastTransientError: unknown;
  for (let attempt = 0; attempt <= TRANSIENT_RETRY_LIMIT; attempt += 1) {
    let current = new URL(input.url);
    let currentMethod = method;
    let currentBody = initialRequestBody;
    let currentHeaders = headers;
    try {
      for (let redirect = 0; redirect <= REDIRECT_LIMIT; redirect += 1) {
        if (
          current.protocol !== 'https:' ||
          Boolean(current.username || current.password) ||
          Boolean(current.port && current.port !== '443') ||
          !input.allowedHosts.includes(current.hostname) ||
          !input.allowedPathPrefixes.some((prefix) => pathMatchesAllowedPrefix(current.pathname, prefix))
        ) {
          throw new Error(`public procurement redirect target is not allowed: ${current.hostname}${current.pathname}`);
        }
        const response = await requestPublicHttp(
          current.toString(),
          {
            method: currentMethod,
            headers: currentHeaders,
            body: currentBody,
            redirect: 'manual',
            maxRedirects: 0,
            timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            maxBytes: input.maximumBytes,
          },
          { beforeRequest: input.beforeRequest },
        );
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.location;
          if (!location || redirect === REDIRECT_LIMIT) throw new Error('public procurement redirect limit exceeded');
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && currentMethod === 'POST')) {
            currentMethod = 'GET';
            currentBody = undefined;
            currentHeaders = Object.fromEntries(
              Object.entries(currentHeaders).filter(
                ([name]) => !['content-length', 'content-type'].includes(name.toLowerCase()),
              ),
            );
          }
          current = new URL(location, current);
          continue;
        }
        if (isTransientProcurementStatus(response.status) && attempt < TRANSIENT_RETRY_LIMIT) {
          const delayMs = retryDelayMs(response.headers['retry-after'] ?? null, attempt);
          await sleep(delayMs);
          break;
        }
        const rawBody = response.body;
        let body: string;
        try {
          body = new TextDecoder('utf-8', { fatal: true }).decode(rawBody);
        } catch (error) {
          throw new Error(`public procurement API returned invalid UTF-8 for ${current.hostname}`, { cause: error });
        }
        if (!response.ok && response.status !== 204) {
          const retryAfter = response.headers['retry-after'];
          throw new Error(
            `public procurement API HTTP ${response.status} for ${current.hostname}${retryAfter ? `; retry-after=${retryAfter}` : ''}`,
          );
        }
        let payload: JsonObject = {};
        if (body.trim()) {
          try {
            const parsed = object(JSON.parse(body));
            if (!parsed) throw new Error('root must be an object');
            payload = parsed;
          } catch (error) {
            throw new Error(`public procurement API returned invalid JSON for ${current.hostname}`, { cause: error });
          }
        }
        return {
          payload,
          status: response.status,
          provenance: {
            sourceUrl: current.toString(),
            fetchedAt: new Date().toISOString(),
            contentHash: createHash('sha256').update(rawBody).digest('hex'),
            parserVersion: input.parserVersion,
          },
        };
      }
    } catch (error) {
      if (!isTransientNetworkError(error) || attempt === TRANSIENT_RETRY_LIMIT) throw error;
      lastTransientError = error;
      await sleep(retryDelayMs(null, attempt));
    }
  }
  throw lastTransientError ?? new Error('public procurement transient retry exhausted');
}

function isTransientProcurementStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof TypeError || (error instanceof Error && error.name === 'AbortError')) return true;
  if (!(error instanceof Error)) return false;
  if (error.message === 'public_http_timeout') return true;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === 'string' && ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code);
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  let requestedMs = Number.NaN;
  if (retryAfter?.trim()) {
    const seconds = Number(retryAfter);
    requestedMs = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(retryAfter) - Date.now();
  }
  const fallback = TRANSIENT_RETRY_BASE_MS * 2 ** attempt;
  const positive = Number.isFinite(requestedMs) && requestedMs > 0 ? requestedMs : fallback;
  return Math.min(positive, TRANSIENT_RETRY_DELAY_CAP_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function searchWorldBankProcurement(
  input: { keywords: string[]; country?: string; offset?: number; limit?: number },
  beforeRequest?: BeforeRequest,
): Promise<ProcurementPage<WorldBankNotice>> {
  const limit = normalizedPositiveInteger(input.limit, 25, 100);
  const offset = normalizedPositiveInteger(input.offset, 0, 10_000, 0);
  const terms = [...input.keywords, input.country].map((item) => item?.trim()).filter(Boolean) as string[];
  if (!terms.length) throw new Error('World Bank procurement requires keywords or country');
  const url = new URL(WORLD_BANK_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('rows', String(limit));
  url.searchParams.set('os', String(offset));
  url.searchParams.set('qterm', terms.join(' '));
  const wire = await fetchBoundedJson({
    url,
    allowedHosts: ['search.worldbank.org'],
    allowedPathPrefixes: ['/api/v2/procnotices'],
    maximumBytes: 8 * 1024 * 1024,
    parserVersion: 'world-bank-procurement/v1',
    beforeRequest,
  });
  if (!Array.isArray(wire.payload.procnotices)) throw new Error('World Bank procurement schema changed: procnotices');
  const records = wire.payload.procnotices.flatMap((raw): WorldBankNotice[] => {
    const item = object(raw);
    const id = item && text(item.id);
    // contact_organization is the only organization assertion in this API. Project name is never promoted to a company.
    const projectName = item ? worldBankPublicText(item.project_name, 300) : undefined;
    const organizationName = item ? worldBankOrganizationName(item.contact_organization, projectName) : undefined;
    // bid_description is free text and may embed named contacts. If it carries
    // contact-shaped data, retain only the separately declared project title.
    const title = item ? (worldBankPublicText(item.bid_description, 512) ?? projectName) : undefined;
    if (!item || !id || !organizationName || !title) return [];
    return [{
      id,
      organizationName,
      organizationRole: 'procurement_buyer_or_implementing_agency',
      signalStage: 'published_notice',
      country: boundedText(item.contact_ctry_name, 100),
      projectCountry: boundedText(item.project_ctry_name, 100),
      projectId: boundedText(item.project_id, 100),
      projectName,
      title,
      method: worldBankPublicText(item.procurement_method_name, 100),
      deadline: text(item.submission_deadline_date),
    }];
  });
  const total = finiteNumber(wire.payload.total) ?? records.length;
  const next = offset + array(wire.payload.procnotices).length;
  return {
    records,
    total,
    nextCursor: next < total && array(wire.payload.procnotices).length ? String(next) : undefined,
    provenance: wire.provenance,
  };
}

export async function searchUsaSpendingAwards(
  input: {
    keywords: string[];
    startDate: string;
    endDate: string;
    page?: number;
    limit?: number;
  },
  beforeRequest?: BeforeRequest,
): Promise<ProcurementPage<UsaSpendingAward>> {
  const keywords = [...new Set(input.keywords.map((item) => item.trim()).filter(Boolean))].slice(0, 8);
  if (!keywords.length) throw new Error('USAspending requires procurement keywords');
  const startDate = assertIsoDate(input.startDate, 'startDate');
  const endDate = assertIsoDate(input.endDate, 'endDate');
  if (startDate > endDate) throw new Error('USAspending startDate must not be after endDate');
  const page = normalizedPositiveInteger(input.page, 1, 100);
  const limit = normalizedPositiveInteger(input.limit, 20, 100);
  const wire = await fetchBoundedJson({
    url: new URL(USASPENDING_URL),
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        filters: {
          time_period: [{ start_date: startDate, end_date: endDate }],
          award_type_codes: ['A', 'B', 'C', 'D'],
          keywords,
        },
        fields: [
          'Award ID',
          'Recipient Name',
          'Award Amount',
          'Description',
          'Start Date',
          'End Date',
          'Awarding Agency',
          'Awarding Sub Agency',
        ],
        page,
        limit,
        subawards: false,
      }),
    },
    allowedHosts: ['api.usaspending.gov'],
    allowedPathPrefixes: ['/api/v2/search/spending_by_award'],
    maximumBytes: 6 * 1024 * 1024,
    parserVersion: 'usaspending-awards/v1',
    beforeRequest,
  });
  const metadata = object(wire.payload.page_metadata);
  if (!metadata || !Array.isArray(wire.payload.results)) {
    throw new Error('USAspending schema changed: page_metadata/results');
  }
  const responsePage = finiteNumber(metadata.page);
  const hasNext = metadata.hasNext;
  if (!Number.isInteger(responsePage) || responsePage !== page || typeof hasNext !== 'boolean') {
    throw new Error('USAspending schema changed: page_metadata.page/hasNext');
  }
  const records = wire.payload.results.flatMap((raw): UsaSpendingAward[] => {
    const item = object(raw);
    const awardId = item && text(item['Award ID']);
    const recipientName = item && text(item['Recipient Name']);
    const awardingAgency = item && text(item['Awarding Agency']);
    // Both organizations are required so downstream can never guess which side bought and which side supplied.
    if (!item || !awardId || !recipientName || !awardingAgency) return [];
    return [{
      awardId,
      generatedInternalId: text(item.generated_internal_id),
      recipientName,
      awardingAgency,
      awardingSubAgency: text(item['Awarding Sub Agency']),
      amount: finiteNumber(item['Award Amount']),
      description: text(item.Description),
      startDate: text(item['Start Date']),
      endDate: text(item['End Date']),
    }];
  });
  return {
    records,
    nextCursor: hasNext && page < 100 ? String(page + 1) : undefined,
    provenance: wire.provenance,
  };
}

export async function searchUkFindATender(
  input: { updatedFrom: string; updatedTo?: string; cursor?: string; limit?: number; stage: UkOcdsStage },
  beforeRequest?: BeforeRequest,
): Promise<ProcurementPage<UkProcurementOrganization>> {
  const url = new URL(UK_FTS_URL);
  url.searchParams.set('limit', String(normalizedPositiveInteger(input.limit, 100, 100)));
  url.searchParams.set('stages', assertUkOcdsStage(input.stage));
  const savedCursor = readOcdsCursor(input.cursor, 'updatedFrom', 'updatedTo');
  if (savedCursor) {
    url.searchParams.set('updatedFrom', savedCursor.lowerBound);
    url.searchParams.set('updatedTo', savedCursor.upperBound);
    url.searchParams.set('cursor', savedCursor.cursor);
  } else {
    url.searchParams.set('updatedFrom', assertDateTime(input.updatedFrom, 'updatedFrom'));
    if (input.updatedTo) url.searchParams.set('updatedTo', assertDateTime(input.updatedTo, 'updatedTo'));
  }
  const wire = await fetchBoundedJson({
    url,
    allowedHosts: ['www.find-tender.service.gov.uk'],
    allowedPathPrefixes: ['/api/1.0/ocdsReleasePackages'],
    timeoutMs: 30_000,
    maximumBytes: 8 * 1024 * 1024,
    parserVersion: 'uk-find-a-tender-ocds/v4',
    beforeRequest,
  });
  return mapUkOcdsPage(
    wire,
    'www.find-tender.service.gov.uk',
    '/api/1.0/ocdsReleasePackages',
    'updatedFrom',
    'updatedTo',
  );
}

function assertUkOcdsStage(value: unknown): UkOcdsStage {
  if (value === 'planning' || value === 'tender' || value === 'award') return value;
  throw new Error('Find a Tender stage must be planning, tender, or award');
}

export async function searchBrazilPncp(
  input: { dateFinal: string; page?: number; pageSize?: number; uf?: string },
  beforeRequest?: BeforeRequest,
): Promise<ProcurementPage<BrazilPncpNotice>> {
  const page = normalizedPositiveInteger(input.page, 1, 200);
  const url = new URL(PNCP_URL);
  url.searchParams.set('dataFinal', assertCompactDate(input.dateFinal));
  url.searchParams.set('pagina', String(page));
  // The live official contract rejects values below 10.
  url.searchParams.set('tamanhoPagina', String(normalizedPositiveInteger(input.pageSize, 50, 50, 10)));
  if (input.uf) {
    const uf = input.uf.normalize('NFKC').trim().toLocaleUpperCase('pt-BR');
    if (!/^[A-Z]{2}$/u.test(uf)) throw new Error('PNCP uf must be a two-letter state code');
    url.searchParams.set('uf', uf);
  }
  const wire = await fetchBoundedJson({
    url,
    allowedHosts: ['pncp.gov.br'],
    allowedPathPrefixes: ['/api/consulta/v1/contratacoes/proposta'],
    timeoutMs: 25_000,
    maximumBytes: 8 * 1024 * 1024,
    parserVersion: 'brazil-pncp-proposals/v3',
    beforeRequest,
  });
  if (wire.status === 204) return { records: [], provenance: wire.provenance };
  if (!Array.isArray(wire.payload.data)) throw new Error('PNCP schema changed: data');
  const records = wire.payload.data.flatMap((raw): BrazilPncpNotice[] => {
    const item = object(raw);
    const buyer = item && object(item.orgaoEntidade);
    const unit = item && object(item.unidadeOrgao);
    const controlNumber = item && text(item.numeroControlePNCP);
    const organizationName = buyer && text(buyer.razaoSocial);
    const title = item && sanitizePublicProcurementTitle(item.objetoCompra);
    if (!item || !controlNumber || !organizationName || !title) return [];
    const buyerCnpjClaim = validatedPncpCnpjClaim(controlNumber, text(buyer.cnpj));
    const estimatedValue = finiteNumber(item.valorTotalEstimado);
    return [{
      controlNumber,
      organizationName,
      organizationRole: 'buyer',
      signalStage: 'open_for_proposals',
      buyerCnpjClaim,
      title,
      method: boundedText(item.modalidadeNome, 100),
      deadline: text(item.dataEncerramentoProposta),
      estimatedValue: estimatedValue != null && estimatedValue >= 0 ? estimatedValue : undefined,
      noticeUrl: safeHttpUrl(item.linkSistemaOrigem),
      unitMunicipality: boundedText(unit?.municipioNome, 100),
      unitState: /^[A-Z]{2}$/u.test(text(unit?.ufSigla) ?? '') ? text(unit?.ufSigla) : undefined,
      unitIbgeCode: /^\d{7}$/u.test(text(unit?.codigoIbge) ?? '') ? text(unit?.codigoIbge) : undefined,
    }];
  });
  const total = finiteNumber(wire.payload.totalRegistros);
  const totalPages = finiteNumber(wire.payload.totalPaginas) ?? page;
  return { records, total, nextCursor: page < totalPages ? String(page + 1) : undefined, provenance: wire.provenance };
}

export function validatedPncpCnpjClaim(controlNumber: string, value: string | undefined): string | undefined {
  const normalized = value?.normalize('NFKC');
  const controlPrefix = /^(\d{14})-/u.exec(controlNumber.normalize('NFKC'))?.[1];
  return normalized
    && /^\d{14}$/u.test(normalized)
    && isValidCnpjIdentifier(normalized)
    && normalized === controlPrefix
    ? normalized
    : undefined;
}

function boundedText(value: unknown, maximum: number): string | undefined {
  const normalized = text(value)?.normalize('NFKC').replaceAll(/\s+/gu, ' ');
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function safeHttpUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw || raw.length > 512) return undefined;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sanitizePublicProcurementTitle(value: unknown): string | undefined {
  const raw = boundedText(value, 512);
  if (!raw) return undefined;
  const sanitized = raw
    .replaceAll(/<[^>]*>/gu, ' ')
    .replaceAll(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[contact-redacted]')
    .replaceAll(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/gu, '[id-redacted]')
    .replaceAll(/\b(?:\+?55\s*)?(?:\(?\d{2}\)?\s*)?\d{4,5}[-\s]?\d{4}\b/gu, '[contact-redacted]')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return sanitized || undefined;
}

export async function searchSingaporeGebiz(
  input: { keywords: string[]; offset?: number; limit?: number },
  beforeRequest?: BeforeRequest,
): Promise<ProcurementPage<SingaporeGebizAward>> {
  const offset = normalizedPositiveInteger(input.offset, 0, 10_000, 0);
  const limit = normalizedPositiveInteger(input.limit, 20, 100);
  const keywords = input.keywords.map((item) => item.trim()).filter(Boolean);
  if (!keywords.length) throw new Error('GeBIZ requires keywords');
  const url = new URL(GEBIZ_URL);
  url.searchParams.set('resource_id', GEBIZ_DATASET_ID);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('q', keywords.join(' '));
  const wire = await fetchBoundedJson({
    url,
    allowedHosts: ['data.gov.sg'],
    allowedPathPrefixes: ['/api/action/datastore_search'],
    maximumBytes: 6 * 1024 * 1024,
    parserVersion: 'singapore-gebiz-awards/v1',
    beforeRequest,
  });
  const result = object(wire.payload.result);
  if (wire.payload.success !== true || !result || !Array.isArray(result.records)) {
    throw new Error('GeBIZ schema changed: result.records');
  }
  const records = result.records.flatMap((raw): SingaporeGebizAward[] => {
    const item = object(raw);
    const rowId = item && (text(item._id) ?? String(finiteNumber(item._id) ?? ''));
    const tenderNumber = item && text(item.tender_no);
    const title = item && text(item.tender_description);
    const buyerAgency = item && text(item.agency);
    const organizationName = item && text(item.supplier_name);
    const status = item && text(item.tender_detail_status);
    // Award rows without a supplier are not company leads; the agency is retained only as buyer evidence.
    if (
      !item || !rowId || !tenderNumber || !title || !buyerAgency || !organizationName ||
      !/^(?:awarded to suppliers?|awarded by items|award by interface record)$/iu.test(status?.trim() ?? '') ||
      /^(?:unknown|n\/?a|none|null|-+)$/iu.test(organizationName.trim())
    ) return [];
    return [{
      externalId: `${tenderNumber}:${rowId}`,
      tenderNumber,
      organizationName,
      organizationRole: 'supplier',
      signalStage: 'awarded_historical',
      title,
      buyerAgency,
      awardDate: text(item.award_date),
      status: status ?? undefined,
      amount: finiteNumber(item.awarded_amt),
    }];
  });
  const total = finiteNumber(result.total) ?? records.length;
  const next = offset + array(result.records).length;
  return {
    records,
    total,
    nextCursor: next < total && array(result.records).length ? String(next) : undefined,
    provenance: wire.provenance,
  };
}

export async function searchContractsFinder(
  input: {
    publishedFrom: string;
    publishedTo?: string;
    cursor?: string;
    limit?: number;
    stage: UkOcdsStage;
  },
  beforeRequest?: BeforeRequest,
): Promise<ProcurementPage<ContractsFinderOrganization>> {
  const url = new URL(CONTRACTS_FINDER_URL);
  url.searchParams.set('stages', assertUkOcdsStage(input.stage));
  url.searchParams.set('limit', String(normalizedPositiveInteger(input.limit, 100, 100)));
  const savedCursor = readOcdsCursor(input.cursor, 'publishedFrom', 'publishedTo');
  if (savedCursor) {
    url.searchParams.set('publishedFrom', savedCursor.lowerBound);
    url.searchParams.set('publishedTo', savedCursor.upperBound);
    url.searchParams.set('cursor', savedCursor.cursor);
  } else {
    url.searchParams.set('publishedFrom', assertDateTime(input.publishedFrom, 'publishedFrom'));
    if (input.publishedTo) url.searchParams.set('publishedTo', assertDateTime(input.publishedTo, 'publishedTo'));
  }
  const wire = await fetchBoundedJson({
    url,
    allowedHosts: ['www.contractsfinder.service.gov.uk'],
    allowedPathPrefixes: ['/Published/Notices/OCDS/Search'],
    timeoutMs: 30_000,
    maximumBytes: 8 * 1024 * 1024,
    parserVersion: 'uk-contracts-finder-ocds/v4',
    beforeRequest,
  });
  return mapUkOcdsPage(
    wire,
    'www.contractsfinder.service.gov.uk',
    '/Published/Notices/OCDS/Search',
    'publishedFrom',
    'publishedTo',
    null,
  );
}

function mapUkOcdsPage(
  wire: BoundedJsonResponse,
  expectedHost: string,
  expectedPath: string,
  lowerBoundField: 'updatedFrom' | 'publishedFrom',
  upperBoundField: 'updatedTo' | 'publishedTo',
  noticeBaseUrl: string | null = 'https://www.find-tender.service.gov.uk/Notice/',
): ProcurementPage<UkProcurementOrganization> {
  if (!Array.isArray(wire.payload.releases)) throw new Error('UK OCDS schema changed: releases');
  const records = wire.payload.releases.flatMap((release) => mapUkOcdsRelease(release, noticeBaseUrl));
  const links = object(wire.payload.links);
  const nextLink = text(links?.next);
  let nextCursor: string | undefined;
  if (nextLink) {
    const next = new URL(nextLink, wire.provenance.sourceUrl);
    if (next.protocol !== 'https:' || next.hostname !== expectedHost || next.pathname !== expectedPath) {
      throw new Error('UK OCDS next link escaped the official endpoint');
    }
    const cursor = safeCursor(next.searchParams.get('cursor') ?? undefined);
    // Contracts Finder currently emits a literal `+01:00` in links.next
    // instead of percent-encoding the plus. URLSearchParams follows form
    // semantics and decodes that plus as a space, so restore only the narrow
    // ISO offset shape before validating the official snapshot boundary.
    const upperBound = text(next.searchParams.get(upperBoundField))?.replace(/ (?=\d{2}:\d{2}$)/u, '+');
    const requestUrl = new URL(wire.provenance.sourceUrl);
    const lowerBound = text(next.searchParams.get(lowerBoundField) ?? requestUrl.searchParams.get(lowerBoundField));
    if (cursor && lowerBound && upperBound) {
      nextCursor = JSON.stringify({
        cursor,
        [lowerBoundField]: assertDateTime(lowerBound, lowerBoundField),
        [upperBoundField]: assertDateTime(upperBound, upperBoundField),
      });
    }
  }
  return { records, nextCursor, provenance: wire.provenance };
}

function mapUkOcdsRelease(raw: unknown, noticeBaseUrl?: string | null): UkProcurementOrganization[] {
  const release = object(raw);
  if (!release) return [];
  const ocid = text(release.ocid);
  const releaseId = text(release.id);
  const tender = object(release.tender);
  // Description is unbounded free text and live notices may contain personal
  // contact details. Never promote it to the persisted title field.
  const title = text(tender?.title);
  if (!ocid || !releaseId || !title) return [];
  const releaseTags = array(release.tag).map(text).filter((value): value is string => Boolean(value));
  const tenderPeriod = object(tender?.tenderPeriod);
  const tenderValue = object(tender?.value);
  const classifications = [object(tender?.classification), ...array(tender?.additionalClassifications).map(object)]
    .filter((item): item is JsonObject => Boolean(item));
  const classificationIds = [...new Set(classifications
    .filter((item) => text(item.scheme)?.toLocaleUpperCase('en-US') === 'CPV')
    .map((item) => text(item.id))
    .filter((value): value is string => Boolean(value)))];
  const isAward = releaseTags.includes('award');
  const parties = array(release.parties).map(object).filter((party): party is JsonObject => Boolean(party));
  const buyer = object(release.buyer);
  const buyerIds = new Set([text(buyer?.id)].filter((value): value is string => Boolean(value)));
  const suppliers = array(release.awards)
    .flatMap((award) => array(object(award)?.suppliers))
    .map(object)
    .filter((supplier): supplier is JsonObject => Boolean(supplier));
  const supplierIds = new Set(suppliers.map((supplier) => text(supplier.id)).filter((value): value is string => Boolean(value)));
  const candidates: Array<{ party: JsonObject; role: 'buyer' | 'supplier' }> = [];
  for (const party of parties) {
    const roles = array(party.roles).map(text).filter((value): value is string => Boolean(value));
    const id = text(party.id);
    if (roles.includes('buyer') || (id && buyerIds.has(id))) candidates.push({ party, role: 'buyer' });
    if (isAward && (roles.includes('supplier') || (id && supplierIds.has(id)))) candidates.push({ party, role: 'supplier' });
  }
  if (!candidates.some((candidate) => candidate.role === 'buyer') && text(buyer?.name)) {
    candidates.push({ party: buyer!, role: 'buyer' });
  }
  for (const supplier of suppliers) {
    const id = text(supplier.id);
    if (!candidates.some((candidate) => candidate.role === 'supplier' && text(candidate.party.id) === id)) {
      candidates.push({ party: supplier, role: 'supplier' });
    }
  }
  const dedup = new Map<string, UkProcurementOrganization>();
  for (const { party, role } of candidates) {
    const organizationName = text(party.name) ?? text(party.legalName);
    if (!organizationName) continue;
    const sourcePartyId = text(party.id);
    const address = object(party.address);
    const details = object(party.details);
    const key = `${role}:${sourcePartyId ?? organizationName.toLocaleLowerCase('en-US')}`;
    const location = ukOcdsLocation(address);
    dedup.set(key, {
      externalId: `${ocid}:${releaseId}:${key}`,
      ocid,
      releaseId,
      organizationName,
      organizationRole: role,
      // An award release is historical evidence for both sides; its buyer must not be
      // presented as a still-open demand signal.
      signalStage: isAward ? 'awarded' : 'planning_or_tender',
      sourcePartyId,
      country: location.country,
      region: location.region,
      declaredUrl: text(details?.url),
      title,
      description: text(tender?.description),
      status: text(tender?.status),
      date: text(release.date),
      noticeUrl: noticeBaseUrl ? `${noticeBaseUrl}${encodeURIComponent(releaseId)}` : undefined,
      deadline: text(tenderPeriod?.endDate),
      estimatedValue: finiteNumber(tenderValue?.amount),
      currency: text(tenderValue?.currency),
      classificationIds: classificationIds.length ? classificationIds : undefined,
    });
  }
  return [...dedup.values()];
}

type UkConstituent = 'England' | 'Scotland' | 'Wales' | 'Northern Ireland';

function normalizeUkOcdsConstituent(value: unknown): UkConstituent | undefined {
  const normalized = text(value)?.toLocaleLowerCase('en-US');
  if (normalized === 'england') return 'England';
  if (normalized === 'scotland') return 'Scotland';
  if (normalized === 'wales') return 'Wales';
  if (normalized === 'northern ireland') return 'Northern Ireland';
  return undefined;
}

function ukOcdsRegionCode(value: unknown): UkConstituent | undefined {
  const code = text(value)?.replaceAll(/[-\s]/gu, '').toLocaleUpperCase('en-US');
  if (!code?.startsWith('UK')) return undefined;
  if (/^UKN(?:\d[A-Z0-9]?)?$/u.test(code)) return 'Northern Ireland';
  if (/^UKM(?:\d[A-Z0-9]?)?$/u.test(code)) return 'Scotland';
  if (/^UKL(?:\d[A-Z0-9]?)?$/u.test(code)) return 'Wales';
  if (/^UK[C-K](?:\d[A-Z0-9]?)?$/u.test(code)) return 'England';
  return undefined;
}

function ukOcdsPostcodeRegion(value: unknown): UkConstituent | undefined {
  const postcode = text(value)?.replaceAll(' ', '').toLocaleUpperCase('en-US');
  if (!postcode || !/^(?:GIR0AA|[A-PR-UWYZ][A-HK-Y]?\d[A-Z\d]?\d[ABD-HJLNP-UW-Z]{2})$/u.test(postcode)) {
    return undefined;
  }
  const area = postcode?.match(/^[A-Z]{1,2}/u)?.[0];
  if (!area) return undefined;
  if (area === 'BT') return 'Northern Ireland';
  // Only postcode areas wholly inside one constituent are admitted. Border
  // areas CH/SY and TD remain unknown unless another address field is explicit.
  if (new Set(['CF', 'LD', 'LL', 'NP', 'SA']).has(area)) return 'Wales';
  if (new Set(['AB', 'DD', 'DG', 'EH', 'FK', 'G', 'HS', 'IV', 'KA', 'KW', 'KY', 'ML', 'PA', 'PH', 'ZE']).has(area)) {
    return 'Scotland';
  }
  return undefined;
}

function ukOcdsLocation(address: JsonObject | null): {
  country?: string;
  region?: UkConstituent;
} {
  const declaredRegion = normalizeUkOcdsConstituent(address?.region) ?? ukOcdsRegionCode(address?.region);
  const declaredCountryRegion = normalizeUkOcdsConstituent(address?.countryName);
  const declaredCountry = text(address?.countryName);
  const declaredUk = [
    'gb',
    'gbr',
    'uk',
    'united kingdom',
    'great britain',
    'united kingdom of great britain and northern ireland',
  ].includes(
    declaredCountry?.toLocaleLowerCase('en-US') ?? '',
  );
  const foreignCountry = declaredCountry && !declaredCountryRegion && !declaredUk ? declaredCountry : undefined;
  const postcodeRegion = ukOcdsPostcodeRegion(address?.postalCode);

  // A clear foreign address on a UK award supplier must never be relabelled
  // as British merely because the notice came from a UK procurement endpoint.
  if (foreignCountry) return { country: foreignCountry };

  // A non-border postcode is narrower than countryName and corrects observed
  // Contracts Finder defects such as Newry (BT) and St Asaph (LL), both
  // incorrectly labelled England by the upstream record.
  let region: UkConstituent | undefined;
  if (declaredRegion && postcodeRegion) {
    if (declaredRegion !== postcodeRegion) region = undefined;
    else if (declaredCountryRegion && declaredCountryRegion !== declaredRegion && declaredCountryRegion !== 'England') {
      region = undefined;
    } else region = declaredRegion;
  } else if (declaredRegion && declaredCountryRegion && declaredRegion !== declaredCountryRegion) {
    region = undefined;
  } else if (
    postcodeRegion
    && declaredCountryRegion
    && declaredCountryRegion !== postcodeRegion
    && declaredCountryRegion !== 'England'
  ) {
    // Only the observed upstream England mislabelling is corrected. Any other
    // constituent disagreement remains unknown for manual review.
    region = undefined;
  } else {
    region = declaredRegion ?? postcodeRegion ?? declaredCountryRegion;
  }

  const country = declaredUk || declaredCountryRegion || declaredRegion || postcodeRegion ? 'United Kingdom' : undefined;
  return { ...(country ? { country } : {}), ...(region ? { region } : {}) };
}
