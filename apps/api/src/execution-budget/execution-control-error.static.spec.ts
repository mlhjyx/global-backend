import { readdirSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(import.meta.dirname, '..');
const CONTROL_MESSAGE =
  /EXECUTION_BUDGET_|EXECUTIONBUDGET|BUDGET_|BUDGET.*ERROR|BUDGETOPERATIONREPLAY|BUDGETSTORE|BUDGETEXCEEDED|PAIDOPERATIONUNKNOWN|DOMAIN_ACK_|DOMAINACK|DURABLE_EXECUTION_RECEIPT_|DURABLEEXECUTIONRECEIPT|GENERIC_OPERATION_ARTIFACT_|GENERICOPERATIONARTIFACT|ARTIFACTSTORAGEERROR|DURABLE_REPLAY_|_REPLAY_/u;
const EXCEPTION_BOUNDARIES = Object.freeze([
  { producer: 'model-gateway/providers/openai-compatible.provider.ts', terminalConsumers: ['model-gateway/model-providers.config.ts'] },
  { producer: 'model-gateway/vision-review-input.ts', terminalConsumers: ['model-gateway/providers/openai-compatible.provider.ts', 'model-gateway/router-model-gateway.ts'] },
  { producer: 'site-builder/agents/controlled-assembly.ts', terminalConsumers: ['temporal/site-builder.activities.ts'] },
  { producer: 'site-builder/assembly/copy-slot-derivation.ts', terminalConsumers: ['temporal/site-builder.activities.ts'] },
  { producer: 'site-builder/copy-bundle.service.ts', terminalConsumers: ['temporal/site-builder.activities.ts'] },
  { producer: 'site-builder/site-build-budget-grant.ts', terminalConsumers: ['site-builder/builds.controller.ts', 'site-builder/intake.controller.ts'] },
  { producer: 'temporal/site-builder.activities.ts', terminalConsumers: [] },
] as const);
const EXCEPTION_PRODUCERS = new Set(EXCEPTION_BOUNDARIES.map(({ producer }) => producer));
const ORDINARY_DYNAMIC_ERROR_REGISTRY = Object.freeze(new Set([
  'acquisition/acquisition.service.ts|`monitored_source ${sourceId} not found`',
  'acquisition/acquisition.service.ts|`no source adapter for providerKey=${source.providerKey}`',
  'discovery/providers/structured-harvest.provider.ts|`http.get ${res.blocked ?? res.status}`',
  'intent/website-watch.service.ts|`monitored_source ${sourceId} not found`',
  'intent/website-watch.service.ts|`source ${sourceId} is not a web_watch source (providerKey=${source.providerKey})`',
  'intent/intent-projection.service.ts|`canonical_company ${canonicalCompanyId} not found in workspace`',
  'intent/intent-projection.service.ts|`company ${canonicalCompanyId} has no domain — cannot watch website`',
  'sanctions/sanctions-refresh.service.ts|`unsupported sanctions format: ${src.format}`',
  'sanctions/sanctions-refresh.service.ts|`sanctions refresh abort (shrink guard): parsed ${desired.length} vs existing active ${existingActive} — kept prior data`',
  'temporal/discovery.activities.ts|`query plan ${args.planId} not found`',
  'temporal/discovery.activities.ts|`query plan is ${plan.status}; must be READY (human-confirmed) before execution`',
]));

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return path.endsWith(join('site-builder', 'eval')) ? [] : productionSources(path);
    }
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression) || ts.isSatisfiesExpression(expression)) {
    return unwrap(expression.expression);
  }
  return expression;
}

type IdentifierResolver = (identifier: ts.Identifier, seen: ReadonlySet<ts.Symbol>, depth: number) => string | null;

function staticString(input: ts.Expression, resolveIdentifier: IdentifierResolver, seen: ReadonlySet<ts.Symbol> = new Set(), depth = 0): string | null {
  if (depth > 16) return null;
  const expression = unwrap(input);
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(expression.left, resolveIdentifier, seen, depth + 1);
    const right = staticString(expression.right, resolveIdentifier, seen, depth + 1);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const item = staticString(span.expression, resolveIdentifier, seen, depth + 1);
      if (item === null) return null;
      value += item + span.literal.text;
    }
    return value;
  }
  return ts.isIdentifier(expression) ? resolveIdentifier(expression, seen, depth + 1) : null;
}

function checkerIdentifierResolver(checker: ts.TypeChecker): IdentifierResolver {
  const resolver: IdentifierResolver = (identifier, seen, depth) => {
    let symbol = checker.getSymbolAtLocation(identifier);
    if (!symbol) return null;
    if (symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    if (seen.has(symbol)) return null;
    const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
    if (!declaration?.initializer || !ts.isVariableDeclarationList(declaration.parent) || !(declaration.parent.flags & ts.NodeFlags.Const)) return null;
    return staticString(declaration.initializer, resolver, new Set(seen).add(symbol), depth);
  };
  return resolver;
}

function localIdentifierResolver(sourceFile: ts.SourceFile): IdentifierResolver {
  const declarations = new Map<string, ts.VariableDeclaration>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isVariableDeclarationList(node.parent) && node.parent.flags & ts.NodeFlags.Const) declarations.set(node.name.text, node);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);
  const symbols = new Map<string, ts.Symbol>();
  const resolver: IdentifierResolver = (identifier, seen, depth) => {
    const declaration = declarations.get(identifier.text);
    if (!declaration?.initializer) return null;
    const symbol = symbols.get(identifier.text) ?? ({ name: identifier.text } as ts.Symbol);
    symbols.set(identifier.text, symbol);
    if (seen.has(symbol)) return null;
    return staticString(declaration.initializer, resolver, new Set(seen).add(symbol), depth);
  };
  return resolver;
}

type ErrorConstruction = Readonly<{ line: number; message: string | null; dynamic: boolean; expression: string }>;

function errorConstructions(sourceFile: ts.SourceFile, resolver: IdentifierResolver): readonly ErrorConstruction[] {
  const findings: ErrorConstruction[] = [];
  const visit = (node: ts.Node): void => {
    const errorCall = (ts.isNewExpression(node) || ts.isCallExpression(node)) && ts.isIdentifier(node.expression) && node.expression.text === 'Error';
    if (errorCall) {
      const argument = node.arguments?.[0];
      const message = argument ? staticString(argument, resolver) : '';
      findings.push({
        line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        message,
        dynamic: Boolean(argument) && message === null,
        expression: argument?.getText(sourceFile) ?? '',
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

function importsSharedClassifier(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.moduleSpecifier.text.includes('execution-control-error'));
}

function resolvedRelativeImports(sourceFile: ts.SourceFile): readonly string[] {
  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.startsWith('.')) return [];
    const unresolved = resolve(dirname(sourceFile.fileName), statement.moduleSpecifier.text);
    return [`${unresolved}.ts`, join(unresolved, 'index.ts'), unresolved]
      .filter((candidate) => candidate.startsWith(SOURCE_ROOT))
      .map((candidate) => normalize(relative(SOURCE_ROOT, candidate)));
  });
}

function scanMutation(source: string): readonly ErrorConstruction[] {
  const sourceFile = ts.createSourceFile('mutation.ts', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  return errorConstructions(sourceFile, localIdentifierResolver(sourceFile));
}

function scanImportedMutation(): readonly ErrorConstruction[] {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    noLib: true,
    target: ts.ScriptTarget.ESNext,
  };
  const files = new Map([
    ['/virtual/code.ts', "export const CONTROL = 'DOMAIN_ACK_IMPORTED_INVALID';"],
    ['/virtual/consumer.ts', "import { CONTROL } from './code'; throw new Error(CONTROL);"],
  ]);
  const host = ts.createCompilerHost(options);
  const originalFileExists = host.fileExists;
  const originalReadFile = host.readFile;
  const originalGetSourceFile = host.getSourceFile;
  host.fileExists = (path) => files.has(path) || originalFileExists(path);
  host.readFile = (path) => files.get(path) ?? originalReadFile(path);
  host.getSourceFile = (path, languageVersion, onError, shouldCreate) => {
    const source = files.get(path);
    return source === undefined
      ? originalGetSourceFile(path, languageVersion, onError, shouldCreate)
      : ts.createSourceFile(path, source, languageVersion, true, ts.ScriptKind.TS);
  };
  host.getCurrentDirectory = () => '/virtual';
  host.resolveModuleNames = (moduleNames) =>
    moduleNames.map((moduleName) =>
      moduleName === './code'
        ? {
            extension: ts.Extension.Ts,
            isExternalLibraryImport: false,
            resolvedFileName: '/virtual/code.ts',
          }
        : undefined,
    );
  const program = ts.createProgram([...files.keys()], options, host);
  const checker = program.getTypeChecker();
  const consumer = program.getSourceFile('/virtual/consumer.ts')!;
  return errorConstructions(consumer, checkerIdentifierResolver(checker));
}

describe('execution control producer structure', () => {
  it.each([
    ['literal', "throw new Error('DOMAIN_ACK_LITERAL_INVALID')"],
    ['const identifier', "const CODE = 'DOMAIN_ACK_CONST_INVALID'; throw new Error(CODE)"],
    ['call form', "throw Error('DOMAIN_ACK_CALL_INVALID')"],
    ['binary concatenation', "throw new Error('DOMAIN_' + 'ACK_CONCAT_INVALID')"],
  ])('mutation rejects a message-only control producer: %s', (_label, source) => {
    expect(scanMutation(source).some(({ message }) => message !== null && CONTROL_MESSAGE.test(message))).toBe(true);
  });

  it('mutation detects a registered consumer adding the shared classifier', () => {
    const sourceFile = ts.createSourceFile('consumer.ts', "import { isExecutionControlError } from './execution-control-error';\nimport './site-builder/agents/controlled-assembly';", ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    expect(importsSharedClassifier(sourceFile)).toBe(true);
  });

  it('forbids message-only or dynamic Error construction in shared production boundaries', () => {
    const paths = productionSources(SOURCE_ROOT);
    const program = ts.createProgram(paths, { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, skipLibCheck: true, target: ts.ScriptTarget.ESNext });
    const checker = program.getTypeChecker();
    const resolver = checkerIdentifierResolver(checker);
    const sources = new Map(program.getSourceFiles().filter((file) => file.fileName.startsWith(SOURCE_ROOT)).map((file) => [normalize(relative(SOURCE_ROOT, file.fileName)), file]));
    const violations: string[] = [];
    const observedOrdinaryRegistrations = new Set<string>();
    for (const [relativePath, sourceFile] of sources) {
      if (EXCEPTION_PRODUCERS.has(relativePath)) continue;
      const sharedScope = importsSharedClassifier(sourceFile);
      for (const finding of errorConstructions(sourceFile, resolver)) {
        const control = finding.message !== null && CONTROL_MESSAGE.test(finding.message.toUpperCase());
        const registeredOrdinary = ORDINARY_DYNAMIC_ERROR_REGISTRY.has(
          `${relativePath}|${finding.expression}`,
        );
        if (registeredOrdinary) {
          observedOrdinaryRegistrations.add(
            `${relativePath}|${finding.expression}`,
          );
        }
        if (control || (sharedScope && finding.dynamic && !registeredOrdinary)) violations.push(`${relativePath}:${finding.line}:${control ? 'CONTROL_MESSAGE' : 'DYNAMIC_ERROR'}`);
      }
    }
    expect(violations).toEqual([]);
    expect([...observedOrdinaryRegistrations].sort()).toEqual(
      [...ORDINARY_DYNAMIC_ERROR_REGISTRY].sort(),
    );

    const reverseImports = new Map<string, Set<string>>();
    for (const [consumer, sourceFile] of sources) {
      for (const imported of resolvedRelativeImports(sourceFile)) {
        const consumers = reverseImports.get(imported) ?? new Set<string>();
        consumers.add(consumer);
        reverseImports.set(imported, consumers);
      }
    }
    for (const boundary of EXCEPTION_BOUNDARIES) {
      const producer = sources.get(boundary.producer)!;
      expect(producer, boundary.producer).toBeDefined();
      expect(importsSharedClassifier(producer)).toBe(false);
      expect(
        errorConstructions(producer, resolver).some(
          ({ message, dynamic }) =>
            dynamic ||
            (message !== null && CONTROL_MESSAGE.test(message.toUpperCase())),
        ),
        boundary.producer,
      ).toBe(true);
      for (const consumer of boundary.terminalConsumers) {
        expect(sources.get(consumer), consumer).toBeDefined();
        expect(importsSharedClassifier(sources.get(consumer)!)).toBe(false);
        expect(reverseImports.get(boundary.producer)?.has(consumer)).toBe(true);
      }
      for (const consumer of reverseImports.get(boundary.producer) ?? []) expect(importsSharedClassifier(sources.get(consumer)!)).toBe(false);
    }
    const controlledAssembly = sources.get('site-builder/agents/controlled-assembly.ts')!;
    expect(
      errorConstructions(controlledAssembly, resolver).some(
        ({ expression }) =>
          expression.startsWith('`CONTROLLED_ASSEMBLY_REPLAY_INVALID:'),
      ),
    ).toBe(true);
  }, 30_000);

  it('mutation resolves an imported const control-code chain', () => {
    expect(
      scanImportedMutation().some(
        ({ message }) => message === 'DOMAIN_ACK_IMPORTED_INVALID',
      ),
    ).toBe(true);
  });
});
