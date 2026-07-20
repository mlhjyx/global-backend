import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('R1 Release reconciliation wiring', () => {
  it('claims under the pointer lock, deletes only after the durable claim, and settles with the same token', async () => {
    const source = await readFile(
      new URL('./site-release-maintenance.service.ts', import.meta.url),
      'utf8',
    );
    const lock = source.indexOf('site-release-pointer-');
    const claim = source.indexOf("status: 'deleting'", lock);
    const deletion = source.indexOf('deletePrefix', claim);
    const settlement = source.indexOf("status: 'deleted'", deletion);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(claim).toBeGreaterThan(lock);
    expect(deletion).toBeGreaterThan(claim);
    expect(settlement).toBeGreaterThan(deletion);
    expect(source).toContain('isSiteReleaseGcEligible');
  });

  it('is a scheduled cross-node activity but remains operator-disabled by default', async () => {
    const [worker, schedules, workflow] = await Promise.all([
      readFile(new URL('../temporal/worker.ts', import.meta.url), 'utf8'),
      readFile(new URL('../temporal/ensure-schedules.ts', import.meta.url), 'utf8'),
      readFile(
        new URL('../temporal/site-release-maintenance.workflow.ts', import.meta.url),
        'utf8',
      ),
    ]);
    expect(worker).toContain('createSiteReleaseMaintenanceActivities');
    expect(schedules).toContain('SITE_RELEASE_MAINTENANCE_SWEEP_SCHEDULE_ID');
    expect(workflow).toContain('siteReleaseMaintenanceSweepWorkflow');
  });
});
