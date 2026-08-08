import { describe, expect, it, vi } from 'vitest';
import {
  API_READINESS_PROBE_NAMES,
  ReadinessService,
  type ReadinessCheckName,
  type ReadinessProbePort,
  type ReadinessProbeResult,
} from './readiness.service';

const NOW = '2026-08-07T13:00:00.000Z';

const PASS_BY_NAME: Readonly<Record<ReadinessCheckName, ReadinessProbeResult>> =
  Object.freeze({
    configuration: { status: 'PASS', code: 'CONFIGURATION_VALID' },
    build_identity: { status: 'PASS', code: 'BUILD_IDENTITY_VERIFIED' },
    database: {
      status: 'PASS',
      code: 'DATABASE_REACHABLE_AND_MIGRATED',
    },
    temporal: { status: 'PASS', code: 'TEMPORAL_REACHABLE' },
    worker_heartbeat: { status: 'PASS', code: 'WORKER_HEARTBEAT_VERIFIED' },
    outbox_relay: { status: 'PASS', code: 'OUTBOX_RELAY_VERIFIED' },
    gateway_admission: {
      status: 'PASS',
      code: 'GATEWAY_ADMISSION_VERIFIED',
    },
  });

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

function fullProbeSet(
  resultOverrides: Partial<
    Record<
      ReadinessCheckName,
      ReadinessProbeResult | (() => Promise<ReadinessProbeResult>)
    >
  > = {},
  requiredOverrides: Partial<Record<ReadinessCheckName, boolean>> = {},
): ReadinessProbePort[] {
  return API_READINESS_PROBE_NAMES.map((name) =>
    probe(
      name,
      requiredOverrides[name] ?? true,
      resultOverrides[name] ?? PASS_BY_NAME[name],
    ),
  );
}

function service(
  probes: readonly ReadinessProbePort[],
  deploymentStage: 'development' | 'pilot' | 'production' = 'pilot',
  timeoutMs = 25,
): ReadinessService {
  return new ReadinessService(probes, {
    deploymentStage,
    timeoutMs,
    now: () => NOW,
  });
}

describe('ReadinessService', () => {
  it('returns READY only when all seven required pilot checks pass', async () => {
    await expect(service(fullProbeSet()).check()).resolves.toMatchObject({
      status: 'READY',
      service: 'global-api',
      ts: NOW,
      checks: API_READINESS_PROBE_NAMES.map((name) => ({ name })),
    });
  });

  it('makes an unavailable required proof source an explicit NOT_READY gate', async () => {
    await expect(
      service(
        fullProbeSet({
          worker_heartbeat: {
            status: 'UNVERIFIED',
            code: 'PROOF_SOURCE_UNAVAILABLE',
          },
        }),
      ).check(),
    ).resolves.toMatchObject({
      status: 'NOT_READY',
      checks: expect.arrayContaining([
        {
          name: 'worker_heartbeat',
          required: true,
          status: 'UNVERIFIED',
          code: 'PROOF_SOURCE_UNAVAILABLE',
        },
      ]),
    });
  });

  it('rejects missing, extra, duplicate, and wrong-required probe contracts', () => {
    const full = fullProbeSet();
    expect(() => service([])).toThrow(/missing.*configuration/i);
    expect(() => service(full.slice(1))).toThrow(/missing.*configuration/i);
    expect(() =>
      service([
        ...full,
        probe('configuration', true, PASS_BY_NAME.configuration),
      ]),
    ).toThrow(/duplicate.*configuration/i);
    expect(() =>
      service(
        fullProbeSet({}, { build_identity: false }),
        'pilot',
      ),
    ).toThrow(/build_identity.*required/i);
    expect(() =>
      service(
        fullProbeSet({}, { build_identity: true }),
        'development',
      ),
    ).toThrow(/build_identity.*optional/i);
    expect(() =>
      service([
        ...full.slice(0, -1),
        {
          name: 'unexpected_probe',
          required: true,
          check: vi.fn(),
        } as unknown as ReadinessProbePort,
      ]),
    ).toThrow(/unexpected.*unexpected_probe|missing.*gateway_admission/i);
  });

  it('returns checks in canonical order independent of provider arrival order', async () => {
    const result = await service([...fullProbeSet()].reverse()).check();
    expect(result.checks.map(({ name }) => name)).toEqual(
      API_READINESS_PROBE_NAMES,
    );
  });

  it('maps dependency failures to a closed code without leaking the thrown message', async () => {
    const result = await service(
      fullProbeSet({
        database: async () => {
          throw new Error('postgresql://user:secret@example.invalid/private');
        },
      }),
    ).check();
    expect(result).toMatchObject({
      status: 'NOT_READY',
      checks: expect.arrayContaining([
        {
          name: 'database',
          required: true,
          status: 'FAIL',
          code: 'PROBE_FAILED',
        },
      ]),
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('postgresql://');
  });

  it('rejects a valid code paired with an inconsistent status', async () => {
    await expect(
      service(
        fullProbeSet({
          gateway_admission: {
            status: 'PASS',
            code: 'PROOF_SOURCE_UNAVAILABLE',
          },
        }),
      ).check(),
    ).resolves.toMatchObject({
      status: 'NOT_READY',
      checks: expect.arrayContaining([
        {
          name: 'gateway_admission',
          required: true,
          status: 'FAIL',
          code: 'PROBE_FAILED',
        },
      ]),
    });
  });

  it('bounds stalled probes and fails closed with PROBE_TIMEOUT', async () => {
    await expect(
      service(
        fullProbeSet({
          temporal: () =>
            new Promise<ReadinessProbeResult>(() => undefined),
        }),
        'pilot',
        5,
      ).check(),
    ).resolves.toMatchObject({
      status: 'NOT_READY',
      checks: expect.arrayContaining([
        {
          name: 'temporal',
          required: true,
          status: 'FAIL',
          code: 'PROBE_TIMEOUT',
        },
      ]),
    });
  });
});
