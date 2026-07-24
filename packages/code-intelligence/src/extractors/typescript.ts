import path from "node:path";
import ts from "typescript";
import { MechanismObservation } from "../dynamic-mechanisms";
import { GraphBuilder } from "../graph";
import { SourceLocationV1 } from "../schema";
import { readUtf8, relativePath, walkFiles } from "../utils";
import { PrismaCatalog, prismaModelId } from "./prisma";

const HTTP_DECORATORS = new Map([
  ["Get", "GET"],
  ["Post", "POST"],
  ["Put", "PUT"],
  ["Patch", "PATCH"],
  ["Delete", "DELETE"],
  ["Options", "OPTIONS"],
  ["Head", "HEAD"],
]);

const READ_METHODS = new Set([
  "aggregate",
  "count",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
]);
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "delete",
  "deleteMany",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
]);

function symbolId(relative: string, name: string): string {
  return `symbol:${relative}#${name}`;
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

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function decoratorCall(
  node: ts.Node,
  name: string,
): ts.CallExpression | undefined {
  for (const decorator of decoratorsOf(node)) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const expression = decorator.expression.expression;
    const decoratorName = ts.isIdentifier(expression)
      ? expression.text
      : ts.isPropertyAccessExpression(expression)
        ? expression.name.text
        : "";
    if (decoratorName === name) return decorator.expression;
  }
  return undefined;
}

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

function declarationName(node: ts.Declaration): string | undefined {
  const named = node as ts.Declaration & { name?: ts.DeclarationName };
  if (!named.name) return undefined;
  if (ts.isIdentifier(named.name) || ts.isStringLiteral(named.name)) {
    return named.name.text;
  }
  return undefined;
}

function propertyChain(node: ts.Expression): string[] {
  if (ts.isIdentifier(node)) return [node.text];
  if (node.kind === ts.SyntaxKind.ThisKeyword) return ["this"];
  if (ts.isPropertyAccessExpression(node)) {
    return [...propertyChain(node.expression), node.name.text];
  }
  if (ts.isElementAccessExpression(node)) {
    const argument = literalValue(node.argumentExpression);
    return [...propertyChain(node.expression), argument ?? "*"];
  }
  return [];
}

function joinRoute(controller: string, method: string): string {
  const segments = [controller, method]
    .flatMap((value) => value.split("/"))
    .map((value) => value.trim())
    .filter(Boolean);
  return `/${segments.join("/")}`;
}

function resolveRelativeImport(
  sourceRelative: string,
  specifier: string,
  knownFiles: Set<string>,
): string {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(sourceRelative), specifier),
  );
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ];
  return (
    candidates.find((candidate) => knownFiles.has(candidate)) ?? `${base}.ts`
  );
}

function externalOrigin(value: string): string | undefined {
  if (!/^https?:\/\//i.test(value)) return undefined;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return undefined;
  }
}

function workflowNode(
  builder: GraphBuilder,
  name: string,
  location: SourceLocationV1,
): string {
  return builder.addNode({
    id: `workflow:temporal:${name}`,
    kind: "workflow",
    label: name,
    attributes: { runtime: "temporal" },
    location,
  });
}

function activityNode(
  builder: GraphBuilder,
  name: string,
  location: SourceLocationV1,
): string {
  return builder.addNode({
    id: `activity:temporal:${name}`,
    kind: "activity",
    label: name,
    attributes: { runtime: "temporal" },
    location,
  });
}

interface VisitContext {
  owner: string;
  workflow?: string;
  className?: string;
}

export async function extractTypeScript(
  builder: GraphBuilder,
  repositoryRoot: string,
  prisma: PrismaCatalog,
): Promise<MechanismObservation[]> {
  const absoluteFiles = await walkFiles(repositoryRoot, (relative) => {
    if (!/\.(?:ts|tsx|mts)$/.test(relative)) return false;
    if (relative.endsWith(".d.ts")) return false;
    if (relative.includes("/src/generated/")) return false;
    return /^(?:apps|packages|scripts)\//.test(relative);
  });
  const knownFiles = new Set(
    absoluteFiles.map((absolute) => relativePath(repositoryRoot, absolute)),
  );
  const registeredWorkflowNames = new Set<string>();
  const workflowRegistryPath = path.join(
    repositoryRoot,
    "apps",
    "api",
    "src",
    "temporal",
    "workflows.ts",
  );
  try {
    const registryText = await readUtf8(workflowRegistryPath);
    for (const match of registryText.matchAll(
      /^export\s*\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\s*from\s*/gm,
    )) {
      registeredWorkflowNames.add(match[1]);
    }
  } catch {
    // A repository without the canonical Temporal registry simply emits no
    // proven workflow declarations; client starts remain UNKNOWN.
  }
  const observations: MechanismObservation[] = [];

  for (const absolute of absoluteFiles) {
    const relative = relativePath(repositoryRoot, absolute);
    const text = await readUtf8(absolute);
    observations.push({ path: relative, text });
    const sourceFile = ts.createSourceFile(
      absolute,
      text,
      ts.ScriptTarget.Latest,
      true,
      relative.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const isTest = /\.(?:spec|test)\.(?:ts|tsx)$/.test(relative);
    const fileNode = builder.addNode({
      id: `file:${relative}`,
      kind: "source_file",
      label: relative,
      attributes: { language: "typescript", test: isTest },
      location: { path: relative, line: 1 },
    });
    const testNode = isTest
      ? builder.addNode({
          id: `test:${relative}`,
          kind: "test",
          label: relative,
          attributes: {
            framework: text.includes("vitest") ? "vitest" : "unknown",
          },
          location: { path: relative, line: 1 },
        })
      : undefined;
    if (testNode) {
      builder.addEdge({
        kind: "contains",
        from: fileNode,
        to: testNode,
        location: { path: relative, line: 1 },
      });
    }

    const proxyVariables = new Map<string, string>();
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const specifier = literalValue(statement.moduleSpecifier);
      if (!specifier) continue;
      const location = sourceLocation(sourceFile, relative, statement);
      if (specifier.startsWith(".")) {
        const imported = resolveRelativeImport(relative, specifier, knownFiles);
        const target = builder.addNode({
          id: `file:${imported}`,
          kind: "source_file",
          label: imported,
          attributes: { unresolved: !knownFiles.has(imported) },
          location,
        });
        builder.addEdge({
          kind: "depends_on",
          from: fileNode,
          to: target,
          attributes: { import: specifier },
          location,
        });
        if (testNode) {
          builder.addEdge({
            kind: "validates",
            from: testNode,
            to: target,
            location,
          });
        }
      } else {
        const packageName = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/", 1)[0];
        const target = builder.addNode({
          id: `package:${packageName}`,
          kind: "package",
          label: packageName,
          attributes: { internal: packageName.startsWith("@global/") },
          location,
        });
        builder.addEdge({
          kind: "depends_on",
          from: fileNode,
          to: target,
          attributes: { import: specifier },
          location,
        });
      }
    }

    const registerProxyVariable = (node: ts.VariableDeclaration): void => {
      if (!ts.isIdentifier(node.name) || !node.initializer) return;
      if (!ts.isCallExpression(node.initializer)) return;
      const expression = node.initializer.expression;
      if (!ts.isIdentifier(expression) || expression.text !== "proxyActivities")
        return;
      const typeName =
        node.initializer.typeArguments?.[0]?.getText(sourceFile) ?? "unknown";
      proxyVariables.set(node.name.text, typeName);
    };

    const addSymbol = (
      name: string,
      node: ts.Node,
      parentName?: string,
    ): string => {
      const qualified = parentName ? `${parentName}.${name}` : name;
      const location = sourceLocation(sourceFile, relative, node);
      const id = builder.addNode({
        id: symbolId(relative, qualified),
        kind: "code_symbol",
        label: qualified,
        attributes: {
          file: relative,
          exported:
            (ts.canHaveModifiers(node)
              ? ts.getModifiers(node)
              : undefined
            )?.some(
              (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
            ) ?? false,
        },
        location,
      });
      builder.addEdge({ kind: "contains", from: fileNode, to: id, location });
      return id;
    };

    const inspectController = (
      node: ts.ClassDeclaration,
      className: string,
    ): void => {
      const controller = decoratorCall(node, "Controller");
      if (!controller) return;
      const controllerRoute = literalValue(controller.arguments[0]) ?? "";
      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        const methodName = declarationName(member);
        if (!methodName) continue;
        for (const [decoratorName, method] of HTTP_DECORATORS) {
          const decorator = decoratorCall(member, decoratorName);
          if (!decorator) continue;
          const methodRoute = literalValue(decorator.arguments[0]) ?? "";
          const route = joinRoute(controllerRoute, methodRoute);
          const location = sourceLocation(sourceFile, relative, member);
          const api = builder.addNode({
            id: `api:${method}:${route}`,
            kind: "api",
            label: `${method} ${route}`,
            attributes: {
              method,
              route,
              operation: `${className}.${methodName}`,
              framework: "nestjs",
            },
            location,
          });
          const implementation = addSymbol(methodName, member, className);
          builder.addEdge({
            kind: "implements",
            from: implementation,
            to: api,
            location,
          });
        }
      }
    };

    const inspectModule = (
      node: ts.ClassDeclaration,
      className: string,
    ): void => {
      const decorator = decoratorCall(node, "Module");
      if (!decorator || decorator.arguments.length === 0) return;
      const moduleSymbol = symbolId(relative, className);
      const argument = decorator.arguments[0];
      if (!ts.isObjectLiteralExpression(argument)) return;
      for (const property of argument.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const section = declarationName(property);
        if (!section || !ts.isArrayLiteralExpression(property.initializer))
          continue;
        for (const element of property.initializer.elements) {
          const name = ts.isIdentifier(element)
            ? element.text
            : ts.isCallExpression(element)
              ? element.expression.getText(sourceFile)
              : undefined;
          if (!name) continue;
          const location = sourceLocation(sourceFile, relative, element);
          const target = builder.addNode({
            id: `symbol-ref:${name}`,
            kind: "code_symbol",
            label: name,
            attributes: { unresolvedReference: true },
            location,
          });
          builder.addEdge({
            kind: section === "imports" ? "depends_on" : "registers",
            from: moduleSymbol,
            to: target,
            attributes: { nestModuleSection: section },
            location,
          });
        }
      }
    };

    const inspectConstructor = (
      node: ts.ClassDeclaration,
      className: string,
    ): void => {
      const owner = symbolId(relative, className);
      for (const member of node.members) {
        if (!ts.isConstructorDeclaration(member)) continue;
        for (const parameter of member.parameters) {
          const typeName = parameter.type?.getText(sourceFile);
          if (!typeName) continue;
          const location = sourceLocation(sourceFile, relative, parameter);
          const target = builder.addNode({
            id: `symbol-ref:${typeName}`,
            kind: "code_symbol",
            label: typeName,
            attributes: { unresolvedReference: true },
            location,
          });
          builder.addEdge({
            kind: "depends_on",
            from: owner,
            to: target,
            attributes: { injection: "constructor" },
            location,
          });
        }
      }
    };

    const visit = (node: ts.Node, context: VisitContext): void => {
      if (ts.isVariableDeclaration(node)) registerProxyVariable(node);

      if (ts.isPropertyAssignment(node)) {
        const property = declarationName(node);
        if (property === "eventType") {
          const eventType = literalValue(node.initializer);
          if (eventType) {
            const location = sourceLocation(sourceFile, relative, node);
            const event = builder.addNode({
              id: `event:outbox:${eventType}`,
              kind: "event",
              label: eventType,
              attributes: {
                transport: "transactional-outbox",
                confidence: "INFERRED_STATIC_CANDIDATE",
                requiresRuntimeEvidence: true,
              },
              location,
            });
            builder.addEdge({
              kind: "publishes",
              from: context.owner,
              to: event,
              attributes: { confidence: "INFERRED_STATIC_CANDIDATE" },
              location,
            });
          }
        }
      }

      if (ts.isCaseClause(node) && node.expression) {
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isSwitchStatement(parent)) parent = parent.parent;
        const isEventDispatch =
          parent &&
          ts.isSwitchStatement(parent) &&
          /eventType|event_type/.test(parent.expression.getText(sourceFile));
        const eventType = literalValue(node.expression);
        if (eventType && isEventDispatch) {
          const location = sourceLocation(sourceFile, relative, node);
          const event = builder.addNode({
            id: `event:outbox:${eventType}`,
            kind: "event",
            label: eventType,
            attributes: {
              transport: "string-dispatch",
              confidence: "PROVEN_STATIC_BRANCH",
              requiresRuntimeEvidence: true,
            },
            location,
          });
          builder.addEdge({
            kind: "consumes",
            from: context.owner,
            to: event,
            attributes: { confidence: "PROVEN_STATIC_BRANCH" },
            location,
          });
        }
      }

      if (ts.isStringLiteralLike(node)) {
        const origin = externalOrigin(node.text);
        if (origin) {
          const location = sourceLocation(sourceFile, relative, node);
          const external = builder.addNode({
            id: `external:${origin}`,
            kind: "external_system",
            label: origin,
            attributes: { ownership: "EXTERNAL_OWNED" },
            location,
          });
          builder.addEdge({
            kind: "routes_to",
            from: context.owner,
            to: external,
            location,
          });
        }
        if (/^site_builder\.[a-z0-9_.-]+$/.test(node.text)) {
          const location = sourceLocation(sourceFile, relative, node);
          const task = builder.addNode({
            id: `service:ai-task:${node.text}`,
            kind: "service",
            label: node.text,
            attributes: { subtype: "ai-task" },
            location,
          });
          builder.addEdge({
            kind: "references",
            from: context.owner,
            to: task,
            location,
          });
        }
      }

      if (ts.isCallExpression(node)) {
        const location = sourceLocation(sourceFile, relative, node);
        const chain = propertyChain(node.expression);
        if (chain.length >= 2) {
          const proxyType = proxyVariables.get(chain[0]);
          if (proxyType && context.workflow) {
            const activity = activityNode(builder, chain[1], location);
            builder.addNode({
              id: activity,
              kind: "activity",
              label: chain[1],
              attributes: { interface: proxyType, runtime: "temporal" },
              location,
            });
            builder.addEdge({
              kind: "calls",
              from: context.workflow,
              to: activity,
              location,
            });
          }

          for (let index = 0; index < chain.length - 1; index += 1) {
            const modelName = prisma.clientNames.get(chain[index]);
            const method = chain[index + 1];
            if (
              !modelName ||
              (!READ_METHODS.has(method) && !WRITE_METHODS.has(method))
            ) {
              continue;
            }
            builder.addEdge({
              kind: READ_METHODS.has(method) ? "reads" : "writes",
              from: context.owner,
              to: prismaModelId(modelName),
              attributes: { prismaMethod: method },
              location,
            });
          }

          const lastTwo = chain.slice(-2).join(".");
          if (lastTwo === "workflow.start" || lastTwo === "workflow.execute") {
            const firstArgument = node.arguments[0];
            const workflowName = firstArgument
              ? (literalValue(firstArgument) ??
                firstArgument.getText(sourceFile))
              : "unknown";
            const proven = registeredWorkflowNames.has(workflowName);
            const workflow = proven
              ? workflowNode(builder, workflowName, location)
              : builder.addNode({
                  id: `workflow:temporal:unknown:${relative}:${location.line}`,
                  kind: "workflow",
                  label: `[UNKNOWN] ${workflowName}`,
                  attributes: {
                    runtime: "temporal",
                    resolution: "UNKNOWN",
                    expression: workflowName,
                  },
                  location,
                });
            if (!proven) {
              builder.addDiagnostic({
                code: "UNKNOWN_RELATION",
                severity: "warning",
                message: `Temporal client start target ${workflowName} is dynamic and not proven by workflows.ts`,
                nodeId: workflow,
                location,
              });
            }
            builder.addEdge({
              kind: "calls",
              from: context.owner,
              to: workflow,
              attributes: { temporalOperation: lastTwo },
              location,
            });
          }
          if (lastTwo === "schedule.create") {
            const schedule = builder.addNode({
              id: `service:temporal-schedule:${relative}:${location.line}`,
              kind: "service",
              label: `Temporal schedule at ${relative}:${location.line}`,
              attributes: { subtype: "temporal-schedule" },
              location,
            });
            builder.addEdge({
              kind: "registers",
              from: context.owner,
              to: schedule,
              location,
            });
          }
          if (chain.join(".") === "Worker.create") {
            const worker = builder.addNode({
              id: `service:temporal-worker:${relative}`,
              kind: "service",
              label: `Temporal worker ${relative}`,
              attributes: { runtime: "temporal" },
              location,
            });
            builder.addEdge({
              kind: "registers",
              from: context.owner,
              to: worker,
              location,
            });
            const configuration = node.arguments[0];
            if (configuration && ts.isObjectLiteralExpression(configuration)) {
              const activitiesProperty = configuration.properties.find(
                (property) =>
                  ts.isPropertyAssignment(property) &&
                  declarationName(property) === "activities",
              );
              if (
                activitiesProperty &&
                ts.isPropertyAssignment(activitiesProperty) &&
                ts.isObjectLiteralExpression(activitiesProperty.initializer)
              ) {
                for (const property of activitiesProperty.initializer
                  .properties) {
                  if (!ts.isSpreadAssignment(property)) continue;
                  const factory = property.expression.getText(sourceFile);
                  const target = builder.addNode({
                    id: `symbol-ref:${factory}`,
                    kind: "code_symbol",
                    label: factory,
                    attributes: {
                      activityFactory: true,
                      unresolvedReference: true,
                    },
                    location: sourceLocation(sourceFile, relative, property),
                  });
                  builder.addEdge({
                    kind: "registers",
                    from: worker,
                    to: target,
                    location: sourceLocation(sourceFile, relative, property),
                  });
                }
              }
            }
          }
        }

        if (ts.isIdentifier(node.expression)) {
          const calleeName = node.expression.text;
          if (
            !["describe", "it", "test", "expect", "vi"].includes(calleeName)
          ) {
            const target = builder.addNode({
              id: `symbol-ref:${calleeName}`,
              kind: "code_symbol",
              label: calleeName,
              attributes: { unresolvedReference: true },
              location,
            });
            builder.addEdge({
              kind: "calls",
              from: context.owner,
              to: target,
              location,
            });
          }
        }
      }

      ts.forEachChild(node, (child) => visit(child, context));
    };

    for (const statement of sourceFile.statements) {
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          registerProxyVariable(declaration);
        }
      }
    }

    for (const statement of sourceFile.statements) {
      if (ts.isClassDeclaration(statement)) {
        const className = declarationName(statement) ?? "anonymous-class";
        const classSymbol = addSymbol(className, statement);
        inspectController(statement, className);
        inspectModule(statement, className);
        inspectConstructor(statement, className);
        for (const member of statement.members) {
          if (
            !ts.isMethodDeclaration(member) &&
            !ts.isConstructorDeclaration(member)
          ) {
            continue;
          }
          const memberName = ts.isConstructorDeclaration(member)
            ? "constructor"
            : (declarationName(member) ?? "anonymous-method");
          const owner = addSymbol(memberName, member, className);
          visit(member, { owner, className });
        }
        for (const member of statement.members) {
          if (ts.isPropertyDeclaration(member) && member.initializer) {
            visit(member.initializer, { owner: classSymbol, className });
          }
        }
      } else if (ts.isFunctionDeclaration(statement)) {
        const name = declarationName(statement) ?? "anonymous-function";
        const owner = addSymbol(name, statement);
        const isWorkflow = registeredWorkflowNames.has(name);
        const workflow = isWorkflow
          ? workflowNode(
              builder,
              name,
              sourceLocation(sourceFile, relative, statement),
            )
          : undefined;
        if (workflow) {
          builder.addEdge({
            kind: "implements",
            from: owner,
            to: workflow,
            location: sourceLocation(sourceFile, relative, statement),
          });
        }
        visit(statement, { owner, workflow });
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          const name = declarationName(declaration);
          if (!name || !declaration.initializer) continue;
          if (
            !ts.isArrowFunction(declaration.initializer) &&
            !ts.isFunctionExpression(declaration.initializer)
          ) {
            continue;
          }
          const owner = addSymbol(name, declaration);
          const isWorkflow = registeredWorkflowNames.has(name);
          const workflow = isWorkflow
            ? workflowNode(
                builder,
                name,
                sourceLocation(sourceFile, relative, declaration),
              )
            : undefined;
          visit(declaration.initializer, { owner, workflow });
        }
      }
    }
  }

  return observations.sort((left, right) =>
    left.path.localeCompare(right.path),
  );
}
