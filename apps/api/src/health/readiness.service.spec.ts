import { describe, expect, it, vi } from 'vitest';
import {
  ReadinessService,
  type ReadinessCheckName,
  type ReadinessProbePort,
  type ReadinessProbeResult,
} from './readiness.service';

const NOW = '2026-08-07T13:00:00.000Z';

function probe(
  name: ReadinessCheckName,
  required: boolean,
  result: ReadinessProbeResult | (() => Promise<ReadinessProbeResult>),
): ReadinessProbePort {
  return {
    name,
    required,
    check: vi.fn(async () =>
      typeof result === 'function' ? result() : Promise.resolve(result),
    ),
  };
}

describe('ReadinessService', () => {
  it('returns READY only when every required typed check passes', async () => {
    const service = new ReadinessService(
      [
        probe('configuration', true, { status: 'PASS', code: 'CONFIGURATION_VALID' }),
        probe('build_identity', true, {
          status: 'PASS',
          code: 'BUILD_IDENTITY_VERIFIED',
        }),
        probe('database', true, { status: 'PASS', code: 'DATABASE_REACHABLE' }),
        probe('temporal', true, { status: 'PASS', code: 'TEMPORAL_REACHABLE' }),
        probe('worker_heartbeat', false, {
          status: 'UNVERIFIED',
          code: 'PROOF_SOURCE_UNAVAILABLE',
        }),
      ],
      { timeoutMs: 25, now: () => NOW },
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'READY',
      service: 'global-api',
      ts: NOW,
    });
  });

  it('makes an unavailable required proof source an explicit NOT_READY gate', async () => {
    const service = new ReadinessService(
      [
        probe('database', true, { status: 'PASS', code: 'DATABASE_REACHABLE' }),
        probe('worker_heartbeat', true, {
          status: 'UNVERIFIED',
          code: 'PROOF_SOURCE_UNAVAILABLE',
        }),
      ],
      { timeoutMs: 25, now: () => NOW },
    );

    await expect(service.check()).resolves.toEqual({
      status: 'NOT_READY',
      service: 'global-api',
      ts: NOW,
      checks: [
        {
          name: 'database',
          required: true,
          status: 'PASS',
          code: 'DATABASE_REACHABLE',
        },
        {
          name: 'worker_heartbeat',
          required: true,
          status: 'UNVERIFIED',
          code: 'PROOF_SOURCE_UNAVAILABLE',
        },
      ],
    });
  });

  it('maps dependency failures to a closed code without leaking the thrown message', async () => {
    const service = new ReadinessService(
      [
        probe('database', true, async () => {
          throw new Error('postgresql://user:secret@example.invalid/private');
        }),
      ],
      { timeoutMs: 25, now: () => NOW },
    );

    const result = await service.check();
    expect(result).toMatchObject({
      status: 'NOT_READY',
      checks: [
        {
          name: 'database',
          required: true,
          status: 'FAIL',
          code: 'PROBE_FAILED',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('postgresql://');
  });

  it('bounds stalled probes and fails closed with PROBE_TIMEOUT', async () => {
    const service = new ReadinessService(
      [
        probe(
          'temporal',
          true,
          () => new Promise<ReadinessProbeResult>(() => undefined),
        ),
      ],
      { timeoutMs: 5, now: () => NOW },
    );

    await expect(service.check()).resolves.toMatchObject({
      status: 'NOT_READY',
      checks: [
        {
          name: 'temporal',
          required: true,
          status: 'FAIL',
          code: 'PROBE_TIMEOUT',
        },
      ],
    });
  });
});
