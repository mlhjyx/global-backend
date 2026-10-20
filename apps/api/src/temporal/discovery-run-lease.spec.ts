import { ApplicationFailure } from '@temporalio/activity';
import { describe, expect, it, vi } from 'vitest';
import { ExecutionBudgetGrantError } from '../execution-budget/execution-budget-authority.types';
import { MAX_MODEL_GATEWAY_REQUEST_TIMEOUT_MS } from '../model-gateway/gateway-credential-boundary';
import { MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND } from '../model-gateway/model-execution-envelope';
import { ProviderHttpError } from '../model-gateway/providers/provider-output-error';
import {
  DISCOVERY_LEASE_FINALIZATION_RESERVE_MS,
  DISCOVERY_LEASE_UNIT_MS,
  prismaDiscoveryRunLeaseReader,
  startDiscoveryRunLease,
  UNBOUNDED_DISCOVERY_RUN_LEASE,
  upstreamWaitFitsLease,
  withLeaseAwareQueryRetryDelay,
} from './discovery-run-lease';
import { discoveryActivityTimeouts, timeoutMilliseconds } from './testing/discovery-activity-timeouts';

const MINUTE = 60_000;
const http = (status: number) =>
  new ProviderHttpError({ status, provider: 'gateway', model: 'deepseek-v4-pro' });
const BINDING = {
  authorityId: '11111111-1111-4111-8111-111111111111',
  scopeKey: '22222222-2222-4222-8222-222222222222',
} as never;

function fakeClock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms) };
}

/** A lease read just now with `slackMs` left before the finalization reserve. */
const leaseWithSlack = (slackMs: number) =>
  startDiscoveryRunLease(DISCOVERY_LEASE_FINALIZATION_RESERVE_MS + slackMs, () => 0);

describe('startDiscoveryRunLease', () => {
  it('allows a unit only while it still ends before the finalization reserve, on the worker clock since the read', () => {
    const clock = fakeClock();
    const lease = startDiscoveryRunLease(DISCOVERY_LEASE_FINALIZATION_RESERVE_MS + 25 * MINUTE, clock.now);

    expect(lease.slackMs()).toBe(25 * MINUTE);
    expect(lease.allows(25 * MINUTE)).toBe(true);
    clock.advance(1);
    expect(lease.allows(25 * MINUTE)).toBe(false);
    expect(lease.allows(24 * MINUTE)).toBe(true);
    clock.advance(25 * MINUTE);
    expect(lease.slackMs()).toBe(-1);
    expect(lease.allows(0)).toBe(false);
  });

  it('places no bound without a lease reader', () => {
    expect(UNBOUNDED_DISCOVERY_RUN_LEASE.allows(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(UNBOUNDED_DISCOVERY_RUN_LEASE.slackMs()).toBe(Infinity);
  });
});

describe('discovery lease units', () => {
  const timeouts = discoveryActivityTimeouts();
  const proxyTimeout = (activity: string) => Math.max(...timeouts.get(activity)!.map(timeoutMilliseconds));

  it('cover the longest piece of work each stage may start', () => {
    // One query attempt runs at most its proxy's start-to-close timeout.
    expect(DISCOVERY_LEASE_UNIT_MS.query).toBeGreaterThanOrEqual(proxyTimeout('executeQuery'));
    // One fit judgment: a structured answer may take two gateway requests at the request ceiling.
    expect(DISCOVERY_LEASE_UNIT_MS.fit).toBeGreaterThanOrEqual(
      MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND * MAX_MODEL_GATEWAY_REQUEST_TIMEOUT_MS,
    );
    // One profile: three 75-second page reads and the same structured answer.
    expect(DISCOVERY_LEASE_UNIT_MS.websiteProfile).toBeGreaterThanOrEqual(
      3 * 75_000 + MODEL_STRUCTURED_OUTPUT_WIRE_UPPER_BOUND * MAX_MODEL_GATEWAY_REQUEST_TIMEOUT_MS,
    );
    // One enrichment company stays within the enrichment proxy's timeout.
    expect(DISCOVERY_LEASE_UNIT_MS.enrich).toBeGreaterThanOrEqual(proxyTimeout('enrichRun'));
  });

  it('leave the finalization reserve for the activities that never stop for the lease', () => {
    // canonicalizeRun, enqueuePatentLookupsForRun and finalizeRun run on the 2-minute proxy.
    const unchecked = ['canonicalizeRun', 'enqueuePatentLookupsForRun', 'finalizeRun'].map(proxyTimeout);
    expect(unchecked.reduce((sum, timeout) => sum + timeout, 0)).toBeLessThanOrEqual(
      DISCOVERY_LEASE_FINALIZATION_RESERVE_MS,
    );
  });
});

describe('prismaDiscoveryRunLeaseReader', () => {
  function prismaReturning(rows: unknown[]) {
    const queryRaw = vi.fn(async (..._args: unknown[]) => rows);
    const withWorkspace = vi.fn(async (_workspaceId: string, callback: (tx: unknown) => unknown) =>
      callback({ $queryRaw: queryRaw }),
    );
    return { prisma: { withWorkspace } as never, queryRaw, withWorkspace };
  }

  it("reads the time left on the run's own grant the way attest judges it, on the database clock", async () => {
    const { prisma, queryRaw, withWorkspace } = prismaReturning([{ remaining_ms: 4_200_000.5 }]);

    await expect(prismaDiscoveryRunLeaseReader(prisma)(BINDING)).resolves.toBe(4_200_000.5);

    expect(withWorkspace).toHaveBeenCalledWith('22222222-2222-4222-8222-222222222222', expect.any(Function));
    const [strings, ...values] = queryRaw.mock.calls[0]!;
    const sql = (strings as TemplateStringsArray).join('?');
    expect(sql).toContain('COALESCE(admission_lease_expires_at, expires_at)');
    expect(sql).toContain('statement_timestamp()');
    expect(sql).toContain("authority_kind = 'WORKSPACE_GRANT'");
    expect(values).toEqual(['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']);
  });

  it.each([
    ['no row (another workspace, or no grant)', []],
    ['two rows', [{ remaining_ms: 1 }, { remaining_ms: 2 }]],
    ['a value that is not a number', [{ remaining_ms: null }]],
    ['a value that is not finite', [{ remaining_ms: Number.NaN }]],
  ])('fails closed on %s', async (_label, rows) => {
    const { prisma } = prismaReturning(rows);

    await expect(prismaDiscoveryRunLeaseReader(prisma)(BINDING)).rejects.toEqual(
      new ExecutionBudgetGrantError('EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE'),
    );
  });
});

describe('upstreamWaitFitsLease', () => {
  it('fits the wait and one more unit of work, or not', () => {
    // Outside an Activity a call counts as the first of three attempts: it waits 5 minutes.
    expect(upstreamWaitFitsLease(http(503), leaseWithSlack(15 * MINUTE), 10 * MINUTE)).toBe(true);
    expect(upstreamWaitFitsLease(http(503), leaseWithSlack(15 * MINUTE - 1), 10 * MINUTE)).toBe(false);
  });

  it('changes nothing for an error that makes no wait', () => {
    expect(upstreamWaitFitsLease(http(504), leaseWithSlack(0), 10 * MINUTE)).toBe(true);
    expect(upstreamWaitFitsLease(new Error('boom'), leaseWithSlack(-1), 10 * MINUTE)).toBe(true);
  });
});

describe('withLeaseAwareQueryRetryDelay', () => {
  it('keeps the upstream wait when it still leaves room for another query', () => {
    expect(
      withLeaseAwareQueryRetryDelay(http(503), leaseWithSlack(5 * MINUTE + DISCOVERY_LEASE_UNIT_MS.query)),
    ).toMatchObject({ nextRetryDelay: '5 minutes' });
  });

  it('starts the next attempt just past the query deadline when the wait does not fit, so it stops for the lease', () => {
    const slack = DISCOVERY_LEASE_UNIT_MS.query + 3 * MINUTE;
    const failure = withLeaseAwareQueryRetryDelay(http(521), leaseWithSlack(slack));

    expect(failure).toBeInstanceOf(ApplicationFailure);
    expect(failure).toMatchObject({
      type: 'ProviderHttpError',
      nonRetryable: false,
      nextRetryDelay: 3 * MINUTE + 1_000,
    });
    // The next attempt then finds no room for a query and ends it with a zero receipt.
    expect(leaseWithSlack(slack - (3 * MINUTE + 1_000)).allows(DISCOVERY_LEASE_UNIT_MS.query)).toBe(false);
  });

  it('retries after a second at least when the query deadline has already passed', () => {
    expect(withLeaseAwareQueryRetryDelay(http(429), leaseWithSlack(MINUTE))).toMatchObject({
      nextRetryDelay: 1_000,
    });
  });

  it('returns any other error unchanged', () => {
    const error = http(504);
    expect(withLeaseAwareQueryRetryDelay(error, leaseWithSlack(0))).toBe(error);
  });
});
