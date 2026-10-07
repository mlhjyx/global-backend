import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WORKFLOW = join(import.meta.dirname, 'discovery.workflow.ts');

/** Maps each activity the workflow calls to the startToCloseTimeout of the proxy it is called through. */
function activityTimeouts(): Map<string, string[]> {
  const source = ts.createSourceFile(
    WORKFLOW,
    readFileSync(WORKFLOW, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const proxyTimeouts = new Map<string, string>();
  const callsByActivity = new Map<string, string[]>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === 'proxyActivities'
    ) {
      const [options] = node.initializer.arguments;
      for (const property of options && ts.isObjectLiteralExpression(options) ? options.properties : []) {
        if (
          ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.name) &&
          property.name.text === 'startToCloseTimeout' &&
          ts.isStringLiteral(property.initializer)
        ) {
          proxyTimeouts.set(node.name.text, property.initializer.text);
        }
      }
    }
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression)
    ) {
      const activity = node.expression.name.text;
      callsByActivity.set(activity, [
        ...(callsByActivity.get(activity) ?? []),
        node.expression.expression.text,
      ]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return new Map(
    [...callsByActivity]
      .filter(([, proxies]) => proxies.every((proxy) => proxyTimeouts.has(proxy)))
      .map(([activity, proxies]) => [activity, proxies.map((proxy) => proxyTimeouts.get(proxy)!)]),
  );
}

describe('discovery workflow activity timeouts', () => {
  it('gives query execution and the per-company fit pass the 15-minute model timeout', () => {
    const timeouts = activityTimeouts();
    expect(timeouts.get('executeQuery')).toEqual(['15 minutes']);
    expect(timeouts.get('qualifyFitForRun')).toEqual(['15 minutes']);
  });

  it('keeps the short bookkeeping activities on the 2-minute default', () => {
    const timeouts = activityTimeouts();
    for (const activity of ['resetRunBudget', 'loadPlanQueries', 'canonicalizeRun', 'enrichRun', 'finalizeRun']) {
      expect(timeouts.get(activity), activity).toEqual(['2 minutes']);
    }
  });
});
