import path from "node:path";
import ts from "typescript";
import { GraphBuilder } from "../graph";
import { SourceLocationV1 } from "../schema";
import { readUtf8, relativePath, walkFiles } from "../utils";

function location(
  source: ts.SourceFile,
  relative: string,
  node: ts.Node,
): SourceLocationV1 {
  const point = source.getLineAndCharacterOfPosition(node.getStart(source));
  return { path: relative, line: point.line + 1, column: point.character + 1 };
}

function nameOf(node: ts.ObjectLiteralElementLike): string | undefined {
  if (!("name" in node) || !node.name) return undefined;
  if (
    ts.isIdentifier(node.name) ||
    ts.isStringLiteral(node.name) ||
    ts.isNumericLiteral(node.name)
  ) {
    return node.name.text;
  }
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (true) {
    if (
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (
      ts.isCallExpression(current) &&
      current.arguments.length === 1 &&
      current.expression.getText().endsWith("Object.freeze")
    ) {
      current = current.arguments[0];
      continue;
    }
    return current;
  }
}

function objectOf(
  expression: ts.Expression | undefined,
): ts.ObjectLiteralExpression | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  return ts.isObjectLiteralExpression(value) ? value : undefined;
}

function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  return object.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && nameOf(candidate) === name,
  );
}

function stringValue(
  expression: ts.Expression | undefined,
): string | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  return ts.isStringLiteralLike(value) ? value.text : undefined;
}

function numberValue(
  expression: ts.Expression | undefined,
): number | undefined {
  if (!expression) return undefined;
  const value = unwrap(expression);
  if (ts.isNumericLiteral(value)) return Number(value.text.replaceAll("_", ""));
  return undefined;
}

function stringArray(expression: ts.Expression | undefined): string[] {
  if (!expression) return [];
  const value = unwrap(expression);
  if (!ts.isArrayLiteralExpression(value)) return [];
  return value.elements
    .map((element) => stringValue(element))
    .filter((item): item is string => Boolean(item));
}

function findVariable(
  source: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | undefined {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return undefined;
}

function resolvedString(
  source: ts.SourceFile,
  expression: ts.Expression | undefined,
): string | undefined {
  const direct = stringValue(expression);
  if (direct || !expression) return direct;
  const value = unwrap(expression);
  if (
    !ts.isPropertyAccessExpression(value) ||
    !ts.isIdentifier(value.expression)
  ) {
    return undefined;
  }
  const object = objectOf(
    findVariable(source, value.expression.text)?.initializer,
  );
  return object
    ? stringValue(property(object, value.name.text)?.initializer)
    : undefined;
}

function resolvedNumber(
  source: ts.SourceFile,
  expression: ts.Expression | undefined,
): number | undefined {
  const direct = numberValue(expression);
  if (direct !== undefined || !expression) return direct;
  const value = unwrap(expression);
  if (!ts.isIdentifier(value)) return undefined;
  return numberValue(findVariable(source, value.text)?.initializer);
}

interface Route {
  state: string;
  primary: string;
  fallbacks: string[];
  evidenceId?: string;
  node: ts.Node;
}

function routesFromObject(
  source: ts.SourceFile,
  variableName: string,
): Map<string, Route> {
  const output = new Map<string, Route>();
  const declaration = findVariable(source, variableName);
  const policies = objectOf(declaration?.initializer);
  if (!policies) return output;
  for (const candidate of policies.properties) {
    if (!ts.isPropertyAssignment(candidate)) continue;
    const taskId = nameOf(candidate);
    const policy = objectOf(candidate.initializer);
    if (!taskId || !policy) continue;
    const route = objectOf(property(policy, "route")?.initializer);
    const primary = route
      ? stringValue(property(route, "primary")?.initializer)
      : undefined;
    if (!primary) continue;
    output.set(taskId, {
      state: stringValue(property(policy, "state")?.initializer) ?? "UNKNOWN",
      primary,
      fallbacks: route
        ? stringArray(property(route, "fallbacks")?.initializer)
        : [],
      evidenceId: resolvedString(
        source,
        property(policy, "promotionEvidenceId")?.initializer,
      ),
      node: candidate,
    });
  }
  return output;
}

export async function extractAiAndTools(
  builder: GraphBuilder,
  repositoryRoot: string,
): Promise<void> {
  const policyPath = path.join(
    repositoryRoot,
    "apps",
    "api",
    "src",
    "site-builder",
    "agents",
    "model-policy.registry.ts",
  );
  const policyRelative = relativePath(repositoryRoot, policyPath);
  const policyText = await readUtf8(policyPath);
  const policySource = ts.createSourceFile(
    policyPath,
    policyText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const routes = routesFromObject(policySource, "LEGACY_TASK_POLICIES");
  for (const [taskId, route] of routesFromObject(
    policySource,
    "ACTIVE_TASK_POLICIES",
  )) {
    routes.set(taskId, route);
  }
  for (const [taskId, route] of routes) {
    const routeLocation = location(policySource, policyRelative, route.node);
    const task = builder.addNode({
      id: `service:ai-task:${taskId}`,
      kind: "service",
      label: taskId,
      attributes: { subtype: "ai-task", routeState: route.state },
      location: routeLocation,
    });
    for (const [position, model] of [
      ["primary", route.primary],
      ...route.fallbacks.map((fallback, index) => [
        `fallback-${index + 1}`,
        fallback,
      ]),
    ]) {
      const modelNode = builder.addNode({
        id: `external:model:${model}`,
        kind: "external_system",
        label: model,
        attributes: {
          subtype: "model",
          ownership: "EXTERNAL_OWNED",
          gateway: "new-api",
        },
        location: routeLocation,
      });
      builder.addEdge({
        kind: "routes_to",
        from: task,
        to: modelNode,
        attributes: { position, routeState: route.state },
        location: routeLocation,
      });
    }
    if (route.evidenceId) {
      const evidence = builder.addNode({
        id: `evidence:model-policy:${route.evidenceId}`,
        kind: "evidence",
        label: route.evidenceId,
        attributes: { evidenceType: "model-promotion" },
        location: routeLocation,
      });
      builder.addEdge({
        kind: "validates",
        from: evidence,
        to: task,
        location: routeLocation,
      });
    }
  }

  const bindingsPath = path.join(
    repositoryRoot,
    "apps",
    "api",
    "src",
    "site-builder",
    "agents",
    "task-route-bindings.ts",
  );
  const bindingsRelative = relativePath(repositoryRoot, bindingsPath);
  const bindingsText = await readUtf8(bindingsPath);
  const bindingsSource = ts.createSourceFile(
    bindingsPath,
    bindingsText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const bindings = objectOf(
    findVariable(bindingsSource, "TASK_BINDINGS")?.initializer,
  );
  if (bindings) {
    for (const candidate of bindings.properties) {
      if (!ts.isPropertyAssignment(candidate)) continue;
      const taskId = nameOf(candidate);
      const binding = objectOf(candidate.initializer);
      if (!taskId || !binding) continue;
      const bindingLocation = location(
        bindingsSource,
        bindingsRelative,
        candidate,
      );
      builder.addNode({
        id: `service:ai-task:${taskId}`,
        kind: "service",
        label: taskId,
        attributes: {
          subtype: "ai-task",
          profile:
            stringValue(property(binding, "profile")?.initializer) ?? null,
          maxTokens:
            resolvedNumber(
              bindingsSource,
              property(binding, "maxTokens")?.initializer,
            ) ?? null,
          timeoutMs:
            resolvedNumber(
              bindingsSource,
              property(binding, "timeoutMs")?.initializer,
            ) ?? null,
          maxCostCents:
            resolvedNumber(
              bindingsSource,
              property(binding, "maxCostCents")?.initializer,
            ) ?? null,
          killSwitch: "budget-and-run-state-fail-closed",
        },
        location: bindingLocation,
      });
    }
  }

  const broker = builder.addNode({
    id: "service:tool-broker",
    kind: "service",
    label: "ToolBroker",
    attributes: {
      subtype: "execution-gateway",
      sourcePolicy: "fail-closed-by-tool-contract",
      budget: "reserve-settle",
    },
    location: {
      path: "apps/api/src/tools/tool-broker.ts",
      line: 1,
    },
  });
  const toolFiles = await walkFiles(
    path.join(repositoryRoot, "apps", "api", "src", "tools"),
    (relative) => relative.endsWith(".ts") && !relative.endsWith(".spec.ts"),
  );
  for (const absolute of toolFiles) {
    const relative = relativePath(repositoryRoot, absolute);
    const text = await readUtf8(absolute);
    const source = ts.createSourceFile(
      absolute,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        const definition = objectOf(declaration.initializer);
        if (!definition) continue;
        const toolId = stringValue(property(definition, "id")?.initializer);
        if (!toolId) continue;
        const compliance = objectOf(
          property(definition, "compliance")?.initializer,
        );
        const cost = objectOf(property(definition, "cost")?.initializer);
        const toolLocation = location(source, relative, declaration);
        const tool = builder.addNode({
          id: `service:tool:${toolId}`,
          kind: "service",
          label: toolId,
          attributes: {
            subtype: "tool",
            sourcePolicy: compliance
              ? (stringValue(
                  property(compliance, "sourcePolicy")?.initializer,
                ) ?? null)
              : null,
            policyDomain: compliance
              ? (stringValue(
                  property(compliance, "policyDomain")?.initializer,
                ) ?? null)
              : null,
            personalData: compliance
              ? property(compliance, "personalData")?.initializer.kind ===
                ts.SyntaxKind.TrueKeyword
              : false,
            allowedPurpose: compliance
              ? stringArray(property(compliance, "allowedPurpose")?.initializer)
              : [],
            risk: compliance
              ? (stringValue(property(compliance, "risk")?.initializer) ?? null)
              : null,
            external: cost
              ? property(cost, "external")?.initializer.kind ===
                ts.SyntaxKind.TrueKeyword
              : false,
          },
          location: toolLocation,
        });
        builder.addEdge({
          kind: "registers",
          from: broker,
          to: tool,
          location: toolLocation,
        });
      }
    }
  }
}
