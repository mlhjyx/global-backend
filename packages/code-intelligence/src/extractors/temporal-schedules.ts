import path from "node:path";
import ts from "typescript";
import { GraphBuilder } from "../graph";
import { SourceLocationV1 } from "../schema";
import { readUtf8 } from "../utils";

const WORKFLOW_REGISTRY_FILES = [
  "customer-workflows.ts",
  "platform-workflows.ts",
  "workflows.ts",
] as const;

function literalValue(node: ts.Expression | undefined): string | undefined {
  if (!node) return undefined;
  if (
    ts.isStringLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    ts.isNumericLiteral(node)
  ) {
    return node.text;
  }
  return undefined;
}

function propertyNameText(node: ts.PropertyAssignment): string | undefined {
  if (
    ts.isIdentifier(node.name) ||
    ts.isStringLiteral(node.name) ||
    ts.isNumericLiteral(node.name)
  ) {
    return node.name.text;
  }
  return undefined;
}

function sourceLocation(
  sourceFile: ts.SourceFile,
  relative: string,
  node: ts.Node,
): SourceLocationV1 {
  const position = sourceFile.getLineAndCharacterOfPosition(
    node.getStart(sourceFile),
  );
  return {
    path: relative,
    line: position.line + 1,
    column: position.character + 1,
  };
}

function unwrapExpression(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
): ts.Expression {
  let current = expression;
  while (true) {
    if (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    if (ts.isCallExpression(current) && current.arguments.length === 1) {
      const callee = current.expression.getText(sourceFile);
      if (
        callee === "Object.freeze" ||
        callee === "deepFreeze" ||
        callee === "technicalRow"
      ) {
        current = current.arguments[0];
        continue;
      }
    }
    return current;
  }
}

export async function loadRegisteredWorkflowNames(
  repositoryRoot: string,
): Promise<Set<string>> {
  const registeredWorkflowNames = new Set<string>();
  for (const registryFile of WORKFLOW_REGISTRY_FILES) {
    const workflowRegistryPath = path.join(
      repositoryRoot,
      "apps",
      "api",
      "src",
      "temporal",
      registryFile,
    );
    try {
      const registryText = await readUtf8(workflowRegistryPath);
      for (const match of registryText.matchAll(
        /^export\s*\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\s*from\s*/gm,
      )) {
        registeredWorkflowNames.add(match[1]);
      }
    } catch {
      // Registry file may be absent in minimal test fixtures or split repos.
    }
  }
  return registeredWorkflowNames;
}

export interface ExtractTemporalScheduleSpecsArgs {
  builder: GraphBuilder;
  sourceFile: ts.SourceFile;
  relative: string;
  fileNode: string;
  literalConstants: ReadonlyMap<string, string>;
  registeredWorkflowNames: ReadonlySet<string>;
}

function recordScheduleSpecEntry(
  args: ExtractTemporalScheduleSpecsArgs,
  rawElement: ts.Expression,
  idProperty: "id" | "scheduleId",
): void {
  const {
    builder,
    sourceFile,
    relative,
    fileNode,
    literalConstants,
    registeredWorkflowNames,
  } = args;
  const resolveStaticString = (
    expression: ts.Expression | undefined,
  ): string | undefined => {
    const direct = literalValue(expression);
    if (direct !== undefined) return direct;
    return expression && ts.isIdentifier(expression)
      ? literalConstants.get(expression.text)
      : undefined;
  };
  const element = unwrapExpression(sourceFile, rawElement);
  if (!ts.isObjectLiteralExpression(element)) return;
  const properties = new Map<string, ts.Expression>();
  for (const property of element.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = propertyNameText(property);
    if (name) properties.set(name, property.initializer);
  }
  const scheduleId =
    resolveStaticString(properties.get(idProperty)) ??
    properties.get(idProperty)?.getText(sourceFile);
  const workflowName =
    resolveStaticString(properties.get("workflowType")) ??
    properties.get("workflowType")?.getText(sourceFile);
  if (!scheduleId || !workflowName) return;
  const location = sourceLocation(sourceFile, relative, element);
  const schedule = builder.addNode({
    id: `service:temporal-schedule:${scheduleId}`,
    kind: "service",
    label: scheduleId,
    attributes: {
      subtype: "temporal-schedule",
      configuredWorkflow: workflowName,
      confidence: "REGISTERED_STATIC_CONFIG",
      requiresRuntimeEvidence: true,
    },
    location,
  });
  builder.addEdge({
    kind: "registers",
    from: fileNode,
    to: schedule,
    attributes: { confidence: "REGISTERED_STATIC_CONFIG" },
    location,
  });
  const proven = registeredWorkflowNames.has(workflowName);
  const workflow = proven
    ? builder.addNode({
        id: `workflow:temporal:${workflowName}`,
        kind: "workflow",
        label: workflowName,
        attributes: { runtime: "temporal" },
        location,
      })
    : builder.addNode({
        id: `workflow:temporal:unknown:schedule:${scheduleId}`,
        kind: "workflow",
        label: `[UNKNOWN] ${workflowName}`,
        attributes: {
          runtime: "temporal",
          resolution: "UNKNOWN",
          expression: workflowName,
        },
        location,
      });
  builder.addEdge({
    kind: "calls",
    from: schedule,
    to: workflow,
    attributes: {
      temporalOperation: "startWorkflow",
      confidence: proven ? "REGISTERED_STATIC_CONFIG" : "UNKNOWN",
      requiresRuntimeEvidence: true,
    },
    location,
  });
  if (!proven) {
    builder.addDiagnostic({
      code: "UNKNOWN_RELATION",
      severity: "warning",
      message: `Temporal schedule ${scheduleId} target ${workflowName} is not proven by registered workflow exports`,
      nodeId: schedule,
      location,
    });
  }
}

function extractEntriesFromDeclaration(
  args: ExtractTemporalScheduleSpecsArgs,
  declaration: ts.VariableDeclaration,
): void {
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return;
  const unwrapped = unwrapExpression(args.sourceFile, declaration.initializer);
  if (
    declaration.name.text === "SPECS" &&
    ts.isArrayLiteralExpression(unwrapped)
  ) {
    for (const element of unwrapped.elements) {
      recordScheduleSpecEntry(args, element, "id");
    }
    return;
  }
  if (
    declaration.name.text === "CUSTOMER_SWEEPS" &&
    ts.isArrayLiteralExpression(unwrapped)
  ) {
    for (const element of unwrapped.elements) {
      recordScheduleSpecEntry(args, element, "scheduleId");
    }
    return;
  }
  if (
    declaration.name.text === "PLATFORM_EXECUTION_TECHNICAL_CONTRACT_V1" &&
    ts.isObjectLiteralExpression(unwrapped)
  ) {
    const rowsProperty = unwrapped.properties.find(
      (property): property is ts.PropertyAssignment =>
        ts.isPropertyAssignment(property) &&
        propertyNameText(property) === "rows",
    );
    const rowsArray = rowsProperty
      ? unwrapExpression(args.sourceFile, rowsProperty.initializer)
      : undefined;
    if (rowsArray && ts.isArrayLiteralExpression(rowsArray)) {
      for (const element of rowsArray.elements) {
        recordScheduleSpecEntry(args, element, "scheduleId");
      }
    }
  }
}

export function extractTemporalScheduleSpecs(
  args: ExtractTemporalScheduleSpecsArgs,
): void {
  for (const statement of args.sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      extractEntriesFromDeclaration(args, declaration);
    }
  }
}
