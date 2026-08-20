import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('site build cost reconciliation worker wiring', () => {
  it('registers a one-minute Temporal schedule and the workflow export', async () => {
    const [constants, schedules, workflows, worker] = await Promise.all([
      readFile(new URL('../temporal/understanding.constants.ts', import.meta.url), 'utf8'),
      readFile(new URL('../temporal/ensure-schedules.ts', import.meta.url), 'utf8'),
      readFile(new URL('../temporal/workflows.ts', import.meta.url), 'utf8'),
      readFile(new URL('../temporal/worker.ts', import.meta.url), 'utf8'),
    ]);

    expect(constants).toContain("'siteBuildCostReconciliationSweepWorkflow'");
    expect(constants).toContain("'site-builder-cost-reconciliation'");
    expect(schedules).toMatch(
      /SITE_BUILD_COST_RECONCILIATION_EVERY'[\s\S]*?everyDefault: '1m'/,
    );
    expect(schedules).toMatch(/isCostReconciliation[\s\S]*?limit: 50/);
    expect(workflows).toContain(
      "export { siteBuildCostReconciliationSweepWorkflow }",
    );
    expect(worker).toMatch(
      /createSiteBuilderActivities\(\{[\s\S]*?costLedger,[\s\S]*?ownerDb,/,
    );
    expect(worker).toContain('createSiteBuildCostReconciliationResolverFromEnv');
    expect(worker).toContain(
      'createSiteBuildCostReconciliationCatalogFromEnv',
    );
    expect(worker).toContain(
      'SITE_BUILD_COST_RECONCILIATION_CATALOG_UNAVAILABLE',
    );
    expect(worker).toContain(
      'gateway.costReconciliationCatalog = costReconciliationCatalog',
    );
    expect(worker).toMatch(
      /createSiteBuilderActivities\(\{[\s\S]*?costReconciliationResolver,/,
    );
  });
});
