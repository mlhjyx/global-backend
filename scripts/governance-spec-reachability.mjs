// Which scripts/ specs a CI runner actually executes.
//
// A spec runs when the `run:` command of a GitHub workflow step passes it to
// `node --test` or `tsx --test`, directly or through a root package.json script
// that the command starts with `pnpm <script>`, or when a spec that runs
// imports it. Steps and jobs switched off with a literal false `if:` do not
// count. Nothing fails when a spec stops running, so such a spec drifts
// unnoticed; every spec that no runner reaches must be listed in MANUAL_SPECS
// with the reason no gate runs it and the command that does.
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
const TEST_RUNNER = /(?:^|\/)(?:node|tsx)$/;
const ROOT_PNPM_FLAGS = new Set([
  "-s",
  "--silent",
  "-w",
  "--workspace-root",
  "--if-present",
]);
const LITERAL_FALSE = /^(?:false|\$\{\{\s*false\s*\}\})$/;
const UNREACHABLE =
  "no CI runner executes this spec: import it from scripts/governance-contracts.spec.mjs if it needs no containers, run it from a workflow, or list it in MANUAL_SPECS (scripts/governance-spec-reachability.mjs) with a reason and a run command";

export const MANUAL_SPECS = Object.freeze({
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

function classifyTestArguments(tokens, start, origin) {
  const found = { paths: [], issues: [] };
  for (const argument of testArguments(tokens, start)) {
    if (isScriptsGlob(argument)) {
      found.issues.push(
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
      found.paths.push(argument);
    }
  }
  return found;
}

function pnpmScript(tokens, start) {
  let index = start;
  while (ROOT_PNPM_FLAGS.has(tokens[index])) index += 1;
  if (tokens[index] !== "run") return tokens[index];
  index += 1;
  while (ROOT_PNPM_FLAGS.has(tokens[index])) index += 1;
  return tokens[index];
}

function indentation(line) {
  return line.search(/\S/);
}

function yamlScalar(value) {
  const trimmed = value.replace(/(^|\s)#.*$/, "").trim();
  return /^(["']).*\1$/s.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function startsItem(line, column) {
  return line.length > column && /^\s*-\s+$/.test(line.slice(0, column));
}

// Lines of the YAML mapping whose keys sit at `column` around line `index`.
function mappingLines(lines, index, column) {
  const outside = (line) => {
    const indent = indentation(line);
    return indent >= 0 && indent < column;
  };
  let start = index;
  while (start > 0 && !startsItem(lines[start], column)) {
    const previous = lines[start - 1];
    if (outside(previous) && !startsItem(previous, column)) break;
    start -= 1;
  }
  let end = index + 1;
  while (end < lines.length && !outside(lines[end])) end += 1;
  return lines.slice(start, end);
}

function switchedOff(mapping, column) {
  return mapping.some(
    (line) =>
      line.slice(column).startsWith("if:") &&
      LITERAL_FALSE.test(yamlScalar(line.slice(column + 3))),
  );
}

function stepSwitchedOff(lines, index, column) {
  if (switchedOff(mappingLines(lines, index, column), column)) return true;
  for (let line = index; line >= 0; line -= 1) {
    const steps = lines[line].match(/^(\s*)steps:\s*(?:#.*)?$/);
    if (steps) {
      const jobColumn = steps[1].length;
      return switchedOff(mappingLines(lines, line, jobColumn), jobColumn);
    }
  }
  return false;
}

// The `run:` commands of workflow steps, with YAML block, folded, quoted and
// multi-line scalars read whole.
function workflowRunCommands(text) {
  const lines = text.split(/\r?\n/);
  const commands = [];
  lines.forEach((line, index) => {
    const match = line.match(/^(\s*(?:-\s+)?)run:(?:\s+(.*))?$/);
    if (!match || stepSwitchedOff(lines, index, match[1].length)) return;
    const continuation = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const indent = indentation(lines[next]);
      if (indent >= 0 && indent <= match[1].length) break;
      continuation.push(lines[next].trim());
    }
    const head = (match[2] ?? "").replace(/(^|\s)#.*$/, "").trim();
    if (/^[|>][-+0-9]*$/.test(head)) {
      commands.push(continuation.join(head.startsWith("|") ? "\n" : " "));
    } else {
      commands.push(yamlScalar([head, ...continuation].join(" ")));
    }
  });
  return commands;
}

export function findRunnerSpecPaths({ workflows, rootScripts }) {
  const paths = new Set();
  const issues = [];
  const expanded = new Set();
  const scan = (text, origin) => {
    for (const line of commandLines(text)) {
      const tokens = line.match(SHELL_TOKEN) ?? [];
      let segment = 0;
      tokens.forEach((token, index) => {
        if (SHELL_SEPARATORS.has(token)) {
          segment = index + 1;
        } else if (token === "pnpm") {
          const script = pnpmScript(tokens, index + 1);
          if (Object.hasOwn(rootScripts, script) && !expanded.has(script)) {
            expanded.add(script);
            scan(rootScripts[script], origin);
          }
        } else if (
          token === "--test" &&
          tokens.slice(segment, index).some((word) => TEST_RUNNER.test(word))
        ) {
          const found = classifyTestArguments(tokens, index + 1, origin);
          found.paths.forEach((path) => paths.add(path));
          issues.push(...found.issues);
        }
      });
    }
  };
  for (const { path, text } of workflows) {
    for (const command of workflowRunCommands(text)) scan(command, path);
  }
  return { paths: [...paths].sort(), issues: sortIssues(issues) };
}

// An import whose bindings are all `type` is elided as well: tsconfig.base.json
// does not enable verbatimModuleSyntax.
function isTypeOnlyImport(clause) {
  if (clause === undefined) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return (
    clause.name === undefined &&
    bindings !== undefined &&
    ts.isNamedImports(bindings) &&
    bindings.elements.length > 0 &&
    bindings.elements.every((element) => element.isTypeOnly)
  );
}

// Parsed rather than pattern-matched, so imports inside comments or strings
// and type-only imports (erased before the spec runs) do not count.
export function findRelativeImports(source) {
  const found = [];
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) && !isTypeOnlyImport(node.importClause)) ||
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

async function walkImports(roots, known, readSource) {
  const visited = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const path = queue.shift();
    if (visited.has(path)) continue;
    visited.add(path);
    for (const specifier of findRelativeImports(await readSource(path))) {
      const target = posix.join(posix.dirname(path), specifier);
      if (known.has(target) && !visited.has(target)) queue.push(target);
    }
  }
  return visited;
}

function manualSpecIssues(manualSpecs, specs, visited) {
  const issues = [];
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
  return issues;
}

export async function analyzeSpecReachability({
  files,
  runnerPaths,
  readSource,
  manualSpecs,
}) {
  const known = new Set(files);
  const specs = files.filter((path) => SPEC_FILE.test(path));
  const visited = await walkImports(
    runnerPaths.filter((path) => known.has(path)),
    known,
    readSource,
  );
  const issues = [
    ...runnerPaths
      .filter((path) => !known.has(path))
      .map((path) =>
        issue(
          "SPEC_RUNNER_TARGET_MISSING",
          path,
          "a CI runner names a spec that does not exist",
        ),
      ),
    ...specs
      .filter((path) => !visited.has(path) && !Object.hasOwn(manualSpecs, path))
      .map((path) => issue("SPEC_UNREACHABLE", path, UNREACHABLE)),
    ...manualSpecIssues(manualSpecs, specs, visited),
  ];
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
