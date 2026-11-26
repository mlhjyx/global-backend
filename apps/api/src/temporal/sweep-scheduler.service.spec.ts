import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTOMER_SWEEPS,
  SweepSchedulerService,
  parseSweepDuration,
} from './sweep-scheduler.service';

function makeService(startImpl?: (type: string, options: Record<string, unknown>) => Promise<unknown>) {
  const start = vi.fn(startImpl ?? (async () => ({})));
  const service = new SweepSchedulerService({
    client: { workflow: { start } },
  } as never);
  return { service, start };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('R7-A 周期 sweep 调度器', () => {
  it('parses duration strings used by the sweep envs', () => {
    expect(parseSweepDuration('90s')).toBe(90_000);
    expect(parseSweepDuration('5m')).toBe(300_000);
    expect(parseSweepDuration('24h')).toBe(86_400_000);
    expect(parseSweepDuration('7d')).toBe(604_800_000);
    expect(parseSweepDuration('nonsense')).toBeNull();
    expect(parseSweepDuration(undefined)).toBeNull();
  });

  it('starts every customer sweep once per period bucket with a deduplicating workflow id', async () => {
    vi.stubEnv('BACKLOG_SWEEP_EVERY', '24h');
    const { service, start } = makeService();
    const now = new Date('2026-11-04T05:00:00Z');

    await service.tick(now);
    await service.tick(now); // 同一周期：REJECT_DUPLICATE 去重由 Temporal 保证，调用照发

    const backlogCalls = start.mock.calls.filter(([type]) => type === 'backlogSweepWorkflow');
    expect(backlogCalls).toHaveLength(2);
    const expectedPeriod = Math.floor(now.getTime() / 86_400_000);
    for (const [, options] of backlogCalls) {
      expect((options as { workflowId: string }).workflowId).toBe(`backlog-sweep-${expectedPeriod}`);
      expect((options as { workflowIdReusePolicy: unknown }).workflowIdReusePolicy).toBeDefined();
      expect((options as { taskQueue: string }).taskQueue).toBe('understanding');
    }
    expect(start.mock.calls.length).toBe(CUSTOMER_SWEEPS.length * 2);
  });

  it('uses the next bucket id in the next period', async () => {
    vi.stubEnv('RAW_RETENTION_SWEEP_EVERY', '24h');
    const { service, start } = makeService();
    await service.tick(new Date('2026-11-04T05:00:00Z'));
    await service.tick(new Date('2026-11-05T05:00:00Z'));
    const ids = start.mock.calls
      .filter(([type]) => type === 'rawRetentionSweepWorkflow')
      .map(([, options]) => (options as { workflowId: string }).workflowId);
    expect(new Set(ids).size).toBe(2);
  });

  it('treats an already-started bucket as satisfied and keeps going', async () => {
    const { service, start } = makeService(async () => {
      throw new Error('WorkflowExecutionAlreadyStartedError');
    });
    await expect(service.tick(new Date('2026-11-04T05:00:00Z'))).resolves.toBeUndefined();
    expect(start.mock.calls.length).toBe(CUSTOMER_SWEEPS.length);
  });

  it('keeps starting other sweeps when one fails outright', async () => {
    const { service, start } = makeService(async (type) => {
      if (type === 'backlogSweepWorkflow') throw new Error('connection reset');
      return {};
    });
    await expect(service.tick(new Date('2026-11-04T05:00:00Z'))).resolves.toBeUndefined();
    expect(start.mock.calls.length).toBe(CUSTOMER_SWEEPS.length);
  });

  it('does nothing when the scheduler is disabled', async () => {
    vi.stubEnv('SWEEP_SCHEDULER_ENABLED', 'off');
    const { service, start } = makeService();
    await service.onModuleInit();
    service.onModuleDestroy();
    expect(start).not.toHaveBeenCalled();
  });

  it('never schedules the four paused platform schedules', () => {
    const ids = CUSTOMER_SWEEPS.map((sweep) => sweep.scheduleId);
    expect(ids).toContain('seller-document-pending-cleanup');
    for (const paused of ['acq-sweep', 'intent-sweep', 'patents-cache-refresh', 'sanctions-refresh']) {
      expect(ids).not.toContain(paused);
    }
  });

  it('skips the 3 Site Builder sweeps when SITE_BUILDER_ENABLED=false while dispatching all 6 acquisition/compliance sweeps', async () => {
    vi.stubEnv('SITE_BUILDER_ENABLED', 'false');
    const { service, start } = makeService();
    await service.tick(new Date('2026-11-04T05:00:00Z'));

    const dispatchedIds = start.mock.calls.map(
      ([, options]) => (options as { workflowId: string }).workflowId,
    );
    expect(dispatchedIds).toHaveLength(6);
    expect(dispatchedIds.some((id) => id.startsWith('site-builder-cost-reconciliation-'))).toBe(false);
    expect(dispatchedIds.some((id) => id.startsWith('site-builder-kb-recovery-'))).toBe(false);
    expect(dispatchedIds.some((id) => id.startsWith('site-builder-release-maintenance-'))).toBe(false);
    expect(dispatchedIds.some((id) => id.startsWith('backlog-sweep-'))).toBe(true);
    expect(dispatchedIds.some((id) => id.startsWith('external-intent-sweep-'))).toBe(true);
    expect(dispatchedIds.some((id) => id.startsWith('raw-source-retention-'))).toBe(true);
    expect(dispatchedIds.some((id) => id.startsWith('tool-budget-reconciliation-'))).toBe(true);
    expect(dispatchedIds.some((id) => id.startsWith('discovery-stale-run-sweep-'))).toBe(true);
    expect(dispatchedIds.some((id) => id.startsWith('seller-document-pending-cleanup-'))).toBe(true);

    vi.stubEnv('SITE_BUILDER_ENABLED', 'true');
    const { service: enabledSvc, start: enabledStart } = makeService();
    await enabledSvc.tick(new Date('2026-11-04T05:00:00Z'));
    expect(enabledStart.mock.calls).toHaveLength(CUSTOMER_SWEEPS.length);
  });
});
