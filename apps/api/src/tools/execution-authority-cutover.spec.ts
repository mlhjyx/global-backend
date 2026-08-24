import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const apiRoot = resolve(import.meta.dirname, '..');
const repositoryRoot = resolve(apiRoot, '../../..');

async function productTypeScriptFiles(directory = apiRoot): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'site-builder') continue;
      files.push(...await productTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(path);
    }
  }
  return files;
}

describe('Task 6 execution authority cutover', () => {
  it('exposes one authority-only budget API with native microusd lifecycle fields', async () => {
    const source = await readFile(resolve(apiRoot, 'tools/budget-store.ts'), 'utf8');

    expect(source).not.toContain('openAuthorized(');
    expect(source).not.toContain('capCents');
    expect(source).not.toContain('BudgetMicrousdReservationRequest');
    expect(source).not.toContain('reserveMicrousd(');
    expect(source).not.toContain('settleMicrousd(');
    expect(source).not.toContain('releaseMicrousd(');
    expect(source).not.toContain('statusMicrousd(');
    expect(source).not.toContain('closeMicrousd(');
    expect(source).not.toContain('InMemoryBudgetStoreAdapter');
    expect(source).toMatch(/open\(input:\s*\{[\s\S]*?authorityId:\s*string;[\s\S]*?scopeKey:\s*string;/);
    expect(source).toContain('estimatedMicrousd: bigint');
    expect(source).toContain('chargedMicrousd: bigint');
    expect(source).toContain('remainingMicrousd: bigint');
  });

  it('removes backend-authored product caps and all legacy automatic opens', async () => {
    const files = await productTypeScriptFiles();
    const banned = [
      'RUN_BUDGET_CENTS',
      'SWEEP_BUDGET_CENTS',
      'runBudgetCents',
      'sweepBudgetCents',
      'capCents',
      'budgetCapCents',
      '.openAuthorized(',
      'InMemoryBudgetStoreAdapter',
    ];
    const findings: string[] = [];
    for (const path of files) {
      const source = await readFile(path, 'utf8');
      for (const token of banned) {
        if (source.includes(token)) findings.push(`${path.slice(repositoryRoot.length + 1)}:${token}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it('wires ledger-authored receipts, ACK, expected facts and subject binding without a ToolBroker fake fallback', async () => {
    const [broker, manifest, artifactService] = await Promise.all([
      readFile(resolve(apiRoot, 'tools/tool-broker.ts'), 'utf8'),
      readFile(resolve(repositoryRoot, 'docs/governance/durable-result-strategies.json'), 'utf8'),
      readFile(resolve(apiRoot, 'durable-results/artifact/generic-operation-artifact.service.ts'), 'utf8'),
    ]);
    const policy = JSON.parse(manifest) as {
      cutoverFence?: string;
      physicalExecutionWiring?: { status?: string };
      artifactPhysicalExecution?: {
        status?: string;
        deniedBeforeWire?: boolean;
        inlineFallbackAllowed?: boolean;
      };
      receipt?: { author?: string; attachedAtRuntime?: boolean };
      tools?: Array<{
        resultStrategy?: string;
        domainAck?: { mode?: string };
      }>;
      modelTasks?: Array<{ domainAck?: { mode?: string } }>;
    };

    expect(broker).not.toContain('BudgetLedger');
    expect(broker).not.toContain('InMemoryBudgetStoreAdapter');
    expect(broker).toContain('durableReceipt');
    expect(artifactService).toContain('artifactExecutionReceiptFacts');
    expect(artifactService).toContain('domainAck');
    expect(artifactService).toContain('subjectRef');
    expect(broker).toContain('GENERIC_OPERATION_ARTIFACT_SUBJECT_BINDING_HOLD');
    expect(policy.cutoverFence).toBe('TASK_6_AUTHORITY_BOUND_TYPED_EXECUTION_ARTIFACT_HOLD');
    expect(policy.physicalExecutionWiring?.status).toBe('PARTIAL_HOLD');
    expect(policy.artifactPhysicalExecution).toMatchObject({
      status: 'SUBJECT_BINDING_HOLD',
      deniedBeforeWire: true,
      inlineFallbackAllowed: false,
    });
    expect(policy.receipt).toMatchObject({ author: 'trusted-ledger', attachedAtRuntime: true });
    expect((policy.tools ?? []).every((entry) => entry.domainAck?.mode === (
      entry.resultStrategy === 'artifact_reference'
        ? 'SUBJECT_BINDING_HOLD'
        : 'AUTHORITY_BOUND_ACK_REPOSITORY'
    ))).toBe(true);
    expect((policy.modelTasks ?? []).every(
      (entry) => entry.domainAck?.mode === 'AUTHORITY_BOUND_ACK_REPOSITORY',
    )).toBe(true);
  });
});
