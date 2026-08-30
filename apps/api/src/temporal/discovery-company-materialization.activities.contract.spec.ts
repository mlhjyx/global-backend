import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const activitySource = readFileSync(
  new URL('./discovery.activities.ts', import.meta.url),
  'utf8',
);
const workflowSource = readFileSync(
  new URL('./discovery.workflow.ts', import.meta.url),
  'utf8',
);
const governedModuleUrl = new URL(
  './discovery-company-materialization.ts',
  import.meta.url,
);
const governedSource = existsSync(governedModuleUrl)
  ? readFileSync(governedModuleUrl, 'utf8')
  : '';

function executableBody(source: string, symbol: string): string {
  const file = ts.createSourceFile(
    `${symbol}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let body = '';
  const visit = (node: ts.Node): void => {
    if (body) return;
    if (
      ts.isFunctionDeclaration(node) &&
      node.name?.text === symbol &&
      node.body
    ) {
      body = node.body.getText(file);
      return;
    }
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === symbol &&
      node.body
    ) {
      body = node.body.getText(file);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return body;
}

function caseClauseBody(
  source: string,
  symbol: string,
  label: string,
): string {
  const body = executableBody(source, symbol);
  const file = ts.createSourceFile(
    `${symbol}-${label}.ts`,
    body,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let clause = '';
  const visit = (node: ts.Node): void => {
    if (clause) return;
    if (
      ts.isCaseClause(node) &&
      ts.isStringLiteral(node.expression) &&
      node.expression.text === label
    ) {
      clause = node.statements.map((statement) => statement.getText(file)).join('\n');
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return clause;
}

function expectOrdered(source: string, controls: readonly string[]): void {
  let cursor = -1;
  for (const control of controls) {
    const next = source.indexOf(control, cursor + 1);
    expect(
      next,
      `${control} must occur after the prior governed control`,
    ).toBeGreaterThan(cursor);
    cursor = next;
  }
}

const lockedReference = `
async function replayDiscoveryCompanyMaterializationRunReceipt(runReceipt) {
  return runReceipt.summary;
}

async function executeDiscoveryCompanyMaterialization(input) {
  const binding = parseExecutionBudgetBinding(input.executionBudget);
  const admission = await admitDiscoveryCompanyMaterialization(input, binding);
  if (admission.mode === 'LEGACY') {
    return canonicalizeLegacyDiscoveryRun(input);
  }
  let inspection = await inspectDiscoveryCompanyMaterialization(input, admission);
  while (true) {
    if (inspection.status === 'REPLAYED') {
      return replayDiscoveryCompanyMaterializationRunReceipt(inspection.runReceipt);
    }
    switch (inspection.nextWork.kind) {
      case 'BATCH': {
        const facts = await lockDiscoveryCompanyMaterializationBatchFacts(inspection.nextWork);
        await appendDiscoveryCompanyMaterializationBatch({
          queryOrdinal: facts.queryOrdinal,
          batchOrdinal: facts.batchOrdinal,
          fenceId: facts.fenceId,
          snapshotSha256: facts.snapshotSha256,
        });
        heartbeatDiscoveryCompanyMaterializationBatch({
          queryOrdinal: facts.queryOrdinal,
          batchOrdinal: facts.batchOrdinal,
        });
        break;
      }
      case 'FINALIZE_QUERY':
        await finalizeDiscoveryCompanyMaterializationQuery(inspection.nextWork);
        break;
      case 'FINALIZE_RUN':
        return finalizeDiscoveryCompanyMaterializationRun(input, admission);
    }
    inspection = await inspectDiscoveryCompanyMaterialization(input, admission);
  }
}

const activities = {
  async canonicalizeRun(args) {
    return executeDiscoveryCompanyMaterialization(args);
  },
};
`;

function assertGovernedPreflight(source: string): void {
  const execution = executableBody(
    source,
    'executeDiscoveryCompanyMaterialization',
  );
  expectOrdered(execution, [
    'parseExecutionBudgetBinding',
    'admitDiscoveryCompanyMaterialization',
    "mode === 'LEGACY'",
    'inspectDiscoveryCompanyMaterialization',
    "status === 'REPLAYED'",
  ]);
  expect(execution).not.toContain('ensureRunBudget');
  expect(execution).not.toContain('attestAuthorized');
  expect(execution).not.toContain('budgetStore');
}

function assertBatchCursorAndFence(source: string): void {
  const execution = executableBody(
    source,
    'executeDiscoveryCompanyMaterialization',
  );
  expect(execution).toContain('inspection.nextWork.kind');
  for (const nextWork of ['BATCH', 'FINALIZE_QUERY', 'FINALIZE_RUN']) {
    expect(execution).toContain(`case '${nextWork}'`);
  }

  const batch = caseClauseBody(
    source,
    'executeDiscoveryCompanyMaterialization',
    'BATCH',
  );
  expectOrdered(batch, [
    'lockDiscoveryCompanyMaterializationBatchFacts',
    'appendDiscoveryCompanyMaterializationBatch',
    'fenceId',
    'snapshotSha256',
    'heartbeatDiscoveryCompanyMaterializationBatch',
  ]);
  expect(batch).toContain('inspection.nextWork');
  expect(batch).not.toContain('finalizeDiscoveryCompanyMaterializationQuery');
  expect(batch).not.toContain('finalizeDiscoveryCompanyMaterializationRun');
  expect(batch).toMatch(
    /heartbeatDiscoveryCompanyMaterializationBatch\([\s\S]{0,240}queryOrdinal[\s\S]{0,120}batchOrdinal/u,
  );

  const finalizeQuery = caseClauseBody(
    source,
    'executeDiscoveryCompanyMaterialization',
    'FINALIZE_QUERY',
  );
  expect(finalizeQuery).toContain(
    'finalizeDiscoveryCompanyMaterializationQuery(inspection.nextWork)',
  );
  expect(finalizeQuery).not.toContain(
    'appendDiscoveryCompanyMaterializationBatch',
  );
  expect(finalizeQuery).not.toContain(
    'lockDiscoveryCompanyMaterializationBatchFacts',
  );

  const finalizeRun = caseClauseBody(
    source,
    'executeDiscoveryCompanyMaterialization',
    'FINALIZE_RUN',
  );
  expect(finalizeRun).toMatch(
    /return\s+finalizeDiscoveryCompanyMaterializationRun\(/u,
  );
  expect(finalizeRun).not.toContain(
    'finalizeDiscoveryCompanyMaterializationQuery',
  );

  expect(execution).toMatch(
    /switch\s*\(inspection\.nextWork\.kind\)[\s\S]*inspection\s*=\s*await\s+inspectDiscoveryCompanyMaterialization/u,
  );
  expect(execution).not.toMatch(/queryOrdinal\s*(?:\+\+|\+=|=\s*[^;]*\+\s*1)/u);
}

describe('canonicalizeRun governed company-materialization source contract', () => {
  it('accepts the locked RED reference orchestration', () => {
    const activity = executableBody(lockedReference, 'canonicalizeRun');
    expect(activity).toContain('executeDiscoveryCompanyMaterialization');
    assertGovernedPreflight(lockedReference);
    assertBatchCursorAndFence(lockedReference);
  });

  it('delegates canonicalizeRun to governed admission and inspect before any BudgetStore access', () => {
    const activity = executableBody(activitySource, 'canonicalizeRun');
    expect(activity).toContain('executeDiscoveryCompanyMaterialization');
    assertGovernedPreflight(governedSource);
  });

  it('keeps the NULL-marker LEGACY branch explicit and isolated from governed writes', () => {
    const execution = executableBody(
      governedSource,
      'executeDiscoveryCompanyMaterialization',
    );
    expect(execution).toMatch(
      /admission\.mode\s*===\s*['"]LEGACY['"][\s\S]{0,240}return\s+canonicalizeLegacyDiscoveryRun\(/u,
    );
    const legacyBranch = execution.slice(
      execution.indexOf("mode === 'LEGACY'"),
      execution.indexOf('inspectDiscoveryCompanyMaterialization'),
    );
    expect(legacyBranch).not.toContain(
      'appendDiscoveryCompanyMaterializationBatch',
    );
    expect(legacyBranch).not.toContain(
      'finalizeDiscoveryCompanyMaterializationRun',
    );
  });

  it('returns the exact persisted run-receipt summary on governed response-loss replay', () => {
    const execution = executableBody(
      governedSource,
      'executeDiscoveryCompanyMaterialization',
    );
    expect(execution).toMatch(
      /inspection\.status\s*===\s*['"]REPLAYED['"][\s\S]{0,240}return\s+replayDiscoveryCompanyMaterializationRunReceipt\(inspection\.runReceipt\)/u,
    );
    const replay = executableBody(
      governedSource,
      'replayDiscoveryCompanyMaterializationRunReceipt',
    );
    expect(replay).toMatch(/^\{\s*return\s+runReceipt\.summary;?\s*\}$/u);
    expect(replay).not.toMatch(/companies\s*:|suppressed\s*:|reduce\(|JSON\.parse/u);
  });

  it('resumes the global query/batch cursor with the same-transaction fence and heartbeats between batches', () => {
    assertBatchCursorAndFence(governedSource);
  });

  it('finalizes an inspected query header before it can ask for a higher-query batch after ACK loss', () => {
    const execution = executableBody(
      governedSource,
      'executeDiscoveryCompanyMaterialization',
    );
    const batch = caseClauseBody(
      governedSource,
      'executeDiscoveryCompanyMaterialization',
      'BATCH',
    );
    const finalizeQuery = caseClauseBody(
      governedSource,
      'executeDiscoveryCompanyMaterialization',
      'FINALIZE_QUERY',
    );
    expect(execution).toContain('switch (inspection.nextWork.kind)');
    expect(batch).not.toContain('finalizeDiscoveryCompanyMaterializationQuery');
    expect(finalizeQuery).toContain(
      'finalizeDiscoveryCompanyMaterializationQuery(inspection.nextWork)',
    );
    expect(execution).toMatch(
      /case\s+['"]FINALIZE_QUERY['"][\s\S]*inspection\s*=\s*await\s+inspectDiscoveryCompanyMaterialization/u,
    );
    expect(execution).not.toMatch(/queryOrdinal\s*(?:\+\+|\+=|=\s*[^;]*\+\s*1)/u);
  });

  it('does not add a Workflow patch or command for governed company materialization', () => {
    expect(workflowSource.match(/acts\.canonicalizeRun\(/gu)).toHaveLength(1);
    expect(workflowSource).not.toMatch(
      /patched\([^)]*company-materialization|COMPANY_MATERIALIZATION_PATCH/u,
    );
    for (const forbiddenCommand of [
      'admitDiscoveryCompanyMaterialization',
      'inspectDiscoveryCompanyMaterialization',
      'lockDiscoveryCompanyMaterializationBatchFacts',
      'appendDiscoveryCompanyMaterializationBatch',
      'finalizeDiscoveryCompanyMaterializationQuery',
      'finalizeDiscoveryCompanyMaterializationRun',
    ]) {
      expect(workflowSource).not.toContain(forbiddenCommand);
    }
  });
});
