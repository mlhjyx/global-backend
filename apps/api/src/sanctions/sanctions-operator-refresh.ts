import type { PrismaClient } from '@prisma/client';
import { PUBLIC_HTTP_OPERATOR_TIMEOUT_MAX_MS } from '../adapters/guarded-http';
import type { ParsedSanctionsList } from '../adapters/ofac-xml';
import type { ExecutionBroker } from '../tools/tool-contract';
import {
  SanctionsRefreshService,
  diffSanctionsEntities,
  sanctionsListVersion,
  sanctionsShrinkGuardTripped,
  toDesiredEntity,
  type SanctionsRefreshSummary,
} from './sanctions-refresh.service';
import {
  OperatorSanctionsDownloads,
  SanctionsOperatorRefreshError,
  assertOfficialSanctionsSource,
  censusOfParsedList,
  parseSanctionsListForOperator,
  type PublicHttpRequester,
  type SanctionsListCensus,
  type SanctionsListDownloadFacts,
} from './sanctions-operator-download';

/**
 * Operator refresh of the official sanctions lists (B0, plan 2026-10-10): owner connection only,
 * official endpoints only, persisted through SanctionsRefreshService's unreceipted owner path.
 * `sanctions_source.status` is never written here: enabling a source is a separate owner step.
 * Entry point: apps/api/scripts/refresh-sanctions-lists.mts; runbook:
 * docs/backend/sanctions-operator-refresh.md.
 */

export const SANCTIONS_OPERATOR_SOURCE_KEYS = Object.freeze(['eu_fsf', 'ofac_consolidated', 'ofac_sdn'] as const);
export type SanctionsOperatorSourceKey = (typeof SANCTIONS_OPERATOR_SOURCE_KEYS)[number];

export const SANCTIONS_OPERATOR_DEFAULT_TIMEOUT_SECONDS = 600;
const MIN_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = PUBLIC_HTTP_OPERATOR_TIMEOUT_MAX_MS / 1000;

export interface SanctionsOperatorOptions {
  sourceKeys: SanctionsOperatorSourceKey[];
  dryRun: boolean;
  timeoutMs: number;
}

export type SanctionsOperatorArgs = { kind: 'help' } | { kind: 'run'; options: SanctionsOperatorOptions };

export const SANCTIONS_OPERATOR_USAGE = [
  'usage: refresh-sanctions-lists --source=<all|ofac_sdn|ofac_consolidated|eu_fsf>[,...] [--dry-run] [--timeout-seconds=<n>]',
  '  --source           required; all = the three official lists',
  '  --dry-run          download, parse and compare without writing',
  `  --timeout-seconds  per-hop download deadline, ${MIN_TIMEOUT_SECONDS}-${MAX_TIMEOUT_SECONDS} (default ${SANCTIONS_OPERATOR_DEFAULT_TIMEOUT_SECONDS})`,
  'Connects with DATABASE_URL (database owner); refuses app_user. Never changes sanctions_source.status.',
].join('\n');

function usageError(detail: string): SanctionsOperatorRefreshError {
  return new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_USAGE', detail);
}

function isSourceKey(value: string): value is SanctionsOperatorSourceKey {
  return (SANCTIONS_OPERATOR_SOURCE_KEYS as readonly string[]).includes(value);
}

function parseSources(raw: string | undefined): SanctionsOperatorSourceKey[] {
  if (!raw) throw usageError('--source needs a value');
  const values = raw.split(',').map((value) => value.trim());
  if (values.length === 1 && values[0] === 'all') return [...SANCTIONS_OPERATOR_SOURCE_KEYS];
  const unknown = values.filter((value) => !isSourceKey(value));
  if (unknown.length) throw usageError(`unknown source ${unknown.join(',') || '(empty)'}`);
  return SANCTIONS_OPERATOR_SOURCE_KEYS.filter((key) => values.includes(key));
}

function parseTimeoutSeconds(raw: string | undefined): number {
  const seconds = raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(seconds >= MIN_TIMEOUT_SECONDS && seconds <= MAX_TIMEOUT_SECONDS)) {
    throw usageError(`--timeout-seconds must be an integer from ${MIN_TIMEOUT_SECONDS} to ${MAX_TIMEOUT_SECONDS}`);
  }
  return seconds;
}

export function parseSanctionsOperatorArgs(argv: readonly string[]): SanctionsOperatorArgs {
  let sources: SanctionsOperatorSourceKey[] | undefined;
  let dryRun = false;
  let timeoutSeconds = SANCTIONS_OPERATOR_DEFAULT_TIMEOUT_SECONDS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--help' || arg === '-h') return { kind: 'help' };
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    const value = (): string | undefined => inline ?? argv[++index];
    if (flag === '--source') sources = parseSources(value());
    else if (flag === '--timeout-seconds') timeoutSeconds = parseTimeoutSeconds(value());
    else if (flag === '--dry-run' && inline === undefined) dryRun = true;
    else throw usageError(`unexpected argument ${arg}`);
  }
  if (!sources) throw usageError('--source is required (all, or a comma list of ofac_sdn, ofac_consolidated, eu_fsf)');
  return { kind: 'run', options: { sourceKeys: sources, dryRun, timeoutMs: timeoutSeconds * 1000 } };
}

export interface DatabaseRoleFacts {
  role: string;
  superuser: boolean;
  /** The role has its privileges over the owner of both sanctions tables. */
  ownsSanctionsTables: boolean;
}

export async function readDatabaseRole(db: Pick<PrismaClient, '$queryRaw'>): Promise<DatabaseRoleFacts> {
  const rows = await db.$queryRaw<{ role: string; superuser: boolean; owned_tables: number }[]>`
    SELECT current_user::text AS role,
           r.rolsuper AS superuser,
           (SELECT count(*)::int FROM pg_catalog.pg_class c
             WHERE c.oid IN (to_regclass('sanctions_source'), to_regclass('sanctions_entity'))
               AND pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')) AS owned_tables
      FROM pg_catalog.pg_roles r
     WHERE r.rolname = current_user`;
  const row = rows[0];
  if (!row) throw new SanctionsOperatorRefreshError('SANCTIONS_OPERATOR_OWNER_REQUIRED', 'connected role is not visible in pg_roles');
  return { role: row.role, superuser: row.superuser === true, ownsSanctionsTables: Number(row.owned_tables) === 2 };
}

/** Fail closed unless connected as the database owner (a superuser or the sanctions tables' owner). */
export function assertSanctionsOwnerRole(facts: DatabaseRoleFacts): void {
  if (facts.role === 'app_user') {
    throw new SanctionsOperatorRefreshError(
      'SANCTIONS_OPERATOR_OWNER_REQUIRED',
      'connected as app_user, the runtime role; run with DATABASE_URL, the database owner connection',
    );
  }
  if (!facts.superuser && !facts.ownsSanctionsTables) {
    throw new SanctionsOperatorRefreshError(
      'SANCTIONS_OPERATOR_OWNER_REQUIRED',
      `connected as ${facts.role}, which neither is a superuser nor owns sanctions_source and sanctions_entity; run with DATABASE_URL, the database owner connection`,
    );
  }
}

export interface SanctionsRefreshPlan {
  listVersion: string;
  existingActive: number;
  added: number;
  updated: number;
  unchanged: number;
  withdrawn: number;
  shrinkGuardTripped: boolean;
}

/** What a write would do, from the same pure diff the service applies; reads only. */
export async function planSanctionsRefresh(
  db: Pick<PrismaClient, 'sanctionsEntity'>,
  sourceId: string,
  parsed: ParsedSanctionsList,
  now: Date = new Date(),
): Promise<SanctionsRefreshPlan> {
  const listVersion = sanctionsListVersion(parsed, now);
  const existing = await db.sanctionsEntity.findMany({
    where: { sourceId },
    select: { externalId: true, contentHash: true, withdrawnAt: true },
  });
  const existingActive = existing.filter((row) => !row.withdrawnAt).length;
  const diff = diffSanctionsEntities(existing, parsed.entities.map((entity) => toDesiredEntity(entity, listVersion)));
  return {
    listVersion,
    existingActive,
    added: diff.toCreate.length,
    updated: diff.toUpdate.length,
    unchanged: diff.unchanged,
    withdrawn: diff.toWithdrawExternalIds.length,
    shrinkGuardTripped: sanctionsShrinkGuardTripped(parsed.entities.length, existingActive),
  };
}

export interface SanctionsOperatorSourceReport {
  key: string;
  status: 'DRY_RUN' | 'DONE' | 'FAILED';
  download?: SanctionsListDownloadFacts;
  census?: SanctionsListCensus;
  plan?: SanctionsRefreshPlan;
  summary?: SanctionsRefreshSummary;
  error?: string;
}

export interface SanctionsOperatorReport {
  role: string;
  mode: 'dry-run' | 'write';
  ok: boolean;
  sources: SanctionsOperatorSourceReport[];
}

export interface SanctionsOperatorDeps {
  /** Database owner connection (DATABASE_URL). */
  owner: PrismaClient;
  /** The ToolBroker's source_policy decision. */
  sourcePolicy: Pick<ExecutionBroker, 'checkSourcePolicy'>;
  request?: PublicHttpRequester;
  log?: (line: string) => void;
  /** Pause before a download retry (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

interface SelectedSourceRow {
  id: string;
  key: string;
  url: string;
  format: string;
  config: unknown;
}

function configuredUserAgent(config: unknown): string | undefined {
  const userAgent = (config as { userAgent?: unknown } | null)?.userAgent;
  return typeof userAgent === 'string' ? userAgent : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadSelectedSources(owner: PrismaClient, keys: readonly string[]): Promise<SelectedSourceRow[]> {
  const rows = await owner.sanctionsSource.findMany({
    where: { key: { in: [...keys] } },
    select: { id: true, key: true, url: true, format: true, config: true },
    orderBy: { key: 'asc' },
  });
  const missing = keys.filter((key) => !rows.some((row) => row.key === key));
  if (missing.length) {
    throw new SanctionsOperatorRefreshError(
      'SANCTIONS_OPERATOR_SOURCE_MISSING',
      `${missing.join(',')} has no sanctions_source row; the worker seeds it at start`,
    );
  }
  return rows;
}

async function dryRunSource(
  owner: PrismaClient,
  downloads: OperatorSanctionsDownloads,
  row: SelectedSourceRow,
): Promise<SanctionsOperatorSourceReport> {
  try {
    const { body, ...download } = await downloads.download(row.key, configuredUserAgent(row.config));
    const parsed = parseSanctionsListForOperator(row.format, body);
    const census = censusOfParsedList(row.format, parsed);
    const plan = await planSanctionsRefresh(owner, row.id, parsed);
    if (plan.shrinkGuardTripped) {
      // The write would refuse this list and mark the source FAILED; say so now.
      return {
        key: row.key, status: 'FAILED', download, census, plan,
        error: `SANCTIONS_OPERATOR_SHRINK_GUARD_WOULD_REFUSE: parsed ${census.kept} vs active ${plan.existingActive}`,
      };
    }
    return { key: row.key, status: 'DRY_RUN', download, census, plan };
  } catch (error) {
    return { key: row.key, status: 'FAILED', error: errorMessage(error) };
  }
}

/**
 * Owner check, then every selected row checked against its official endpoint before any network
 * call; a dry run downloads, parses and plans; a write refreshes through SanctionsRefreshService.
 */
export async function runSanctionsOperatorRefresh(
  deps: SanctionsOperatorDeps,
  options: SanctionsOperatorOptions,
): Promise<SanctionsOperatorReport> {
  const facts = await readDatabaseRole(deps.owner);
  assertSanctionsOwnerRole(facts);
  const rows = await loadSelectedSources(deps.owner, options.sourceKeys);
  const endpoints = rows.map(assertOfficialSanctionsSource);
  const downloads = new OperatorSanctionsDownloads({
    endpoints,
    sourcePolicy: deps.sourcePolicy,
    timeoutMs: options.timeoutMs,
    request: deps.request,
    log: deps.log,
    sleep: deps.sleep,
  });
  const mode = options.dryRun ? 'dry-run' : 'write';
  deps.log?.(`connected as ${facts.role}; mode=${mode}; sources=${rows.map((row) => row.key).join(',')}`);

  const sources: SanctionsOperatorSourceReport[] = [];
  if (options.dryRun) {
    for (const row of rows) sources.push(await dryRunSource(deps.owner, downloads, row));
  } else {
    const service = new SanctionsRefreshService({ ownerDb: deps.owner, broker: downloads });
    const summaries = await service.refreshSourcesByKey(rows.map((row) => row.key));
    for (const summary of summaries) {
      const served = downloads.served(summary.sourceKey);
      sources.push({
        key: summary.sourceKey,
        status: summary.status,
        ...(served ? { download: served.download, census: served.census } : {}),
        summary,
        ...(summary.error ? { error: summary.error } : {}),
      });
    }
  }
  return { role: facts.role, mode, ok: sources.every((source) => source.status !== 'FAILED'), sources };
}

function counts(record: Record<string, number>): string {
  const entries = Object.entries(record);
  return entries.length ? entries.map(([type, count]) => `${type} ${count}`).join(', ') : 'none';
}

/** Console lines: counts, dates and hosts only. */
export function formatSanctionsOperatorReport(report: SanctionsOperatorReport): string[] {
  const lines = [`sanctions operator refresh (${report.mode}) as ${report.role}: ${report.ok ? 'ok' : 'FAILED'}`];
  for (const source of report.sources) {
    lines.push(`- ${source.key}: ${source.status}${source.error ? ` (${source.error})` : ''}`);
    if (source.download) {
      lines.push(`  download: ${source.download.bytes} bytes from ${source.download.host} via ${source.download.finalHost}, ${source.download.contentType}, ${Math.round(source.download.elapsedMs / 1000)} s`);
    }
    if (source.census) {
      lines.push(`  list: publish date ${source.census.publishDate ?? 'none'}; ${source.census.entries} entries; kept ${source.census.kept} entities; dropped ${counts(source.census.dropped)}; invalid entities ${source.census.invalidEntities}`);
    }
    if (source.plan) {
      const guard = source.plan.shrinkGuardTripped ? 'shrink guard WOULD REFUSE' : 'shrink guard ok';
      lines.push(`  would: add ${source.plan.added}, update ${source.plan.updated}, unchanged ${source.plan.unchanged}, withdraw ${source.plan.withdrawn} (active now ${source.plan.existingActive}; version ${source.plan.listVersion}; ${guard})`);
    }
    if (source.summary && source.summary.status === 'DONE') {
      lines.push(`  wrote: added ${source.summary.added}, updated ${source.summary.updated}, unchanged ${source.summary.unchanged}, withdrawn ${source.summary.withdrawn}; total ${source.summary.total}; publish date ${source.summary.publishDate ?? 'none'}`);
    }
  }
  if (report.mode === 'write') {
    lines.push('status was not changed; enabling a source is the separate owner step in docs/backend/sanctions-operator-refresh.md');
  }
  return lines;
}
