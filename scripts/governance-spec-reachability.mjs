// Which scripts/ specs a CI runner actually executes.
//
// A spec runs when a GitHub workflow `run` line passes it to `node --test` or
// `tsx --test`, directly or through a root package.json script that the line
// starts with `pnpm <script>`, or when a spec that runs imports it. Nothing
// fails when a spec stops running, so such a spec drifts unnoticed; every spec
// that no runner reaches must be listed in MANUAL_SPECS with the reason no gate
// runs it and the command that does.
import { readdir, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DEFAULT_REPO_ROOT = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const SCRIPTS_DIRECTORY = "scripts";
const WORKFLOW_DIRECTORY = ".github/workflows";
const SPEC_FILE = /\.(?:spec|test)\.[cm]?[jt]s$/;
const GLOB_CHARACTER = /[*?[\]{}]/;
const SHELL_TOKEN = /&&|\|\||[;&|]|[^\s;&|]+/g;
const SHELL_SEPARATORS = new Set(["&&", "||", ";", "&", "|"]);

export const MANUAL_SPECS = Object.freeze({
  "scripts/execution-authority-policy.spec.mjs": Object.freeze({
    reason:
      "Fails on main and stays out of the gates until it is re-baselined: the pinned router-model-gateway.ts fingerprint has not matched since d5e4bc42 (2026-08-26), and the Tool, Model task and projection inventories no longer match current sources (25 issues on 2026-09-30). Re-pinning the Router/ToolBroker fence needs its own security review.",
    run: "node --test scripts/execution-authority-policy.spec.mjs",
  }),
  "scripts/platform-authority-policy-import.cross-repo.spec.mjs": Object.freeze(
    {
      reason:
        "Materializes the private GrowthOS authority checkout (GROWTHOS_AUTHORITY_ROOT, default /global/frontend/growthos-source), which CI does not check out.",
      run: "node scripts/verify-platform-authority-policy-import.mjs",
    },
  ),
  "scripts/runtime-worker-namespace-lease.postgres.spec.mjs": Object.freeze({
    reason:
      "Starts a disposable postgres:16-alpine container through `docker --context default` and skips unless RUN_RUNTIME_WORKER_NAMESPACE_POSTGRES=1. CI covers only the lease role permission matrix, through infra/postgres/verify-runtime-lease-principal-permissions.sh.",
    run: "RUN_RUNTIME_WORKER_NAMESPACE_POSTGRES=1 node --test scripts/runtime-worker-namespace-lease.postgres.spec.mjs",
  }),
});

function issue(code, path, message) {
  return Object.freeze({ code, path, message });
}

function sortIssues(issues) {
  const key = ({ code, path }) => `${code} ${path}`;
  return issues.toSorted((left, right) =>
    key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0,
  );
}

function commandLines(text) {
  return text
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"));
}

function testArguments(tokens, start) {
  const values = [];
  for (const token of tokens.slice(start)) {
    if (SHELL_SEPARATORS.has(token)) break;
    if (token.startsWith("-")) continue;
    values.push(posix.normalize(token.replace(/^["']|["']$/g, "")));
  }
  return values;
}

function isScriptsGlob(argument) {
  const [head] = argument.split("/");
  return (
    GLOB_CHARACTER.test(argument) &&
    (head === SCRIPTS_DIRECTORY || GLOB_CHARACTER.test(head))
  );
}

export function findRunnerSpecPaths({ workflows, rootScripts }) {
  const paths = new Set();
  const issues = [];
  const expanded = new Set();
  const scan = (text, origin) => {
    for (const line of commandLines(text)) {
      const tokens = line.match(SHELL_TOKEN) ?? [];
      tokens.forEach((token, index) => {
        if (token === "pnpm") {
          const script =
            tokens[index + 1] === "run" ? tokens[index + 2] : tokens[index + 1];
          if (Object.hasOwn(rootScripts, script) && !expanded.has(script)) {
            expanded.add(script);
            scan(rootScripts[script], origin);
          }
          return;
        }
        if (token !== "--test") return;
        for (const argument of testArguments(tokens, index + 1)) {
          if (isScriptsGlob(argument)) {
            issues.push(
              issue(
                "SPEC_RUNNER_GLOB_UNSUPPORTED",
                origin,
                `list the specs explicitly instead of the glob ${argument}`,
              ),
            );
          } else if (
            argument.startsWith(`${SCRIPTS_DIRECTORY}/`) &&
            SPEC_FILE.test(argument)
          ) {
            paths.add(argument);
          }
        }
      });
    }
  };
  for (const { path, text } of workflows) scan(text, path);
  return { paths: [...paths].sort(), issues: sortIssues(issues) };
}

// Parsed rather than pattern-matched, so imports inside comments or strings
// and type-only imports (erased before the spec runs) do not count.
export function findRelativeImports(source) {
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) ||
      (ts.isExportDeclaration(node) && !node.isTypeOnly)
    ) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        found.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(
    ts.createSourceFile(
      "source.mts",
      source,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    ),
  );
  return found.filter((specifier) => /^\.\.?\//.test(specifier));
}

function isCompleteManualEntry(entry) {
  return ["reason", "run"].every(
    (field) =>
      typeof entry?.[field] === "string" && entry[field].trim().length > 0,
  );
}

export async function analyzeSpecReachability({
  files,
  runnerPaths,
  readSource,
  manualSpecs,
}) {
  const known = new Set(files);
  const issues = [];
  const visited = new Set();
  const queue = [];
  for (const path of runnerPaths) {
    if (known.has(path)) queue.push(path);
    else
      issues.push(
        issue(
          "SPEC_RUNNER_TARGET_MISSING",
          path,
          "a CI runner names a spec that does not exist",
        ),
      );
  }
  while (queue.length > 0) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    for (const specifier of findRelativeImports(await readSource(path))) {
      const target = posix.join(posix.dirname(path), specifier);
      if (known.has(target) && !visited.has(target)) queue.push(target);
    }
  }
  const specs = files.filter((path) => SPEC_FILE.test(path));
  for (const path of specs) {
    if (visited.has(path) || Object.hasOwn(manualSpecs, path)) continue;
    issues.push(
      issue(
        "SPEC_UNREACHABLE",
        path,
        "no CI runner executes this spec: import it from scripts/governance-contracts.spec.mjs if it needs no containers, run it from a workflow, or list it in MANUAL_SPECS (scripts/governance-spec-reachability.mjs) with a reason and a run command",
      ),
    );
  }
  for (const [path, entry] of Object.entries(manualSpecs)) {
    if (!specs.includes(path)) {
      issues.push(
        issue(
          "MANUAL_SPEC_MISSING",
          path,
          "MANUAL_SPECS names a spec that does not exist",
        ),
      );
    } else if (visited.has(path)) {
      issues.push(
        issue(
          "MANUAL_SPEC_REACHABLE",
          path,
          "a CI runner already executes this spec; remove its MANUAL_SPECS entry",
        ),
      );
    }
    if (!isCompleteManualEntry(entry)) {
      issues.push(
        issue(
          "MANUAL_SPEC_INCOMPLETE",
          path,
          "a manual spec needs a non-empty reason and run command",
        ),
      );
    }
  }
  return {
    reachable: specs.filter((path) => visited.has(path)),
    issues: sortIssues(issues),
  };
}

export async function listScriptFiles(repoRoot = DEFAULT_REPO_ROOT) {
  const files = [];
  const walk = async (directory) => {
    const entries = await readdir(join(repoRoot, directory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const path = posix.join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  await walk(SCRIPTS_DIRECTORY);
  return files.sort();
}

export async function inspectRepositorySpecReachability(
  repoRoot = DEFAULT_REPO_ROOT,
) {
  const workflowNames = (await readdir(join(repoRoot, WORKFLOW_DIRECTORY)))
    .filter((name) => /\.ya?ml$/.test(name))
    .sort();
  const workflows = await Promise.all(
    workflowNames.map(async (name) => ({
      path: `${WORKFLOW_DIRECTORY}/${name}`,
      text: await readFile(join(repoRoot, WORKFLOW_DIRECTORY, name), "utf8"),
    })),
  );
  const { scripts: rootScripts = {} } = JSON.parse(
    await readFile(join(repoRoot, "package.json"), "utf8"),
  );
  const runners = findRunnerSpecPaths({ workflows, rootScripts });
  const analysis = await analyzeSpecReachability({
    files: await listScriptFiles(repoRoot),
    runnerPaths: runners.paths,
    readSource: (path) => readFile(join(repoRoot, path), "utf8"),
    manualSpecs: MANUAL_SPECS,
  });
  return {
    runnerPaths: runners.paths,
    reachable: analysis.reachable,
    issues: sortIssues([...runners.issues, ...analysis.issues]),
  };
}
