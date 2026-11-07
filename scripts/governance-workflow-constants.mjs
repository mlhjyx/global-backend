#!/usr/bin/env node
// Workflow numeric constants (audit L01, 2026-11-08).
//
// A Temporal workflow must schedule the same commands on replay as it recorded
// live. A module-level numeric constant used in a branch or loop bound breaks
// that the moment someone edits it: in-flight histories then replay into a
// different command sequence and the worker fails them with a
// nondeterminism error (NDE). Tunable numbers therefore travel in the recorded
// workflow input (see DiscoveryRunInput.run2PoolSearchFallbackThreshold and
// friends, injected by the outbox relay), and the constants that legitimately
// stay in code are frozen replay contract:
//
//   - a recorded default that histories without the input field replay on;
//   - a contract version that is itself recorded in every input;
//   - an activity payload size that does not change the command sequence.
//
// This check fails when a workflow file declares a module-level numeric
// constant that has no allowlist entry with its reason, and when an allowlist
// entry goes stale. Reasons live next to the entries below so a reviewer sees
// why a constant may never change.
//
//   node scripts/governance-workflow-constants.mjs verify [--root <dir>]
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_DIRECTORY = "apps/api/src/temporal";
const WORKFLOW_FILE = /\.workflow\.ts$/;

/**
 * Numeric constants a workflow file may keep. Every entry states why changing
 * it cannot desynchronize a replay; tuning must go through the workflow input.
 */
export const WORKFLOW_CONSTANT_ALLOWLIST = Object.freeze({
  "apps/api/src/temporal/discovery.workflow.ts": Object.freeze({
    EXECUTION_CONTRACT_VERSION:
      "execution contract version recorded in every run input; bumping it is a contract change (invalidAuthorityInput), never a tuning knob",
  }),
  "apps/api/src/temporal/understanding.workflow.ts": Object.freeze({
    EXECUTION_CONTRACT_VERSION:
      "execution contract version recorded in every run input; bumping it is a contract change, never a tuning knob",
  }),
  "apps/api/src/temporal/raw-retention.workflow.ts": Object.freeze({
    BUDGET_RECONCILE_BATCH:
      "activity payload batch size; changing it does not alter the scheduled command sequence (loops end on activity results, not on this value)",
    MAX_BUDGET_RECONCILE_BATCHES:
      "frozen replay default for histories without the maxBudgetReconcileBatches input field; tune through the sweep input",
    MAX_BATCHES_PER_WORKSPACE:
      "frozen replay default for histories without the maxBatchesPerWorkspace input field; tune through the sweep input",
    DEFAULT_PAGES_PER_RUN:
      "frozen replay default for histories without the workspacePagesPerRun input field; tune through the sweep input",
    MAX_PAGES_PER_RUN:
      "frozen replay default for histories without the maxPagesPerRun input field; tune through the sweep input",
    PERSONAL_DATA_AUDIT_BATCH:
      "activity payload batch size; changing it does not alter the scheduled command sequence (loops end on activity results, not on this value)",
  }),
  "apps/api/src/temporal/external-intent.workflow.ts": Object.freeze({
    LIVE_REFRESH_EVERY:
      "pending input-ization (L01 follow-up, tracked in docs/superpowers/plans); frozen until then — editing it can NDE an in-flight sweep",
  }),
  "apps/api/src/temporal/kb-recovery.workflow.ts": Object.freeze({
    MAX_CANDIDATES:
      "pending input-ization (L01 follow-up, tracked in docs/superpowers/plans); frozen until then — editing it can NDE an in-flight sweep",
    MAX_CONCURRENCY:
      "pending input-ization (L01 follow-up, tracked in docs/superpowers/plans); frozen until then — editing it can NDE an in-flight sweep",
  }),
  "apps/api/src/temporal/personal-artifact-cleanup.workflow.ts": Object.freeze({
    COMMANDS_PER_HISTORY:
      "pending input-ization (L01 follow-up, tracked in docs/superpowers/plans); frozen until then — editing it can NDE an in-flight cleanup",
  }),
  "apps/api/src/temporal/refurbish.workflow.ts": Object.freeze({
    MAX_IMAGE_BATCHES_PER_BUILD:
      "pending input-ization (L01 follow-up, tracked in docs/superpowers/plans); frozen until then — editing it can NDE an in-flight build",
  }),
});

function issue(code, path, message) {
  return Object.freeze({ code, path, message });
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isNumericInitializer(expression) {
  const unwrapped = unwrapExpression(expression);
  if (ts.isNumericLiteral(unwrapped)) return true;
  return (
    ts.isPrefixUnaryExpression(unwrapped) &&
    unwrapped.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(unwrapped.operand)
  );
}

/** Module-level `const NAME = <number literal>;` declarations in one source. */
export function numericConstantsInSource(source, fileName = "workflow.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name)) continue;
      if (!declaration.initializer) continue;
      if (!isNumericInitializer(declaration.initializer)) continue;
      found.push(
        Object.freeze({
          name: declaration.name.text,
          line:
            sourceFile.getLineAndCharacterOfPosition(
              declaration.getStart(sourceFile),
            ).line + 1,
        }),
      );
    }
  }
  return found;
}

async function listWorkflowFiles(root) {
  const directory = join(root, WORKFLOW_DIRECTORY);
  const files = [];
  async function walk(current) {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && WORKFLOW_FILE.test(entry.name)) {
        files.push(relative(root, full).split(sep).join("/"));
      }
    }
  }
  await walk(directory);
  return files.sort();
}

/**
 * Fails when a workflow file carries a numeric constant without an allowlist
 * reason, and when an allowlisted entry no longer matches a constant.
 */
export async function inspectWorkflowConstants(
  root = ROOT,
  { allowlist = WORKFLOW_CONSTANT_ALLOWLIST } = {},
) {
  const issues = [];
  const files = await listWorkflowFiles(root);
  const seen = new Set();
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    for (const constant of numericConstantsInSource(source, file)) {
      seen.add(`${file} ${constant.name}`);
      const reason = allowlist[file]?.[constant.name];
      if (typeof reason !== "string" || reason.trim() === "") {
        issues.push(
          issue(
            "WORKFLOW_CONSTANT_NOT_ALLOWLISTED",
            `${file}:${constant.line}`,
            `${constant.name} is a module-level numeric constant in a workflow file. ` +
              "Move the value into the recorded workflow input (relay-injected, like DiscoveryRunInput.run2PoolSearchFallbackThreshold) " +
              "or add an allowlist entry in scripts/governance-workflow-constants.mjs stating why changing it cannot desynchronize a replay.",
          ),
        );
      }
    }
  }
  for (const [file, constants] of Object.entries(allowlist)) {
    for (const name of Object.keys(constants)) {
      if (!seen.has(`${file} ${name}`)) {
        issues.push(
          issue(
            "WORKFLOW_CONSTANT_ALLOWLIST_STALE",
            file,
            `allowlist entry ${name} no longer matches a numeric constant in this file; remove the entry.`,
          ),
        );
      }
    }
  }
  return Object.freeze(issues);
}

function parseArguments(argv) {
  const options = { command: argv[0], root: ROOT };
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--root") {
      options.root = resolve(argv[index + 1]);
      index += 1;
    }
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv);
    if (options.command !== "verify") {
      throw new Error(
        "usage: governance-workflow-constants.mjs verify [--root <dir>]",
      );
    }
    const issues = await inspectWorkflowConstants(options.root);
    for (const entry of issues) {
      console.error(`::error::${entry.path}: ${entry.message}`);
    }
    console.log(
      `workflow constants: ${issues.length === 0 ? "PASS" : "FAIL"}`,
    );
    return issues.length === 0 ? 0 : 1;
  } catch (error) {
    console.error(`::error::${error.message}`);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
