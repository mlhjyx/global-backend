import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const WORKFLOW = join(import.meta.dirname, '..', 'discovery.workflow.ts');

/** Maps each activity the discovery workflow calls to the startToCloseTimeout of the proxy it is called through. */
export function discoveryActivityTimeouts(): Map<string, string[]> {
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

/** A proxy timeout literal ('15 minutes', '30 seconds') in milliseconds. */
export function timeoutMilliseconds(literal: string): number {
  const match = /^(\d+) (seconds?|minutes?)$/u.exec(literal);
  if (!match) throw new Error(`unsupported timeout literal: ${literal}`);
  return Number(match[1]) * (match[2]!.startsWith('minute') ? 60_000 : 1_000);
}
