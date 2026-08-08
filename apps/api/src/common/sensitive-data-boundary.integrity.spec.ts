import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const srcRoot = resolve(__dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(srcRoot, path), "utf8");
}

function productionTypescriptFiles(directory = srcRoot): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return productionTypescriptFiles(absolute);
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".spec.ts")) {
      return [];
    }
    return [absolute];
  });
}

interface RawCatchLogFlow {
  file: string;
  line: number;
  catchBinding: string;
}

function findRawCatchLogFlows(file: string, text: string): RawCatchLogFlow[] {
  const virtualFile = `/virtual/${file.replace(/^\/+/, "")}`;
  const parsedSource = ts.createSourceFile(
    virtualFile,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.CommonJS,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host: ts.CompilerHost = {
    fileExists: (candidate) => candidate === virtualFile,
    readFile: (candidate) => (candidate === virtualFile ? text : undefined),
    getSourceFile: (candidate) =>
      candidate === virtualFile ? parsedSource : undefined,
    getDefaultLibFileName: () => "/virtual/lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/virtual",
    getDirectories: () => [],
    getCanonicalFileName: (candidate) => candidate,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const program = ts.createProgram([virtualFile], compilerOptions, host);
  const sourceFile = program.getSourceFile(virtualFile);
  if (!sourceFile) throw new Error(`AST_SOURCE_UNAVAILABLE:${file}`);
  const checker = program.getTypeChecker();
  const findings: RawCatchLogFlow[] = [];

  const bindingIdentifiers = (name: ts.BindingName): string[] => {
    if (ts.isIdentifier(name)) return [name.text];
    return name.elements.flatMap((element) =>
      ts.isOmittedExpression(element) ? [] : bindingIdentifiers(element.name),
    );
  };

  const unwrap = (expression: ts.Expression): ts.Expression => {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isTypeAssertionExpression(expression) ||
      ts.isNonNullExpression(expression)
    ) {
      return unwrap(expression.expression);
    }
    return expression;
  };

  const isDiagnosticTokenCall = (expression: ts.Expression): boolean => {
    const current = unwrap(expression);
    if (!ts.isCallExpression(current)) return false;
    const callee = unwrap(current.expression);
    if (!ts.isIdentifier(callee)) return false;
    const symbol = checker.getSymbolAtLocation(callee);
    return Boolean(
      symbol?.declarations?.some((declaration) => {
        if (!ts.isImportSpecifier(declaration)) return false;
        const importedName =
          declaration.propertyName?.text ?? declaration.name.text;
        let ancestor: ts.Node | undefined = declaration;
        while (ancestor && !ts.isImportDeclaration(ancestor)) {
          ancestor = ancestor.parent;
        }
        return (
          importedName === "diagnosticErrorToken" &&
          ancestor !== undefined &&
          ts.isImportDeclaration(ancestor) &&
          ts.isStringLiteral(ancestor.moduleSpecifier) &&
          ancestor.moduleSpecifier.text ===
            "../../common/sensitive-data-scrubber"
        );
      }),
    );
  };

  const isLoggingCall = (node: ts.CallExpression): boolean => {
    const callee = unwrap(node.expression);
    const methodNames = new Set([
      "log",
      "warn",
      "error",
      "debug",
      "verbose",
      "fatal",
      "info",
    ]);
    if (ts.isIdentifier(callee)) return methodNames.has(callee.text);
    return (
      ts.isPropertyAccessExpression(callee) && methodNames.has(callee.name.text)
    );
  };

  const analyzeCatch = (clause: ts.CatchClause): void => {
    const declaration = clause.variableDeclaration;
    if (!declaration) return;
    const catchBindings = bindingIdentifiers(declaration.name);
    const tainted = new Set<string>();
    const aliases = new Map<string, Set<string>>();

    const markTainted = (...identifiers: string[]): void => {
      const pending = [...identifiers];
      while (pending.length > 0) {
        const identifier = pending.pop();
        if (!identifier || tainted.has(identifier)) continue;
        tainted.add(identifier);
        for (const alias of aliases.get(identifier) ?? []) {
          pending.push(alias);
        }
      }
    };

    const linkAliases = (left: string, right: string): void => {
      if (left === right) return;
      const leftLinks = aliases.get(left) ?? new Set<string>();
      const rightLinks = aliases.get(right) ?? new Set<string>();
      leftLinks.add(right);
      rightLinks.add(left);
      aliases.set(left, leftLinks);
      aliases.set(right, rightLinks);
      if (tainted.has(left) || tainted.has(right)) {
        markTainted(left, right);
      }
    };

    const rootIdentifier = (expression: ts.Expression): string | undefined => {
      let current = unwrap(expression);
      while (
        ts.isPropertyAccessExpression(current) ||
        ts.isElementAccessExpression(current)
      ) {
        current = unwrap(current.expression);
      }
      return ts.isIdentifier(current) ? current.text : undefined;
    };

    markTainted(...catchBindings);

    const isRawDerived = (expression: ts.Expression): boolean => {
      const current = unwrap(expression);
      if (isDiagnosticTokenCall(current)) return false;
      if (ts.isIdentifier(current)) return tainted.has(current.text);
      if (ts.isTemplateExpression(current)) {
        return current.templateSpans.some((span) =>
          isRawDerived(span.expression),
        );
      }
      if (ts.isTaggedTemplateExpression(current)) {
        return isRawDerived(current.template);
      }
      if (ts.isPropertyAccessExpression(current)) {
        return isRawDerived(current.expression);
      }
      if (ts.isElementAccessExpression(current)) {
        return (
          isRawDerived(current.expression) ||
          (current.argumentExpression
            ? isRawDerived(current.argumentExpression)
            : false)
        );
      }
      if (ts.isCallExpression(current)) {
        const callee = unwrap(current.expression);
        const rawReceiver =
          (ts.isPropertyAccessExpression(callee) ||
            ts.isElementAccessExpression(callee)) &&
          isRawDerived(callee.expression);
        return (
          rawReceiver ||
          current.arguments.some((argument) => isRawDerived(argument))
        );
      }
      if (ts.isNewExpression(current)) {
        return (current.arguments ?? []).some((argument) =>
          isRawDerived(argument),
        );
      }
      if (ts.isConditionalExpression(current)) {
        return (
          isRawDerived(current.whenTrue) || isRawDerived(current.whenFalse)
        );
      }
      if (ts.isBinaryExpression(current)) {
        const valueCarryingOperators = new Set([
          ts.SyntaxKind.PlusToken,
          ts.SyntaxKind.BarBarToken,
          ts.SyntaxKind.AmpersandAmpersandToken,
          ts.SyntaxKind.QuestionQuestionToken,
          ts.SyntaxKind.CommaToken,
        ]);
        return (
          valueCarryingOperators.has(current.operatorToken.kind) &&
          (isRawDerived(current.left) || isRawDerived(current.right))
        );
      }
      if (
        ts.isAwaitExpression(current) ||
        ts.isYieldExpression(current) ||
        ts.isSpreadElement(current)
      ) {
        return current.expression ? isRawDerived(current.expression) : false;
      }
      if (ts.isArrayLiteralExpression(current)) {
        return current.elements.some(
          (element) =>
            !ts.isOmittedExpression(element) && isRawDerived(element),
        );
      }
      if (ts.isObjectLiteralExpression(current)) {
        return current.properties.some((property) => {
          if (ts.isShorthandPropertyAssignment(property)) {
            return tainted.has(property.name.text);
          }
          if (
            ts.isPropertyAssignment(property) ||
            ts.isSpreadAssignment(property)
          ) {
            return isRawDerived(property.expression);
          }
          return false;
        });
      }
      return false;
    };

    const visitCatchNode = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const initializer = unwrap(node.initializer);
        if (ts.isIdentifier(node.name) && ts.isIdentifier(initializer)) {
          linkAliases(node.name.text, initializer.text);
        }
        if (isRawDerived(node.initializer)) {
          markTainted(...bindingIdentifiers(node.name));
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = unwrap(node.left);
        const right = unwrap(node.right);
        if (ts.isIdentifier(left) && ts.isIdentifier(right)) {
          linkAliases(left.text, right.text);
        }
        if (isRawDerived(node.right)) {
          if (ts.isIdentifier(left)) {
            markTainted(left.text);
          } else {
            const holder = rootIdentifier(left);
            if (holder) markTainted(holder);
          }
        }
      }
      if (
        ts.isCallExpression(node) &&
        isLoggingCall(node) &&
        node.arguments.some((argument) => isRawDerived(argument))
      ) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(
          node.getStart(sourceFile),
        );
        findings.push({
          file,
          line: line + 1,
          catchBinding: catchBindings.join(","),
        });
      }
      ts.forEachChild(node, visitCatchNode);
    };

    visitCatchNode(clause.block);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCatchClause(node)) analyzeCatch(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return findings;
}

describe("sensitive data boundary integration", () => {
  it("installs the shared safe logger before HTTP and worker bootstrap", () => {
    const main = source("main.ts");
    const worker = source("temporal/worker.ts");
    expect(main).toMatch(/installSensitiveLogger\s*\(\s*\)/);
    expect(worker).toMatch(/installSensitiveLogger\s*\(\s*\)/);
    expect(main).toMatch(
      /async function bootstrap[\s\S]*?installSensitiveLogger\(\);[\s\S]*?if \(process\.argv\.includes\(['"]--export-openapi['"]\)\)/,
    );
    expect(worker.indexOf("installSensitiveLogger()")).toBeLessThan(
      worker.indexOf(
        "const runtimeTelemetry = await startLangfuseRuntimeTelemetry()",
      ),
    );
  });

  it("admits the explicit worker owner URL before opening telemetry or service connections", () => {
    const worker = source("temporal/worker.ts");
    const admission = worker.indexOf(
      "resolvePlatformOwnerDatabaseUrl(process.env)",
    );
    expect(admission).toBeGreaterThan(-1);
    expect(admission).toBeLessThan(
      worker.indexOf("startLangfuseRuntimeTelemetry()"),
    );
    const ownerClient = worker.indexOf("const ownerDb = new PrismaClient");
    const ownerConnect = worker.indexOf("await ownerDb.$connect()");
    const ownerVerify = worker.indexOf(
      "await verifyPlatformOwnerDatabaseRole(ownerDb)",
    );
    const appConnect = worker.indexOf("await prisma.onModuleInit()");
    const providerSeed = worker.indexOf(
      "await providerRegistrySeed.seed(ownerDb)",
    );
    const rightsSeed = worker.indexOf("await seedJurisdictionPolicy(ownerDb)");
    const sanctionsSeed = worker.indexOf("await seedSanctions(ownerDb)");
    const telemetry = worker.indexOf("startLangfuseRuntimeTelemetry()");
    for (const index of [
      ownerClient,
      ownerConnect,
      ownerVerify,
      appConnect,
      providerSeed,
      rightsSeed,
      sanctionsSeed,
    ]) {
      expect(index).toBeGreaterThan(admission);
      expect(index).toBeLessThan(telemetry);
    }
    expect(worker).not.toMatch(/try\s*\{\s*await providerRegistrySeed\.seed/s);
    expect(worker).not.toMatch(
      /try\s*\{\s*const n = await seedJurisdictionPolicy/s,
    );
    expect(worker).not.toMatch(/try\s*\{\s*await seedSanctions/s);
    expect(worker).not.toMatch(
      /new PrismaClient\(\{ datasourceUrl: process\.env\.DATABASE_URL \}\)/,
    );
  });

  it("exports OpenAPI in Nest preview mode without instantiating runtime providers", () => {
    const main = source("main.ts");
    expect(main).toMatch(
      /async function exportOpenApi[\s\S]*?NestFactory\.create\([\s\S]*?AppModule\.register\(OPENAPI_DOCUMENTATION_RUNTIME\)[\s\S]*?preview:\s*true/,
    );
    expect(main).toMatch(
      /if \(process\.argv\.includes\(['"]--export-openapi['"]\)\)\s*\{\s*await exportOpenApi\(\);\s*return;/,
    );
    expect(main.indexOf("process.argv.includes('--export-openapi')")).toBeLessThan(
      main.indexOf("resolveRuntimeAdmission(process.env)"),
    );
  });

  it("scrubs both persisted AI trace errors and trace write failures", () => {
    const sink = source("model-gateway/ai-trace.sink.ts");
    expect(sink).toMatch(
      /errorMessage:[\s\S]{0,100}diagnosticErrorToken\(entry\.errorMessage/,
    );
    expect(sink).toMatch(/trace write failed:[^`]*\$\{diagnosticErrorToken\(/s);
    expect(sink).not.toMatch(/String\(err\)\.slice\(/);
  });

  it("never retains a raw upstream response-text excerpt in production source", () => {
    const rawExcerptPattern =
      /\(\s*await\s+[A-Za-z_$][\w$]*\.text\(\)\s*\)\.slice\s*\(|await\s+[A-Za-z_$][\w$]*\.text\(\)[\s\S]{0,40}\.slice\s*\(/;
    const offenders = productionTypescriptFiles()
      // These are bounded successful robots.txt/sitemap payloads used for
      // deterministic validation, not diagnostic excerpts or exception text.
      .filter(
        (file) =>
          !file.endsWith("site-builder/quality/browser-quality-runner.ts"),
      )
      .filter((file) => rawExcerptPattern.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(srcRoot.length + 1));

    expect(offenders).toEqual([]);
  });

  it("scrubs contract-shaped HttpException bodies before returning them", () => {
    const filter = source("common/http-exception.filter.ts");
    expect(filter).toMatch(/json\(scrubSensitiveData\(body\)\)/);
    expect(filter).toMatch(/scrubSensitiveData\(\{\s*error:/s);
    expect(filter).toMatch(/diagnosticErrorSummary\(exception\)/);
  });

  it("never persists pre-stringified runtime exceptions in acquisition ledgers or deletion state", () => {
    const signalIngest = source("signals/signal-ingest.service.ts");
    const acquisition = source("acquisition/acquisition.service.ts");
    const deletionWorkflow = source("temporal/deletion.workflow.ts");
    const deletionActivities = source("temporal/deletion.activities.ts");
    const toolBroker = source("tools/tool-broker.ts");

    for (const runtimeSource of [acquisition, toolBroker]) {
      expect(runtimeSource).toMatch(/diagnosticErrorToken\(/);
    }
    // Signal ingestion persists a closed machine code instead of any exception-
    // derived text, which is stricter than retaining a one-way diagnostic token.
    expect(signalIngest).toContain("'SIGNAL_FETCH_FAILED'");
    expect(signalIngest).not.toMatch(/diagnosticErrorToken\(err\)/);
    expect(signalIngest).not.toMatch(/const msg = String\(err\)/);
    expect(acquisition).not.toMatch(/error:\s*String\(err\)/);
    expect(toolBroker).not.toMatch(/this\.trace\([^;]+String\(err\)\.slice/s);
    expect(deletionWorkflow).toContain('error: "DELETION_WORKFLOW_FAILED"');
    expect(deletionWorkflow).not.toContain("error: String(err)");
    expect(deletionActivities).toMatch(
      /error:\s*diagnosticErrorToken\(args\.error\)/,
    );
  });

  it("does not pre-stringify exceptions in the controlled pilot runtime logs", () => {
    const discovery = source("discovery/discovery.service.ts");
    const taxonomy = source("discovery/taxonomy-resolver.ts");
    const worker = source("temporal/worker.ts");

    for (const runtimeSource of [discovery, taxonomy, worker]) {
      expect(runtimeSource).toMatch(/diagnosticErrorToken\(/);
    }
    expect(discovery).not.toMatch(/String\(err\)\.slice/);
    expect(taxonomy).not.toMatch(/String\(e\)\.slice/);
    expect(worker).not.toMatch(/\$\{String\(err\)\}/);
  });

  it("detects a catch binding precomputed into a raw logging alias", () => {
    const mutation = `
      async function run() {
        try { await work(); }
        catch (caught) {
          const rendered = String(caught);
          console.warn("provider failed", rendered);
        }
      }
    `;

    expect(findRawCatchLogFlows("mutation.provider.ts", mutation)).toEqual([
      {
        file: "mutation.provider.ts",
        line: 6,
        catchBinding: "caught",
      },
    ]);
  });

  it.each([
    [
      "alias plus message template",
      `try { work(); } catch (caught) {
        const alias = caught;
        const rendered = \`failure: \${alias.message}\`;
        this.log(rendered);
      }`,
    ],
    [
      "assignment plus stack",
      `try { work(); } catch (caught) {
        let rendered = "fixed";
        rendered = caught.stack;
        logger.error(rendered);
      }`,
    ],
    [
      "raw method receiver",
      `try { work(); } catch (caught) {
        const rendered = [caught].join("|");
        console.warn(rendered);
      }`,
    ],
  ])("detects %s propagation from a catch binding", (_name, mutation) => {
    expect(findRawCatchLogFlows("mutation.provider.ts", mutation)).toHaveLength(
      1,
    );
  });

  it.each([
    [
      "object member write through one alias",
      `try { work(); } catch (caught) {
        const holder = {};
        const alias = holder;
        alias.raw = caught;
        console.warn(holder.raw);
      }`,
    ],
    [
      "array element write through one alias",
      `try { work(); } catch (caught) {
        const holder: unknown[] = [];
        const alias = holder;
        alias[0] = caught;
        logger.error(holder[0]);
      }`,
    ],
  ])("detects %s as a raw error flow", (_name, mutation) => {
    expect(
      findRawCatchLogFlows(
        "discovery/providers/mutation.provider.ts",
        mutation,
      ),
    ).toHaveLength(1);
  });

  it.each([
    [
      "same-named object property",
      `const fake = { diagnosticErrorToken: String };
       try { work(); } catch (caught) {
         console.warn(fake.diagnosticErrorToken(caught));
       }`,
    ],
    [
      "same-named local function",
      `function diagnosticErrorToken(value: unknown) { return String(value); }
       try { work(); } catch (caught) {
         console.warn(diagnosticErrorToken(caught));
       }`,
    ],
    [
      "same-named import from the wrong module",
      `import { diagnosticErrorToken } from "../../common/not-the-scrubber";
       try { work(); } catch (caught) {
         console.warn(diagnosticErrorToken(caught));
       }`,
    ],
    [
      "block-local shadow over the real import",
      `import { diagnosticErrorToken } from "../../common/sensitive-data-scrubber";
       function run() {
         function diagnosticErrorToken(value: unknown) { return String(value); }
         try { work(); } catch (caught) {
           console.warn(diagnosticErrorToken(caught));
         }
       }`,
    ],
  ])("rejects %s as a diagnostic sanitizer", (_name, mutation) => {
    expect(
      findRawCatchLogFlows(
        "discovery/providers/mutation.provider.ts",
        mutation,
      ),
    ).toHaveLength(1);
  });

  it("accepts a catch binding reduced to the approved diagnostic token", () => {
    const safe = `
      import { diagnosticErrorToken } from "../../common/sensitive-data-scrubber";
      try { work(); } catch (caught) {
        const token = diagnosticErrorToken(caught);
        console.warn(\`provider failed: \${token}\`);
      }
    `;

    expect(
      findRawCatchLogFlows("discovery/providers/safe.provider.ts", safe),
    ).toEqual([]);
  });

  it("reduces every discovery provider exception log to a closed diagnostic token", () => {
    const providersDirectory = resolve(srcRoot, "discovery/providers");
    const providerSources = readdirSync(providersDirectory)
      .filter((name) => name.endsWith(".provider.ts"))
      .map((name) => ({ name, text: source(`discovery/providers/${name}`) }));

    const providersWithExceptionLogging = [
      "bigquery-patents.provider.ts",
      "companies-house.provider.ts",
      "decision-maker.provider.ts",
      "directory.provider.ts",
      "inpi-rne.provider.ts",
      "openfda.provider.ts",
      "osm.provider.ts",
      "public-web.provider.ts",
      "ted.provider.ts",
      "trade-fair.provider.ts",
      "wikidata.provider.ts",
    ];

    const rawFlows = providerSources.flatMap((provider) =>
      findRawCatchLogFlows(provider.name, provider.text),
    );
    expect(rawFlows).toEqual([]);

    for (const name of providersWithExceptionLogging) {
      const provider = providerSources.find(
        (candidate) => candidate.name === name,
      );
      expect(provider, name).toBeDefined();
      expect(provider?.text, name).toMatch(/diagnosticErrorToken\s*\(/);
    }
  });
});
