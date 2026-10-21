import { ApplicationFailure } from '@temporalio/activity';
import type { ExecutionBudgetBinding } from '../execution-budget/execution-budget-binding';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import { MAX_MODEL_GATEWAY_REQUEST_TIMEOUT_MS } from '../model-gateway/gateway-credential-boundary';
import { MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND } from '../model-gateway/model-execution-envelope';
import type { PrismaService } from '../prisma/prisma.service';
import {
  upstreamUnavailableRetryDelayMs,
  withUpstreamUnavailableRetryDelay,
} from './upstream-unavailable-retry';

/*
 * A discovery run holds an admission lease: three hours from admission (the landing design of
 * ADR-024's lease, docs/superpowers/plans/2026-10-09-discovery-run-admission-lease.md). Past it
 * every attest and every reservation is refused, so a run still at work can only end FAILED and
 * its plan stays unspent: on xin a 28-query plan ran its fit stage into the lease (2026-10-20).
 * Each stage therefore starts a unit of work only while the unit still ends before the
 * finalization reserve. Otherwise it stops, counts what it left in `skippedForLease`, and the run
 * ends PARTIAL with what it found; scoring still runs.
 */

/**
 * Kept at the end of the lease for the activities that never stop for it: canonicalize, patent
 * enqueue, finalize. The signals stage does not stop for the lease yet either: it runs in whatever
 * fit and enrichment leave, about 20 minutes once fit stops (its 10-minute unit plus this reserve),
 * where xin's signal reads take some 30 seconds a company; only a run of sites at their read
 * timeouts still overruns the lease there.
 */
export const DISCOVERY_LEASE_FINALIZATION_RESERVE_MS = 10 * 60_000;

/** The longest unit of work each stage starts, by stage. */
export const DISCOVERY_LEASE_UNIT_MS = Object.freeze({
  /** One query attempt: the model proxy's start-to-close timeout. */
  query: 15 * 60_000,
  /** One company: a structured answer may take two gateway requests at the request ceiling. */
  fit: MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND * MAX_MODEL_GATEWAY_REQUEST_TIMEOUT_MS,
  /** One company: three 75-second page reads (home, Impressum, contact render) and one structured answer. */
  websiteProfile: 15 * 60_000,
  /** One company: the enrichment proxy's start-to-close timeout (a GLEIF read times out at 25 seconds). */
  enrich: 2 * 60_000,
  /** One company: a sitemap probe and the watch's registration. */
  watches: 5 * 60_000,
});

export interface DiscoveryRunLease {
  /** Whether a unit of work of `unitMs` started now still ends before the finalization reserve. */
  allows(unitMs: number): boolean;
  /** Time left before the finalization reserve begins (negative once it has); Infinity without a lease. */
  slackMs(): number;
}

/** Milliseconds left on the run's admission lease, measured on the database clock. */
export type DiscoveryRunLeaseReader = (binding: ExecutionBudgetBinding) => Promise<number>;

/** No lease reader wired: nothing stops early, and the database still refuses work past the lease. */
export const UNBOUNDED_DISCOVERY_RUN_LEASE: DiscoveryRunLease = Object.freeze({
  allows: () => true,
  slackMs: () => Infinity,
});

/**
 * The lease as read once: the database gives the time left, the worker's clock measures the time
 * since the read, so clock skew between the two does not matter. The lease is written once, at
 * admission, and never changes, so one read per activity is enough.
 */
export function startDiscoveryRunLease(remainingMs: number, clock: () => number): DiscoveryRunLease {
  const readAt = clock();
  const slackMs = (): number => remainingMs - (clock() - readAt) - DISCOVERY_LEASE_FINALIZATION_RESERVE_MS;
  return Object.freeze({ allows: (unitMs: number) => slackMs() >= unitMs, slackMs });
}

/**
 * Reads the time left on the run's grant the way attest_authorized_tool_budget_v1 judges the lease
 * (COALESCE(admission_lease_expires_at, expires_at)), without its 60-second tolerance. Under RLS
 * app_user sees only the workspace's own grants; anything but exactly one finite answer fails
 * closed as a control error.
 */
export function prismaDiscoveryRunLeaseReader(
  prisma: Pick<PrismaService, 'withWorkspace'>,
): DiscoveryRunLeaseReader {
  return async (binding) => {
    const rows = await prisma.withWorkspace(binding.scopeKey, (tx) =>
      tx.$queryRaw<ReadonlyArray<{ remaining_ms: number | null }>>`
        SELECT (EXTRACT(EPOCH FROM (COALESCE(admission_lease_expires_at, expires_at) - statement_timestamp())) * 1000)::double precision AS remaining_ms
        FROM "execution_budget_authority"
        WHERE id = ${binding.authorityId}::uuid
          AND scope_key = ${binding.scopeKey}
          AND authority_kind = 'WORKSPACE_GRANT'
      `,
    );
    const remaining = rows.length === 1 ? rows[0]?.remaining_ms : undefined;
    if (typeof remaining !== 'number' || !Number.isFinite(remaining)) {
      throw new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE');
    }
    return remaining;
  };
}

/**
 * Whether the wait the next attempt makes after `error` (an unavailable model upstream) still
 * leaves room for one more unit of work before the finalization reserve. An error that makes no
 * wait, or the last attempt, changes nothing. When the wait does not fit, the stage stops for the
 * lease instead: a retry without the wait would spend the remaining attempts on the same outage
 * within seconds and fail the run.
 */
export function upstreamWaitFitsLease(error: unknown, lease: DiscoveryRunLease, unitMs: number): boolean {
  const waitMs = upstreamUnavailableRetryDelayMs(error);
  return waitMs === undefined || lease.allows(waitMs + unitMs);
}

/** The shortest wait before the attempt that stops a query for the lease. */
const QUERY_LEASE_STOP_RETRY_MS = 1_000;

/**
 * The failure a query attempt rethrows for `error`. When the upstream wait would leave no room for
 * another query, the next attempt starts just past the query deadline instead: it then ends the
 * query with a zero receipt for the lease, and the run goes on to finish PARTIAL.
 */
export function withLeaseAwareQueryRetryDelay(error: unknown, lease: DiscoveryRunLease): unknown {
  if (upstreamWaitFitsLease(error, lease, DISCOVERY_LEASE_UNIT_MS.query)) {
    return withUpstreamUnavailableRetryDelay(error);
  }
  return ApplicationFailure.fromError(error, {
    nextRetryDelay: Math.max(
      QUERY_LEASE_STOP_RETRY_MS,
      Math.ceil(lease.slackMs() - DISCOVERY_LEASE_UNIT_MS.query) + QUERY_LEASE_STOP_RETRY_MS,
    ),
  });
}
