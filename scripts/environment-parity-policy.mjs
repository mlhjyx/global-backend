#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const POLICY_PATH = "docs/governance/environment-parity-policy.json";
const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/u;
const SHA_256 = /^sha256:[0-9a-f]{64}$/u;
const ALLOWABLE_CONFIGURATION_RULES = new Set(["ENVIRONMENT_BRANCH"]);
const PERMITTED_DIFFERENCE_CATEGORIES = new Set([
  "trust",
  "endpoint",
  "secret",
  "network",
  "resource",
  "observability",
  "deployment",
  "test-process",
]);

const SOURCE_RULE_NAMES = new Set([
  "LEGACY_MODEL_SETTLEMENT_GATE",
  "DEV_ONLY_RUNTIME_SYMBOL",
  "SYNTHETIC_PROVIDER_RUNTIME_PATH",
  "TEST_ONLY_RUNTIME_HOOK",
  "UNPINNED_RUNTIME_IDENTITY",
  "HIDDEN_PRODUCT_BUDGET_CAP",
  "ENVIRONMENT_BRANCH",
]);
const DEV_ONLY_IDENTIFIERS = new Set([
  "StubModelProvider",
  "SandboxDiscoveryProvider",
  "DevTokenVerifier",
]);
const SYNTHETIC_IDENTIFIERS = new Set([
  "stubAllowed",
  "MODEL_ALLOW_STUB",
  "DISCOVERY_ALLOW_SANDBOX",
]);
const ENVIRONMENT_KEYS = new Set(["NODE_ENV", "APP_ENVIRONMENT"]);
const ENVIRONMENT_VALUES = new Set([
  "development",
  "test",
  "pilot",
  "production",
]);
const COMPARISON_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
]);
const LEGACY_SETTLEMENT =
  /SITE_BUILDER_MODEL_SETTLEMENT_ATTESTATION_(?:PATH|SHA256)|MODEL_PREFLIGHT_[A-Z0-9_]*ATTEST[A-Z0-9_]*/u;

function issue(code, message) {
  return Object.freeze({ code, message });
}

function normalizePath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//u, "");
}

function normalizedSource(value) {
  return String(value).trim().replace(/\s+/gu, " ");
}

function findingKey(finding) {
  return [finding.rule, finding.path, findingFingerprint(finding)].join("\0");
}

export function findingFingerprint(finding) {
  const digest = createHash("sha256")
    .update(
      [
        String(finding.rule),
        normalizePath(finding.path),
        normalizedSource(finding.source),
        String(finding.occurrence ?? 1),
      ].join("\0"),
    )
    .digest("hex");
  return `sha256:${digest}`;
}

function isProductSource(policy, path) {
  if (!SOURCE_EXTENSION.test(path)) return false;
  if (
    !(policy.product_source_roots ?? []).some(
      (root) => path === root || path.startsWith(`${root}/`),
    )
  ) {
    return false;
  }
  return !(policy.excluded_path_patterns ?? []).some((pattern) =>
    new RegExp(pattern, "u").test(path),
  );
}

function productManifestPaths(policy) {
  return new Set(policy.product_runtime_manifests ?? []);
}

function stringValue(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function propertyName(node) {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    return stringValue(node.argumentExpression);
  }
  if (ts.isPropertyAssignment(node)) {
    return ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name)
      ? node.name.text
      : null;
  }
  return null;
}

function environmentBindingIdentifier(node) {
  if (!ts.isBindingElement(node) || !ts.isIdentifier(node.name)) return null;
  const sourceName = node.propertyName
    ? ts.isIdentifier(node.propertyName) ||
      ts.isStringLiteralLike(node.propertyName)
      ? node.propertyName.text
      : null
    : node.name.text;
  return ENVIRONMENT_KEYS.has(sourceName) ? node.name.text : null;
}

function containsEnvironmentAccess(node) {
  let found = false;
  function visit(candidate) {
    if (ENVIRONMENT_KEYS.has(propertyName(candidate))) {
      found = true;
      return;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(node);
  return found;
}

function environmentAnchor(node) {
  let candidate = node;
  let comparison = node;
  while (candidate.parent && !ts.isSourceFile(candidate.parent)) {
    candidate = candidate.parent;
    if (
      ts.isBinaryExpression(candidate) &&
      COMPARISON_OPERATORS.has(candidate.operatorToken.kind)
    ) {
      comparison = candidate;
      continue;
    }
    if (
      ts.isIfStatement(candidate) ||
      ts.isWhileStatement(candidate) ||
      ts.isDoStatement(candidate)
    ) {
      return candidate.expression;
    }
    if (ts.isConditionalExpression(candidate)) {
      return candidate.condition;
    }
    if (
      ts.isVariableDeclaration(candidate) ||
      ts.isPropertyAssignment(candidate) ||
      ts.isReturnStatement(candidate)
    ) {
      return candidate;
    }
  }
  return comparison;
}

function runtimeSymbolAnchor(node) {
  let candidate = node;
  while (candidate.parent && !ts.isSourceFile(candidate.parent)) {
    const parent = candidate.parent;
    if (
      ts.isImportDeclaration(parent) ||
      ts.isNewExpression(parent) ||
      ts.isCallExpression(parent) ||
      ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isReturnStatement(parent) ||
      ts.isExpressionStatement(parent)
    ) {
      return parent;
    }
    if (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent)) {
      return node;
    }
    candidate = parent;
  }
  return node;
}

function modeComparison(node, environmentIdentifiers) {
  if (
    !ts.isBinaryExpression(node) ||
    !COMPARISON_OPERATORS.has(node.operatorToken.kind)
  ) {
    return false;
  }
  const leftText = node.left.getText();
  const rightText = node.right.getText();
  const leftValue = stringValue(node.left);
  const rightValue = stringValue(node.right);
  const environmentOperand = (text) =>
    /(?:^|\.)(?:mode|nodeEnv|runtimeMode|appEnvironment)$/iu.test(text) ||
    environmentIdentifiers.has(text);
  return (
    (rightValue !== null &&
      ENVIRONMENT_VALUES.has(rightValue) &&
      environmentOperand(leftText)) ||
    (leftValue !== null &&
      ENVIRONMENT_VALUES.has(leftValue) &&
      environmentOperand(rightText))
  );
}

function syntheticComparison(node) {
  if (
    !ts.isBinaryExpression(node) ||
    !COMPARISON_OPERATORS.has(node.operatorToken.kind)
  ) {
    return false;
  }
  return [stringValue(node.left), stringValue(node.right)].some(
    (value) => value === "stub" || value === "sandbox",
  );
}

function isForbiddenRuntimeSpecifier(policy, value) {
  return (policy.forbidden_runtime_dependencies ?? []).some(
    (dependency) => value === dependency || value.startsWith(`${dependency}/`),
  );
}

function sourceFindings(policy, path, source) {
  if (!isProductSource(policy, path)) return [];
  const findings = [];
  const occurrences = new Map();
  const sourceFile = ts.createSourceFile(
    path,
    String(source),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const environmentIdentifiers = new Set();

  function collectEnvironmentIdentifiers(node) {
    const boundEnvironment = environmentBindingIdentifier(node);
    if (boundEnvironment) environmentIdentifiers.add(boundEnvironment);
    if (
      (ts.isVariableDeclaration(node) || ts.isParameter(node)) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      containsEnvironmentAccess(node.initializer)
    ) {
      environmentIdentifiers.add(node.name.text);
    }
    ts.forEachChild(node, collectEnvironmentIdentifiers);
  }
  collectEnvironmentIdentifiers(sourceFile);

  const emitted = new Set();
  function emit(rule, node, anchor = node) {
    const sourceText = normalizedSource(anchor.getText(sourceFile));
    const positionKey = `${rule}\0${anchor.pos}\0${anchor.end}`;
    if (emitted.has(positionKey)) return;
    emitted.add(positionKey);
    const occurrenceKey = `${rule}\0${sourceText}`;
    const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
    occurrences.set(occurrenceKey, occurrence);
    findings.push(
      Object.freeze({
        rule,
        path,
        line:
          sourceFile.getLineAndCharacterOfPosition(anchor.getStart(sourceFile))
            .line + 1,
        source: sourceText,
        occurrence,
      }),
    );
  }

  function visit(node) {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      isForbiddenRuntimeSpecifier(policy, node.moduleSpecifier.text)
    ) {
      emit("TEST_RUNTIME_DEPENDENCY_FORBIDDEN", node);
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      isForbiddenRuntimeSpecifier(policy, node.arguments[0].text) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) &&
          node.expression.text === "require"))
    ) {
      emit("TEST_RUNTIME_DEPENDENCY_FORBIDDEN", node);
    }
    if (ts.isIdentifier(node)) {
      if (DEV_ONLY_IDENTIFIERS.has(node.text)) {
        emit("DEV_ONLY_RUNTIME_SYMBOL", node, runtimeSymbolAnchor(node));
      }
      if (SYNTHETIC_IDENTIFIERS.has(node.text)) {
        emit(
          "SYNTHETIC_PROVIDER_RUNTIME_PATH",
          node,
          runtimeSymbolAnchor(node),
        );
      }
      if (/ForTest$/u.test(node.text)) {
        emit("TEST_ONLY_RUNTIME_HOOK", node, runtimeSymbolAnchor(node));
      }
      if (LEGACY_SETTLEMENT.test(node.text)) {
        emit("LEGACY_MODEL_SETTLEMENT_GATE", node, runtimeSymbolAnchor(node));
      }
      if (node.text === "SITE_BUILD_BUDGET_CENTS") {
        emit("HIDDEN_PRODUCT_BUDGET_CAP", node, runtimeSymbolAnchor(node));
      }
    }
    if (environmentBindingIdentifier(node)) {
      emit("ENVIRONMENT_BRANCH", node, environmentAnchor(node));
    }
    const literal = stringValue(node);
    if (literal !== null) {
      if (LEGACY_SETTLEMENT.test(literal)) {
        emit("LEGACY_MODEL_SETTLEMENT_GATE", node, runtimeSymbolAnchor(node));
      }
      if (literal.includes("dev-unpinned")) {
        emit("UNPINNED_RUNTIME_IDENTITY", node, runtimeSymbolAnchor(node));
      }
      if (literal === "SITE_BUILD_BUDGET_CENTS") {
        emit("HIDDEN_PRODUCT_BUDGET_CAP", node, runtimeSymbolAnchor(node));
      }
    }
    if (syntheticComparison(node)) {
      emit("SYNTHETIC_PROVIDER_RUNTIME_PATH", node);
    }
    if (modeComparison(node, environmentIdentifiers)) {
      emit("ENVIRONMENT_BRANCH", node, environmentAnchor(node));
    }
    if (ENVIRONMENT_KEYS.has(propertyName(node))) {
      emit("ENVIRONMENT_BRANCH", node, environmentAnchor(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return findings;
}

function dependencyFindings(policy, path, source) {
  if (!productManifestPaths(policy).has(path)) return [];
  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch {
    return [
      Object.freeze({
        rule: "PRODUCT_MANIFEST_INVALID",
        path,
        line: 1,
        source: "invalid package.json",
        occurrence: 1,
      }),
    ];
  }
  const findings = [];
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = manifest?.[section];
    if (!dependencies || typeof dependencies !== "object") continue;
    for (const dependency of policy.forbidden_runtime_dependencies ?? []) {
      if (!Object.hasOwn(dependencies, dependency)) continue;
      findings.push(
        Object.freeze({
          rule: "TEST_RUNTIME_DEPENDENCY_FORBIDDEN",
          path,
          line: 1,
          source: `${section}:${dependency}`,
          occurrence: 1,
        }),
      );
    }
  }
  return findings;
}

export function scanEnvironmentParityFindings(policy, repositoryFiles) {
  const findings = [];
  for (const [rawPath, source] of repositoryFiles) {
    const path = normalizePath(rawPath);
    findings.push(...sourceFindings(policy, path, source));
    findings.push(...dependencyFindings(policy, path, source));
  }
  return findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  );
}

function validRelativePath(value) {
  if (typeof value !== "string" || !value || value.startsWith("/")) {
    return false;
  }
  const normalized = normalizePath(value);
  return (
    normalized === value &&
    !normalized.split("/").some((part) => part === ".." || part === "")
  );
}

function validatePolicyShape(policy, issues) {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    policy.schema_version !== "environment-parity-policy/v1"
  ) {
    issues.push(
      issue(
        "ENVIRONMENT_PARITY_POLICY_INVALID",
        "schema_version must equal environment-parity-policy/v1",
      ),
    );
    return;
  }
  if (
    !Array.isArray(policy.product_source_roots) ||
    policy.product_source_roots.length === 0 ||
    policy.product_source_roots.some((path) => !validRelativePath(path))
  ) {
    issues.push(
      issue(
        "ENVIRONMENT_PARITY_POLICY_INVALID",
        "product_source_roots must contain repository-relative directories",
      ),
    );
  }
  if (
    !Array.isArray(policy.excluded_path_patterns) ||
    policy.excluded_path_patterns.some((pattern) => {
      try {
        new RegExp(pattern, "u");
        return false;
      } catch {
        return true;
      }
    })
  ) {
    issues.push(
      issue(
        "ENVIRONMENT_PARITY_POLICY_INVALID",
        "excluded_path_patterns must contain valid regular expressions",
      ),
    );
  }
  if (
    !Array.isArray(policy.product_runtime_manifests) ||
    policy.product_runtime_manifests.length === 0 ||
    policy.product_runtime_manifests.some((path) => !validRelativePath(path))
  ) {
    issues.push(
      issue(
        "ENVIRONMENT_PARITY_POLICY_INVALID",
        "product_runtime_manifests must contain repository-relative package manifests",
      ),
    );
  }
  if (
    !Array.isArray(policy.allowed_difference_categories) ||
    policy.allowed_difference_categories.length === 0 ||
    new Set(policy.allowed_difference_categories).size !==
      policy.allowed_difference_categories.length ||
    policy.allowed_difference_categories.some(
      (category) => !PERMITTED_DIFFERENCE_CATEGORIES.has(category),
    )
  ) {
    issues.push(
      issue(
        "ENVIRONMENT_PARITY_POLICY_INVALID",
        "allowed_difference_categories must contain unique categories",
      ),
    );
  }
  if (
    !Array.isArray(policy.forbidden_runtime_dependencies) ||
    policy.forbidden_runtime_dependencies.length === 0 ||
    policy.forbidden_runtime_dependencies.some(
      (dependency) => typeof dependency !== "string" || !dependency,
    )
  ) {
    issues.push(
      issue(
        "ENVIRONMENT_PARITY_POLICY_INVALID",
        "forbidden_runtime_dependencies must contain package names",
      ),
    );
  }
}

function validateAllowances(policy, findings, issues) {
  const allowedCategories = new Set(policy.allowed_difference_categories ?? []);
  const allowances = [
    ...(policy.configuration_allowlist ?? []).map((entry) => ({
      ...entry,
      kind: "configuration",
    })),
    ...(policy.migration_allowlist ?? []).map((entry) => ({
      ...entry,
      kind: "migration",
    })),
  ];
  const ids = new Set();
  const keys = new Set();
  for (const allowance of allowances) {
    const validCommon =
      allowance &&
      typeof allowance === "object" &&
      typeof allowance.id === "string" &&
      allowance.id.length > 0 &&
      typeof allowance.rule === "string" &&
      SOURCE_RULE_NAMES.has(allowance.rule) &&
      validRelativePath(allowance.path) &&
      SHA_256.test(allowance.match_sha256 ?? "") &&
      typeof allowance.reason === "string" &&
      allowance.reason.trim().length > 0;
    const validSpecific =
      allowance.kind === "configuration"
        ? ALLOWABLE_CONFIGURATION_RULES.has(allowance.rule) &&
          allowedCategories.has(allowance.category)
        : typeof allowance.target_state === "string" &&
          allowance.target_state.trim().length > 0;
    if (!validCommon || !validSpecific) {
      issues.push(
        issue(
          "ENVIRONMENT_ALLOWANCE_INVALID",
          `invalid ${allowance.kind} allowance: ${allowance?.id ?? "<missing>"}`,
        ),
      );
      continue;
    }
    const key = [allowance.rule, allowance.path, allowance.match_sha256].join(
      "\0",
    );
    if (ids.has(allowance.id) || keys.has(key)) {
      issues.push(
        issue(
          "ENVIRONMENT_ALLOWANCE_DUPLICATE",
          `duplicate environment parity allowance: ${allowance.id}`,
        ),
      );
      continue;
    }
    ids.add(allowance.id);
    keys.add(key);
  }

  const findingsByKey = new Map(
    findings.map((finding) => [findingKey(finding), finding]),
  );
  const allowancesByKey = new Map(
    allowances
      .filter(
        (allowance) =>
          typeof allowance?.rule === "string" &&
          typeof allowance?.path === "string" &&
          typeof allowance?.match_sha256 === "string",
      )
      .map((allowance) => [
        [allowance.rule, allowance.path, allowance.match_sha256].join("\0"),
        allowance,
      ]),
  );

  for (const finding of findings) {
    if (allowancesByKey.has(findingKey(finding))) continue;
    if (finding.rule === "TEST_RUNTIME_DEPENDENCY_FORBIDDEN") {
      issues.push(
        issue(
          "TEST_RUNTIME_DEPENDENCY_FORBIDDEN",
          `${finding.path}: test-only workspace is a product runtime dependency`,
        ),
      );
      continue;
    }
    if (finding.rule === "PRODUCT_MANIFEST_INVALID") {
      issues.push(
        issue(
          "PRODUCT_MANIFEST_INVALID",
          `${finding.path}: product package manifest is invalid JSON`,
        ),
      );
      continue;
    }
    issues.push(
      issue(
        "ENVIRONMENT_PARITY_VIOLATION",
        `${finding.path}:${finding.line}: unapproved ${finding.rule} (${findingFingerprint(finding)})`,
      ),
    );
  }

  for (const [key, allowance] of allowancesByKey) {
    if (findingsByKey.has(key)) continue;
    issues.push(
      issue(
        "ENVIRONMENT_ALLOWANCE_STALE",
        `${allowance.path}: allowance no longer matches source: ${allowance.id}`,
      ),
    );
  }
}

export function validateEnvironmentParityPolicy(policy, repositoryFiles) {
  const issues = [];
  validatePolicyShape(policy, issues);
  if (issues.length > 0) {
    return Object.freeze({ issues, finding_count: 0 });
  }
  const findings = scanEnvironmentParityFindings(policy, repositoryFiles);
  validateAllowances(policy, findings, issues);
  return Object.freeze({
    issues: Object.freeze(issues),
    finding_count: findings.length,
  });
}

async function collectFiles(root, policy) {
  const files = new Map();
  for (const sourceRoot of policy.product_source_roots) {
    const absoluteRoot = resolve(root, sourceRoot);
    const entries = await readdir(absoluteRoot, {
      recursive: true,
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const absolutePath = resolve(entry.parentPath, entry.name);
      const path = normalizePath(relative(root, absolutePath));
      if (!isProductSource(policy, path)) continue;
      files.set(path, await readFile(absolutePath, "utf8"));
    }
  }
  for (const path of productManifestPaths(policy)) {
    files.set(path, await readFile(resolve(root, path), "utf8"));
  }
  return files;
}

function rootPath(root) {
  if (root instanceof URL) return fileURLToPath(root);
  return resolve(String(root));
}

export async function verifyEnvironmentParityRepository({
  root = new URL("../", import.meta.url),
  policyPath = POLICY_PATH,
} = {}) {
  const repositoryRoot = rootPath(root);
  let policy;
  try {
    policy = JSON.parse(
      await readFile(resolve(repositoryRoot, policyPath), "utf8"),
    );
  } catch (error) {
    return Object.freeze({
      issues: Object.freeze([
        issue(
          "ENVIRONMENT_PARITY_POLICY_UNREADABLE",
          `${policyPath}: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ]),
      finding_count: 0,
    });
  }
  const files = await collectFiles(repositoryRoot, policy);
  return validateEnvironmentParityPolicy(policy, files);
}

async function main() {
  const [command = "verify"] = process.argv.slice(2);
  if (command !== "verify") throw new Error(`unknown command: ${command}`);
  const result = await verifyEnvironmentParityRepository();
  if (result.issues.length > 0) {
    for (const item of result.issues) {
      console.error(`[${item.code}] ${item.message}`);
    }
    console.error(
      `Environment parity verification failed with ${result.issues.length} issue(s).`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Environment parity verification passed. findings=${result.finding_count}`,
  );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
