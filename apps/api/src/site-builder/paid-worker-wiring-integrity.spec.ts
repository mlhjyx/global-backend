import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const apiRoot = path.resolve(import.meta.dirname, '../..');
const worker = readFileSync(
  path.join(apiRoot, 'src/temporal/worker.ts'),
  'utf8',
);
const factory = readFileSync(
  path.join(apiRoot, 'src/tools/tool-broker.factory.ts'),
  'utf8',
);

describe('R4-B production worker paid-ledger wiring', () => {
  it('shares one durable ledger across gateway, ToolBroker and Site Builder activities', () => {
    expect(worker).toMatch(
      /const costLedger = new SiteBuildCostLedger\(prisma\)/,
    );
    expect(worker).toContain('gateway.paidLedger = costLedger');
    expect(worker).toMatch(
      /buildToolBroker\(\{ sourcePolicyReader, paidLedger: costLedger \}\)/,
    );
    expect(worker).toMatch(
      /createSiteBuilderActivities\(\{[\s\S]*?costLedger,[\s\S]*?\}\)/,
    );
    expect(factory).toContain('paidLedger?: SiteBuildCostLedger');
    expect(factory).toMatch(
      /new ToolBroker\(\{[\s\S]*paidLedger: deps\?\.paidLedger/,
    );
  });
});
