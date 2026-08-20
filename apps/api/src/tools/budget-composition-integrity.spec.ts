import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('managed durable budget composition', () => {
  it('injects the one Worker store into taxonomy, acquisition and intent activities', async () => {
    const source = await readFile(new URL('../temporal/worker.ts', import.meta.url), 'utf8');
    expect(source).toMatch(/new TaxonomyResolver\([\s\S]*?budgetStore,[\s\S]*?\)/);
    expect(source).toMatch(/createAcquisitionActivities\(\{[\s\S]*?budgetStore/);
    expect(source).toMatch(/createIntentActivities\(\{[\s\S]*?budgetStore/);
  });

  it('exports and injects the same managed BudgetStore into ICP taxonomy cold paths', async () => {
    const [moduleSource, icpSource] = await Promise.all([
      readFile(new URL('../model-gateway/model-gateway.module.ts', import.meta.url), 'utf8'),
      readFile(new URL('../icp/icp.service.ts', import.meta.url), 'utf8'),
    ]);
    expect(moduleSource).toContain('exports: [ModelGateway, TOOL_BUDGET_STORE]');
    expect(icpSource).toContain('@Inject(TOOL_BUDGET_STORE)');
    expect(icpSource).toMatch(/new TaxonomyResolver\([^)]*this\.budgetStore\)/);
  });
});
