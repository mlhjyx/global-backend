import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

const WORKFLOW = join(import.meta.dirname, '..', 'discovery.workflow.ts');

interface ProxyOptions {
  startToCloseTimeout?: string;
  maximumAttempts?: number;
}

/** Reads the discovery workflow's activity proxies and which proxy each activity is called through. */
function readWorkflow(): { proxies: Map<string, ProxyOptions>; callsByActivity: Map<string, string[]> } {
  const source = ts.createSourceFile(
    WORKFLOW,
    readFileSync(WORKFLOW, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const proxies = new Map<string, ProxyOptions>();
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
      const options: ProxyOptions = {};
      const [literal] = node.initializer.arguments;
      for (const property of literal && ts.isObjectLiteralExpression(literal) ? literal.properties : []) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) continue;
        if (property.name.text === 'startToCloseTimeout' && ts.isStringLiteral(property.initializer)) {
          options.startToCloseTimeout = property.initializer.text;
        }
        if (property.name.text === 'retry' && ts.isObjectLiteralExpression(property.initializer)) {
          for (const retry of property.initializer.properties) {
            if (
              ts.isPropertyAssignment(retry) &&
              ts.isIdentifier(retry.name) &&
              retry.name.text === 'maximumAttempts' &&
              ts.isNumericLiteral(retry.initializer)
            ) {
              options.maximumAttempts = Number(retry.initializer.text);
            }
          }
        }
      }
      proxies.set(node.name.text, options);
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
  return { proxies, callsByActivity };
}

function perActivity<T>(pick: (options: ProxyOptions) => T | undefined): Map<string, T[]> {
  const { proxies, callsByActivity } = readWorkflow();
  return new Map(
    [...callsByActivity]
      .filter(([, names]) => names.every((name) => pick(proxies.get(name) ?? {}) !== undefined))
      .map(([activity, names]) => [activity, names.map((name) => pick(proxies.get(name)!)!)]),
  );
}

/** Maps each activity the discovery workflow calls to the startToCloseTimeout of the proxy it is called through. */
export function discoveryActivityTimeouts(): Map<string, string[]> {
  return perActivity((options) => options.startToCloseTimeout);
}

/** Maps each activity the discovery workflow calls to the maximumAttempts of the proxy it is called through. */
export function discoveryActivityMaximumAttempts(): Map<string, number[]> {
  return perActivity((options) => options.maximumAttempts);
}

/** A proxy timeout literal ('15 minutes', '30 seconds') in milliseconds. */
export function timeoutMilliseconds(literal: string): number {
  const match = /^(\d+) (seconds?|minutes?)$/u.exec(literal);
  if (!match) throw new Error(`unsupported timeout literal: ${literal}`);
  return Number(match[1]) * (match[2]!.startsWith('minute') ? 60_000 : 1_000);
}
