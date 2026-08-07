import { Inject, Injectable, Optional } from '@nestjs/common';

export const READINESS_PROBES = Symbol('READINESS_PROBES');
export const READINESS_SERVICE_OPTIONS = Symbol('READINESS_SERVICE_OPTIONS');

export type ReadinessCheckName =
  | 'configuration'
  | 'build_identity'
  | 'database'
  | 'temporal'
  | 'worker_heartbeat'
  | 'outbox_relay'
  | 'gateway_admission';

export type ReadinessCheckStatus = 'PASS' | 'FAIL' | 'UNVERIFIED';

export type ReadinessCheckCode =
  | 'CONFIGURATION_VALID'
  | 'BUILD_IDENTITY_VERIFIED'
  | 'BUILD_IDENTITY_NOT_REQUIRED'
  | 'BUILD_IDENTITY_REQUIRED'
  | 'DATABASE_REACHABLE_AND_MIGRATED'
  | 'DATABASE_MIGRATION_DIRTY'
  | 'MIGRATION_REVISION_MISMATCH'
  | 'DATABASE_REACHABLE_MIGRATION_UNVERIFIED'
  | 'TEMPORAL_REACHABLE'
  | 'PROOF_SOURCE_UNAVAILABLE'
  | 'PROBE_FAILED'
  | 'PROBE_TIMEOUT';

export interface ReadinessProbeResult {
  readonly status: ReadinessCheckStatus;
  readonly code: ReadinessCheckCode;
}

export interface ReadinessProbePort {
  readonly name: ReadinessCheckName;
  readonly required: boolean;
  check(signal?: AbortSignal): Promise<ReadinessProbeResult>;
}

export interface ReadinessCheck extends ReadinessProbeResult {
  readonly name: ReadinessCheckName;
  readonly required: boolean;
}

export interface ReadinessResponse {
  readonly status: 'READY' | 'NOT_READY';
  readonly service: 'global-api';
  readonly ts: string;
  readonly checks: readonly ReadinessCheck[];
}

export interface ReadinessServiceOptions {
  readonly timeoutMs?: number;
  readonly now?: () => string;
}

const DEFAULT_TIMEOUT_MS = 1_000;
const EXPECTED_STATUS_BY_CODE: Readonly<
  Record<ReadinessCheckCode, ReadinessCheckStatus>
> = Object.freeze({
  CONFIGURATION_VALID: 'PASS',
  BUILD_IDENTITY_VERIFIED: 'PASS',
  BUILD_IDENTITY_NOT_REQUIRED: 'UNVERIFIED',
  BUILD_IDENTITY_REQUIRED: 'UNVERIFIED',
  DATABASE_REACHABLE_AND_MIGRATED: 'PASS',
  DATABASE_MIGRATION_DIRTY: 'FAIL',
  MIGRATION_REVISION_MISMATCH: 'FAIL',
  DATABASE_REACHABLE_MIGRATION_UNVERIFIED: 'UNVERIFIED',
  TEMPORAL_REACHABLE: 'PASS',
  PROOF_SOURCE_UNAVAILABLE: 'UNVERIFIED',
  PROBE_FAILED: 'FAIL',
  PROBE_TIMEOUT: 'FAIL',
});

function isClosedResult(result: ReadinessProbeResult): boolean {
  return EXPECTED_STATUS_BY_CODE[result.code] === result.status;
}

function failedCheck(
  probe: ReadinessProbePort,
  code: 'PROBE_FAILED' | 'PROBE_TIMEOUT',
): ReadinessCheck {
  return Object.freeze({
    name: probe.name,
    required: probe.required,
    status: 'FAIL',
    code,
  });
}

@Injectable()
export class ReadinessService {
  private readonly probes: readonly ReadinessProbePort[];
  private readonly timeoutMs: number;
  private readonly now: () => string;

  constructor(
    @Inject(READINESS_PROBES) probes: readonly ReadinessProbePort[],
    @Optional()
    @Inject(READINESS_SERVICE_OPTIONS)
    options: ReadinessServiceOptions = {},
  ) {
    this.probes = Object.freeze([...probes]);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date().toISOString());

    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs <= 0 ||
      this.timeoutMs > 10_000
    ) {
      throw new Error(
        'readiness probe timeout must be an integer between 1 and 10000ms',
      );
    }
    const names = new Set(this.probes.map((probe) => probe.name));
    if (names.size !== this.probes.length) {
      throw new Error('readiness probe names must be unique');
    }
  }

  async check(): Promise<ReadinessResponse> {
    const checks = Object.freeze(
      await Promise.all(this.probes.map((probe) => this.run(probe))),
    );
    const status = checks.every(
      (check) => !check.required || check.status === 'PASS',
    )
      ? 'READY'
      : 'NOT_READY';

    return Object.freeze({
      status,
      service: 'global-api',
      ts: this.now(),
      checks,
    });
  }

  private async run(probe: ReadinessProbePort): Promise<ReadinessCheck> {
    const controller = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<ReadinessCheck>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(failedCheck(probe, 'PROBE_TIMEOUT'));
      }, this.timeoutMs);
      timer.unref();
    });
    const observation = Promise.resolve()
      .then(() => probe.check(controller.signal))
      .then((result): ReadinessCheck => {
        if (!isClosedResult(result)) return failedCheck(probe, 'PROBE_FAILED');
        return Object.freeze({
          name: probe.name,
          required: probe.required,
          ...result,
        });
      })
      .catch(() => failedCheck(probe, 'PROBE_FAILED'));

    try {
      return await Promise.race([observation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
