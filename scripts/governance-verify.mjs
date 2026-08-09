#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  renderProviderRegistry,
  renderReleaseBundle,
  parseSeedProviders,
  validateProviderRegistry,
  validateReleaseBundle,
  validateRequiredContexts,
  validateRuntimeEvidence,
  validateTraceability,
} from "./governance-contracts.mjs";
import {
  MAX_EVIDENCE_ARTIFACT_BYTES,
  readRepoRegularFile,
  resolveRepoOutputFile,
} from "./governance-path-contracts.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_REGISTRY = "docs/governance/provider-registry.json";
const PROVIDER_SOURCE_CLASSES =
  "apps/api/src/discovery/provider-source-classes.json";
const PROVIDER_DOCUMENT = "docs/backend/provider-registry.md";
const TRACEABILITY = "docs/governance/delivery-traceability.json";
const RUNTIME_EVIDENCE_DIRECTORY = "docs/evidence/runtime";
const RELEASE_DIRECTORY = "docs/releases";
const REQUIRED_CONTEXTS = ".github/required-contexts.json";
const CODEOWNERS = ".github/CODEOWNERS";
const WORKFLOW_DIRECTORY = ".github/workflows";

function absolute(repoPath) {
  return resolve(ROOT, repoPath);
}

async function exists(repoPath) {
  try {
    await access(absolute(repoPath));
    return true;
  } catch {
    return false;
  }
}

async function readText(repoPath) {
  return readFile(absolute(repoPath), "utf8");
}

async function readJson(repoPath) {
  return JSON.parse(await readText(repoPath));
}

async function listFiles(repoDirectory, suffix) {
  if (!(await exists(repoDirectory))) return [];
  const entries = await readdir(absolute(repoDirectory), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => {
      const parent = relative(absolute(repoDirectory), entry.parentPath);
      return [repoDirectory, parent, entry.name]
        .filter((part) => part && part !== ".")
        .join("/");
    })
    .sort();
}

function definitionIds(markdown, pattern) {
  const ids = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const firstCell = line.match(/^\|\s*`([^`]+)`\s*\|/);
    if (firstCell && pattern.test(firstCell[1])) ids.add(firstCell[1]);
  }
  return ids;
}

function operationIds(openApi) {
  const ids = new Set();
  for (const pathItem of Object.values(openApi.paths ?? {})) {
    for (const operation of Object.values(pathItem ?? {})) {
      if (operation && typeof operation === "object" && operation.operationId) {
        ids.add(operation.operationId);
      }
    }
  }
  return ids;
}

async function referencedExistingPaths(...documents) {
  const paths = new Set();
  for (const document of documents) {
    const values = [
      ...(document.providers ?? []).flatMap((provider) => provider.test_paths ?? []),
      ...(document.providers ?? []).flatMap((provider) =>
        (provider.evidence_refs ?? []).map((ref) => ref.path),
      ),
      ...(document.chains ?? []).flatMap((chain) => [
        ...(chain.code_paths ?? []),
        ...(chain.test_paths ?? []),
      ]),
    ];
    for (const repoPath of values) {
      if (await exists(repoPath)) paths.add(repoPath);
    }
  }
  return paths;
}

async function loadRuntimeEvidence(now, issues) {
  const evidenceById = new Map();
  const classifications = { CURRENT: 0, HISTORICAL: 0, INVALID: 0 };
  for (const repoPath of await listFiles(RUNTIME_EVIDENCE_DIRECTORY, ".json")) {
    let evidence;
    try {
      evidence = await readJson(repoPath);
    } catch (error) {
      issues.push({
        code: "EVIDENCE_JSON_INVALID",
        message: `${repoPath}: ${error.message}`,
      });
      continue;
    }
    const validation = validateRuntimeEvidence(evidence, { now });
    classifications[validation.classification] += 1;
    for (const item of validation.issues) {
      issues.push({ ...item, message: `${repoPath}: ${item.message}` });
    }
    if (evidenceById.has(evidence.evidence_id)) {
      issues.push({
        code: "EVIDENCE_ID_DUPLICATE",
        message: `${repoPath}: duplicate evidence_id ${evidence.evidence_id}`,
      });
    } else if (validation.classification !== "INVALID") {
      evidenceById.set(evidence.evidence_id, evidence);
    }
    if (evidence.artifact_path && validation.classification !== "INVALID") {
      try {
        const artifact = await readRepoRegularFile(
          ROOT,
          evidence.artifact_path,
          { maxBytes: MAX_EVIDENCE_ARTIFACT_BYTES },
        );
        const digest = `sha256:${createHash("sha256").update(artifact).digest("hex")}`;
        if (digest !== evidence.artifact_digest) {
          issues.push({
            code: "EVIDENCE_ARTIFACT_DIGEST_MISMATCH",
            message: `${repoPath}: ${evidence.artifact_path} digest does not match`,
          });
        }
      } catch (error) {
        const code =
          error?.code === "REPO_PATH_INVALID"
            ? "EVIDENCE_ARTIFACT_PATH_INVALID"
            : error?.code === "REPO_FILE_NOT_REGULAR"
              ? "EVIDENCE_ARTIFACT_NOT_REGULAR"
              : error?.code === "REPO_FILE_TOO_LARGE"
                ? "EVIDENCE_ARTIFACT_TOO_LARGE"
                : error?.code === "ENOENT"
                  ? "EVIDENCE_ARTIFACT_MISSING"
                  : "EVIDENCE_ARTIFACT_UNREADABLE";
        issues.push({
          code,
          message: `${repoPath}: ${evidence.artifact_path} cannot be admitted (${error.message})`,
        });
      }
    }
  }
  return { evidenceById, classifications };
}

async function loadReleaseBundles(evidenceById, traceabilityById, now, issues) {
  const releaseBundlesByCapability = new Map();
  let count = 0;
  for (const repoPath of await listFiles(RELEASE_DIRECTORY, ".release.json")) {
    count += 1;
    let bundle;
    try {
      bundle = await readJson(repoPath);
    } catch (error) {
      issues.push({
        code: "RELEASE_JSON_INVALID",
        message: `${repoPath}: ${error.message}`,
      });
      continue;
    }
    const validation = validateReleaseBundle(bundle, {
      evidence_by_id: evidenceById,
      traceability_by_id: traceabilityById,
      now,
    });
    for (const item of validation.issues) {
      issues.push({ ...item, message: `${repoPath}: ${item.message}` });
    }
    const markdownPath = repoPath.replace(/\.release\.json$/, ".md");
    if (!(await exists(markdownPath))) {
      issues.push({
        code: "RELEASE_DOCUMENT_MISSING",
        message: `${repoPath}: generated companion ${markdownPath} is missing`,
      });
    } else if ((await readText(markdownPath)) !== renderReleaseBundle(bundle)) {
      issues.push({
        code: "RELEASE_DOCUMENT_DRIFT",
        message: `${markdownPath}: regenerate from ${repoPath}`,
      });
    }
    if (
      validation.issues.length === 0 &&
      ["PILOT", "GA"].includes(bundle.release_status)
    ) {
      for (const capabilityId of bundle.capability_ids) {
        const bundles = releaseBundlesByCapability.get(capabilityId) ?? [];
        releaseBundlesByCapability.set(capabilityId, [...bundles, bundle]);
      }
    }
  }
  return { count, releaseBundlesByCapability };
}

async function workflowTexts() {
  const workflows = new Map();
  for (const repoPath of [
    ...(await listFiles(WORKFLOW_DIRECTORY, ".yml")),
    ...(await listFiles(WORKFLOW_DIRECTORY, ".yaml")),
  ]) {
    workflows.set(repoPath, await readText(repoPath));
  }
  return workflows;
}

async function verifyNoHandwrittenOpenApiCounts(issues) {
  const pattern = /openapi(?:\.json)?[^\n]{0,100}\b\d+\s*(?:paths?|业务操作|端点)/gi;
  for (const repoPath of ["AGENTS.md", "docs/status/current.md", "docs/architecture/current.md"]) {
    const content = await readText(repoPath);
    const matches = content.match(pattern) ?? [];
    for (const match of matches) {
      issues.push({
        code: "OPENAPI_HANDWRITTEN_COUNT",
        message: `${repoPath}: remove handwritten OpenAPI count '${match}'`,
      });
    }
  }
}

async function verifyRepository() {
  const issues = [];
  const now = new Date();
  const providerRegistry = await readJson(PROVIDER_REGISTRY);
  const traceability = await readJson(TRACEABILITY);
  const existingPaths = await referencedExistingPaths(providerRegistry, traceability);
  const seedProviders = parseSeedProviders(
    await readText("apps/api/src/discovery/provider.registry.ts"),
  );
  const providerValidation = validateProviderRegistry(providerRegistry, {
    seed_providers: seedProviders,
    source_class_manifest: await readJson(PROVIDER_SOURCE_CLASSES),
    existing_paths: existingPaths,
  });
  issues.push(...providerValidation.issues);
  const renderedProviderDocument = renderProviderRegistry(providerRegistry);
  if (!(await exists(PROVIDER_DOCUMENT))) {
    issues.push({
      code: "PROVIDER_DOCUMENT_MISSING",
      message: `${PROVIDER_DOCUMENT} is missing`,
    });
  } else if ((await readText(PROVIDER_DOCUMENT)) !== renderedProviderDocument) {
    issues.push({
      code: "PROVIDER_DOCUMENT_DRIFT",
      message: `${PROVIDER_DOCUMENT} must be regenerated from ${PROVIDER_REGISTRY}`,
    });
  }

  const runtime = await loadRuntimeEvidence(now, issues);
  const traceabilityById = new Map(
    (traceability.chains ?? []).map((chain) => [chain.chain_id, chain]),
  );
  const releases = await loadReleaseBundles(
    runtime.evidenceById,
    traceabilityById,
    now,
    issues,
  );
  const capabilityIds = definitionIds(
    await readText("docs/governance/capability-register.md"),
    /^CAP-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  );
  const objectIds = definitionIds(
    await readText("docs/governance/core-object-register.md"),
    /^OBJ-FE-[0-9]{3}$/,
  );
  const scenarioIds = definitionIds(
    await readText("docs/governance/scenario-catalog.md"),
    /^SCN-FE-[A-Z0-9]+(?:-[A-Z0-9]+)*$/,
  );
  const openApi = await readJson("packages/contracts/openapi/openapi.json");
  const traceValidation = validateTraceability(traceability, {
    capability_ids: capabilityIds,
    object_ids: objectIds,
    operation_ids: operationIds(openApi),
    scenario_ids: scenarioIds,
    existing_paths: existingPaths,
    evidence_by_id: runtime.evidenceById,
    release_bundles_by_capability: releases.releaseBundlesByCapability,
    now,
  });
  issues.push(...traceValidation.issues);

  const requiredContexts = await readJson(REQUIRED_CONTEXTS);
  const workflows = await workflowTexts();
  issues.push(
    ...validateRequiredContexts(requiredContexts, workflows, {
      codeowners: await readText(CODEOWNERS),
    }).issues,
  );
  await verifyNoHandwrittenOpenApiCounts(issues);

  if (issues.length > 0) {
    for (const item of issues) {
      console.error(`[${item.code}] ${item.message}`);
    }
    console.error(`Governance verification failed with ${issues.length} issue(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(
    [
      "Governance verification passed.",
      `providers=${providerValidation.provider_count}`,
      `trace_chains=${traceValidation.chain_count}`,
      `runtime_current=${runtime.classifications.CURRENT}`,
      `runtime_historical=${runtime.classifications.HISTORICAL}`,
      `release_bundles=${releases.count}`,
      `openapi_operations=${operationIds(openApi).size}`,
    ].join(" "),
  );
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function generateProviderDocument() {
  const registry = await readJson(PROVIDER_REGISTRY);
  await writeFile(absolute(PROVIDER_DOCUMENT), renderProviderRegistry(registry));
  console.log(`Generated ${PROVIDER_DOCUMENT} from ${PROVIDER_REGISTRY}.`);
}

async function generateReleaseDocument(args) {
  const input = optionValue(args, "--input");
  if (!input) throw new Error("render-release requires --input <bundle.release.json>");
  const bundle = JSON.parse((await readRepoRegularFile(ROOT, input)).toString("utf8"));
  const output =
    optionValue(args, "--output") ?? input.replace(/\.release\.json$/, ".md");
  if (output === input) {
    throw new Error("render-release input must end with .release.json or provide --output");
  }
  const outputFile = await resolveRepoOutputFile(ROOT, output);
  await writeFile(outputFile, renderReleaseBundle(bundle));
  console.log(`Generated ${output} from ${input}.`);
}

async function main() {
  const [command = "verify", ...args] = process.argv.slice(2);
  if (command === "verify") return verifyRepository();
  if (command === "generate-provider-doc") return generateProviderDocument();
  if (command === "render-release") return generateReleaseDocument(args);
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
