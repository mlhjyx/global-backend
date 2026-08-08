#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const FULL_SHA = /^[0-9a-f]{40}$/i;
const FULL_IMAGE_DIGEST = /@sha256:[0-9a-f]{64}$/i;

function ratio(metric) {
  return metric.total === 0 ? 1 : metric.covered / metric.total;
}

function percent(metric) {
  // Match Istanbul/Vitest's two-decimal truncation while the actual ratchet
  // continues to compare integer counts and cannot be bypassed by rounding.
  return Math.floor(ratio(metric) * 10_000) / 100;
}

function atLeastRatio(current, minimum) {
  if (current.total === 0) return minimum.total === 0;
  if (minimum.total === 0) return true;
  return current.covered * minimum.total >= minimum.covered * current.total;
}

function sourceRelativePath(path) {
  const normalized = path.replaceAll("\\", "/");
  const marker = "/apps/api/";
  const index = normalized.lastIndexOf(marker);
  return index >= 0 ? normalized.slice(index + marker.length) : normalized;
}

function aggregateBranches(summary, prefixes) {
  const aggregate = { covered: 0, total: 0 };
  for (const [path, entry] of Object.entries(summary)) {
    if (path === "total" || !entry?.branches) continue;
    const relativePath = sourceRelativePath(path);
    if (!prefixes.some((prefix) => relativePath.startsWith(prefix))) continue;
    aggregate.covered += entry.branches.covered;
    aggregate.total += entry.branches.total;
  }
  return aggregate;
}

function coverageDebt(scope, current, targetPercent) {
  return {
    scope,
    currentPercent: percent(current),
    targetPercent,
    covered: current.covered,
    total: current.total,
    missingCoveredUnitsAtCurrentTotal: Math.max(
      0,
      Math.ceil((targetPercent / 100) * current.total) - current.covered,
    ),
  };
}

const API_COVERAGE_INCLUDE = ["src/**/*.ts"];
const API_COVERAGE_EXCLUDE = ["src/**/*.spec.ts", "src/**/testing/**"];

export function evaluateCoverage(policy, summary, expectedSourceFiles) {
  const errors = [];
  const debt = [];
  const targetPercent = policy?.targetPercent;
  if (policy?.schemaVersion !== "api-coverage-policy/v1") {
    errors.push("coverage policy schemaVersion must be api-coverage-policy/v1");
  }
  if (targetPercent !== 80) {
    errors.push("coverage targetPercent must remain 80");
  }
  if (
    JSON.stringify(policy?.scope?.include) !==
      JSON.stringify(API_COVERAGE_INCLUDE) ||
    JSON.stringify(policy?.scope?.exclude) !==
      JSON.stringify(API_COVERAGE_EXCLUDE)
  ) {
    errors.push(
      "coverage policy scope must include every production TypeScript source and exclude only specs/testing helpers",
    );
  }

  if (!Array.isArray(expectedSourceFiles) || expectedSourceFiles.length === 0) {
    errors.push("coverage verification requires a production source inventory");
  } else {
    const expected = new Set(expectedSourceFiles);
    const observed = new Set(
      Object.keys(summary ?? {})
        .filter((path) => path !== "total")
        .map(sourceRelativePath),
    );
    for (const path of expected) {
      if (!observed.has(path)) {
        errors.push(`coverage summary is missing production source ${path}`);
      }
    }
    for (const path of observed) {
      if (!expected.has(path)) {
        errors.push(`coverage summary contains out-of-scope source ${path}`);
      }
    }
  }

  for (const metricName of ["statements", "branches", "functions", "lines"]) {
    const current = summary?.total?.[metricName];
    const baseline = policy?.baseline?.[metricName];
    if (!current || !baseline) {
      errors.push(`global ${metricName} coverage is missing`);
      continue;
    }
    if (!atLeastRatio(current, baseline)) {
      errors.push(
        `global ${metricName} declined: ${current.covered}/${current.total} is below ${baseline.covered}/${baseline.total}`,
      );
    }
  }

  for (const metricName of ["statements", "branches", "functions", "lines"]) {
    const current = summary?.total?.[metricName];
    if (current && percent(current) < targetPercent) {
      debt.push(coverageDebt(`global:${metricName}`, current, targetPercent));
    }
  }

  for (const [name, cohort] of Object.entries(policy?.critical ?? {})) {
    const scope = `critical:${name}`;
    const current = aggregateBranches(summary, cohort.paths ?? []);
    if (current.total === 0) {
      errors.push(`${scope} matched no branch-bearing source files`);
      continue;
    }
    if (!atLeastRatio(current, cohort.baseline)) {
      errors.push(
        `${scope} branches declined: ${current.covered}/${current.total} is below ${cohort.baseline.covered}/${cohort.baseline.total}`,
      );
    }
    if (percent(current) < cohort.targetPercent) {
      debt.push(coverageDebt(scope, current, cohort.targetPercent));
    }
  }

  return {
    ok: errors.length === 0,
    status:
      errors.length > 0
        ? "RATCHET_FAILED"
        : debt.length > 0
          ? "RATCHET_PASS_TARGET_UNMET"
          : "TARGET_MET",
    targetPercent,
    targetMet: errors.length === 0 && debt.length === 0,
    debt,
    errors,
  };
}

function actionReferences(workflowText) {
  return [...workflowText.matchAll(/^\s*-?\s*uses:\s*([^\s#]+).*$/gm)].map(
    (match) => match[1],
  );
}

function checkoutSteps(workflowText) {
  const lines = workflowText.split(/\r?\n/);
  const steps = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!/\buses:\s*actions\/checkout@/.test(line)) continue;
    const indent = line.search(/\S/);
    const body = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor];
      if (candidate.trim() === "") {
        body.push(candidate);
        continue;
      }
      const candidateIndent = candidate.search(/\S/);
      if (
        candidateIndent < indent ||
        (candidateIndent === indent && candidate.trimStart().startsWith("- "))
      ) {
        break;
      }
      body.push(candidate);
    }
    steps.push({ line: index + 1, body: body.join("\n") });
  }
  return steps;
}

function workflowJobBlocks(workflowText) {
  const jobs = new Map();
  const lines = workflowText.split(/\r?\n/);
  let inJobs = false;
  let currentId = null;
  let currentLines = [];
  const saveCurrent = () => {
    if (currentId) jobs.set(currentId, currentLines.join("\n"));
  };
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^\S/.test(line) && line.trim() !== "") {
      saveCurrent();
      break;
    }
    if (!inJobs) continue;
    const job = /^  ([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (job) {
      saveCurrent();
      currentId = job[1];
      currentLines = [line];
      continue;
    }
    if (currentId) currentLines = [...currentLines, line];
  }
  if (inJobs) saveCurrent();
  return jobs;
}

export function validateWorkflowPolicy(workflows) {
  const errors = [];
  for (const [path, workflowText] of Object.entries(workflows)) {
    for (const reference of actionReferences(workflowText)) {
      if (reference.startsWith("./")) continue;
      const separator = reference.lastIndexOf("@");
      const revision = separator >= 0 ? reference.slice(separator + 1) : "";
      if (!FULL_SHA.test(revision)) {
        errors.push(`${path}: Action ${reference} must use a full commit SHA`);
      }
    }
    for (const checkout of checkoutSteps(workflowText)) {
      if (
        !/^\s+persist-credentials:\s*false\s*(?:#.*)?$/m.test(checkout.body)
      ) {
        errors.push(
          `${path}:${checkout.line}: checkout must set persist-credentials: false`,
        );
      }
    }
  }

  const securityEntry = Object.entries(workflows).find(([path]) =>
    path.endsWith("/security.yml"),
  );
  if (!securityEntry) {
    errors.push(".github/workflows/security.yml is missing");
    return { ok: false, errors };
  }
  const [securityPath, securityText] = securityEntry;
  const permissionsBlock = /^permissions:\s*\n((?:^[ \t]+.*(?:\n|$))*)/m.exec(
    securityText,
  )?.[1];
  if (
    !permissionsBlock ||
    !/^\s+contents:\s*read\s*(?:#.*)?$/m.test(permissionsBlock)
  ) {
    errors.push(
      `${securityPath}: top-level contents: read permission is required`,
    );
  }
  if (/^\s*[a-zA-Z0-9_-]+:\s*write\s*(?:#.*)?$/m.test(securityText)) {
    errors.push(
      `${securityPath}: source-only security CI cannot have write permission`,
    );
  }
  if (/^\s*continue-on-error:\s*true\s*(?:#.*)?$/m.test(securityText)) {
    errors.push(
      `${securityPath}: required source-only security lanes cannot continue on error`,
    );
  }

  const requiredLanes = [
    ["dependency audit", /name:\s*dependency audit\b/i, /pnpm audit\b/],
    [
      "repository SAST",
      /name:\s*repository SAST\b/i,
      /(?:security:sast|security-recovery-governance\.mjs\s+sast)\b/,
    ],
    [
      "container and Compose IaC",
      /name:\s*container and Compose IaC\b/i,
      /(?:security:compose|security-recovery-governance\.mjs\s+compose)\b/,
    ],
  ];
  for (const [label, namePattern, commandPattern] of requiredLanes) {
    if (!namePattern.test(securityText) || !commandPattern.test(securityText)) {
      errors.push(`${securityPath}: required lane ${label} is missing`);
    }
  }
  if (
    !/security-recovery-governance\.mjs\s+dependency-regression\b/.test(
      securityText,
    )
  ) {
    errors.push(
      `${securityPath}: dependency audit must use the base/head dependency regression comparator`,
    );
  }
  const securityGate = [...workflowJobBlocks(securityText).entries()].find(
    ([, block]) => /name:\s*security\s*·\s*required gate\b/i.test(block),
  );
  if (!securityGate) {
    errors.push(`${securityPath}: security required gate is missing`);
  } else {
    const [, gateBlock] = securityGate;
    if (!/^\s+if:\s*always\(\)\s*(?:#.*)?$/m.test(gateBlock)) {
      errors.push(
        `${securityPath}: security required gate must run with if: always()`,
      );
    }
    for (const requiredJob of [
      "secret-scan",
      "dependency-audit",
      "source-sast",
      "compose-iac",
    ]) {
      if (!new RegExp(`\\b${requiredJob}\\b`).test(gateBlock)) {
        errors.push(
          `${securityPath}: security required gate must depend on ${requiredJob}`,
        );
      }
      if (
        !new RegExp(
          `needs\\.${requiredJob.replaceAll("-", "\\-")}\\.result`,
        ).test(gateBlock)
      ) {
        errors.push(
          `${securityPath}: security required gate must inspect ${requiredJob} result`,
        );
      }
    }
    if (!/["']?\$result["']?\s*!=\s*["']success["']/.test(gateBlock)) {
      errors.push(
        `${securityPath}: security required gate must reject every non-success result`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

const AUDIT_SEVERITY = Object.freeze({
  info: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
});

function auditSnapshot(report, label) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return {
      errors: [`${label} audit response must be a JSON object`],
      summary: {},
      exposures: [],
    };
  }
  if (report.error) {
    const code = report.error.code ?? "UNKNOWN_AUDIT_ERROR";
    return {
      errors: [`${label} audit response contains ${code}`],
      summary: {},
      exposures: [],
    };
  }
  if (!report.advisories || typeof report.advisories !== "object") {
    return {
      errors: [`${label} audit response is missing advisories`],
      summary: {},
      exposures: [],
    };
  }

  const advisoryEntries = Object.entries(report.advisories);
  const advisoryPaths = (advisory) =>
    (advisory?.findings ?? []).flatMap((finding) =>
      Array.isArray(finding?.paths) ? finding.paths.map(String) : [],
    );
  const missingPaths = advisoryEntries
    .filter(([, advisory]) => {
      const severity = String(advisory?.severity ?? "").toLowerCase();
      return (
        AUDIT_SEVERITY[severity] !== undefined &&
        advisoryPaths(advisory).length === 0
      );
    })
    .map(([fallbackId, advisory]) =>
      String(
        advisory.github_advisory_id ??
          advisory.npm_advisory_id ??
          advisory.id ??
          fallbackId,
      ),
    );
  if (missingPaths.length > 0) {
    return {
      errors: [
        `${label} audit response is missing dependency paths for ${missingPaths.join(", ")}`,
      ],
      summary: {},
      exposures: [],
    };
  }

  const summary = Object.fromEntries(
    Object.keys(AUDIT_SEVERITY).map((severity) => [
      severity,
      Number(report.metadata?.vulnerabilities?.[severity] ?? 0),
    ]),
  );
  const exposures = advisoryEntries.flatMap(([fallbackId, advisory]) => {
    const severity = String(advisory?.severity ?? "").toLowerCase();
    const severityRank = AUDIT_SEVERITY[severity];
    if (severityRank === undefined) return [];
    const advisoryId = String(
      advisory.github_advisory_id ??
        advisory.npm_advisory_id ??
        advisory.id ??
        fallbackId,
    );
    const moduleName = String(advisory.module_name ?? "unknown-module");
    return advisoryPaths(advisory).map((path) => ({
      key: `${advisoryId}\0${moduleName}\0${path}`,
      advisoryId,
      moduleName,
      path,
      severity,
      severityRank,
    }));
  });
  return { errors: [], summary, exposures };
}

export function evaluateDependencyAuditRegression(baseReport, headReport) {
  const base = auditSnapshot(baseReport, "base");
  const head = auditSnapshot(headReport, "head");
  const errors = [...base.errors, ...head.errors];
  if (errors.length > 0) {
    return {
      ok: false,
      threshold: "high",
      base: { summary: base.summary },
      head: { summary: head.summary },
      inherited: [],
      inheritedExposureCount: 0,
      regressions: [],
      resolved: [],
      resolvedExposureCount: 0,
      errors,
    };
  }

  const baseByKey = new Map(base.exposures.map((entry) => [entry.key, entry]));
  const headByKey = new Map(head.exposures.map((entry) => [entry.key, entry]));
  const publicEntry = ({ key: _key, severityRank: _rank, ...entry }) => entry;
  const summarizeGroups = (entries) =>
    [
      ...entries
        .reduce((groups, entry) => {
          const key = `${entry.advisoryId}\0${entry.moduleName}\0${entry.severity}`;
          const previous = groups.get(key);
          return new Map(groups).set(key, {
            advisoryId: entry.advisoryId,
            moduleName: entry.moduleName,
            severity: entry.severity,
            pathCount: (previous?.pathCount ?? 0) + 1,
          });
        }, new Map())
        .values(),
    ].toSorted((left, right) =>
      `${left.advisoryId}\0${left.moduleName}`.localeCompare(
        `${right.advisoryId}\0${right.moduleName}`,
      ),
    );
  const blockingHead = head.exposures.filter(
    ({ severityRank }) => severityRank >= AUDIT_SEVERITY.high,
  );
  const regressions = blockingHead
    .filter((entry) => {
      const previous = baseByKey.get(entry.key);
      return !previous || previous.severityRank < entry.severityRank;
    })
    .map(publicEntry)
    .toSorted((left, right) =>
      `${left.advisoryId}\0${left.path}`.localeCompare(
        `${right.advisoryId}\0${right.path}`,
      ),
    );
  const inheritedEntries = blockingHead
    .filter((entry) => {
      const previous = baseByKey.get(entry.key);
      return previous && previous.severityRank >= entry.severityRank;
    })
    .map(publicEntry);
  const resolvedEntries = base.exposures
    .filter(
      (entry) =>
        entry.severityRank >= AUDIT_SEVERITY.high && !headByKey.has(entry.key),
    )
    .map(publicEntry);

  return {
    ok: regressions.length === 0,
    threshold: "high",
    base: { summary: base.summary },
    head: { summary: head.summary },
    inherited: summarizeGroups(inheritedEntries),
    inheritedExposureCount: inheritedEntries.length,
    regressions,
    resolved: summarizeGroups(resolvedEntries),
    resolvedExposureCount: resolvedEntries.length,
    errors,
  };
}

const SAST_RULES = [
  { rule: "dynamic-eval", pattern: /\beval\s*\(|\bnew\s+Function\s*\(/ },
  {
    rule: "unsafe-prisma-raw",
    pattern: /\$queryRawUnsafe\b|\$executeRawUnsafe\b/,
  },
  { rule: "shell-true", pattern: /\bshell\s*:\s*true\b/ },
  {
    rule: "tls-verification-disabled",
    pattern:
      /\brejectUnauthorized\s*:\s*false\b|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0/,
  },
];

export function scanSourceForSecurityFindings(files) {
  const findings = [];
  for (const [path, source] of Object.entries(files)) {
    for (const { rule, pattern } of SAST_RULES) {
      const match = pattern.exec(source);
      if (!match) continue;
      const line = source.slice(0, match.index).split("\n").length;
      findings.push({ path, line, rule });
    }
  }
  return findings;
}

function composeServices(composeText) {
  const services = new Map();
  let inServices = false;
  let service = null;
  let inBuild = false;
  for (const line of composeText.split(/\r?\n/)) {
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      service = null;
      inBuild = false;
      continue;
    }
    if (inServices && /^\S/.test(line) && line.trim() !== "") {
      inServices = false;
      service = null;
      inBuild = false;
    }
    if (!inServices) continue;
    const serviceMatch = /^  ([a-zA-Z0-9_-]+):\s*$/.exec(line);
    if (serviceMatch) {
      service = serviceMatch[1];
      services.set(service, {
        image: null,
        buildContext: null,
        dockerfile: "Dockerfile",
      });
      inBuild = false;
      continue;
    }
    if (service && /^    build:\s*$/.test(line)) {
      inBuild = true;
      continue;
    }
    const inlineBuildMatch = /^    build:\s*([^\s#]+).*$/.exec(line);
    if (service && inlineBuildMatch) {
      services.get(service).buildContext = inlineBuildMatch[1];
      inBuild = false;
      continue;
    }
    const imageMatch = /^    image:\s*([^\s#]+).*$/.exec(line);
    if (service && imageMatch) {
      services.get(service).image = imageMatch[1];
      inBuild = false;
      continue;
    }
    if (service && inBuild) {
      const contextMatch = /^      context:\s*([^\s#]+).*$/.exec(line);
      if (contextMatch) {
        services.get(service).buildContext = contextMatch[1];
        continue;
      }
      const dockerfileMatch = /^      dockerfile:\s*([^\s#]+).*$/.exec(line);
      if (dockerfileMatch) {
        services.get(service).dockerfile = dockerfileMatch[1];
      }
    }
  }
  return services;
}

export function validateComposeLock({
  composeText,
  manifest,
  profile,
  localSourceDigests,
  localDockerfileTexts = {},
}) {
  const errors = [];
  if (manifest?.schemaVersion !== "container-image-lock/v1") {
    errors.push("container lock schemaVersion must be container-image-lock/v1");
  }
  const profileEntry = manifest?.profiles?.[profile];
  if (!profileEntry) {
    errors.push(`profile ${profile} is absent from the image lock`);
    return { ok: false, errors };
  }
  if (profileEntry.status === "UNVERIFIED") {
    errors.push(`profile ${profile} is UNVERIFIED and cannot be started`);
    return { ok: false, errors };
  }

  const actualServices = composeServices(composeText);
  const localImages = new Set(
    Object.values(manifest.services ?? {})
      .filter((entry) => entry.kind === "local-build")
      .map((entry) => entry.image),
  );
  const profileServices = new Set(profileEntry.services ?? []);
  for (const [service, actual] of actualServices) {
    if (!actual.image) {
      errors.push(`${service}: compose service must declare a locked image`);
      continue;
    }
    if (!profileServices.has(service)) {
      errors.push(`${service}: compose service is absent from profile lock`);
    }
    const image = actual.image;
    if (!FULL_IMAGE_DIGEST.test(image) && !localImages.has(image)) {
      errors.push(`${service}: moving or unlocked image ${image}`);
    }
  }

  for (const service of profileEntry.services ?? []) {
    const locked = manifest.services?.[service];
    if (!locked) {
      errors.push(`${service}: missing image-lock entry`);
      continue;
    }
    const actual = actualServices.get(service);
    if (actual?.image !== locked.image) {
      errors.push(
        `${service}: compose image ${actual?.image ?? "missing"} != lock ${locked.image}`,
      );
    }
    if (locked.kind === "remote") {
      if (actual?.buildContext) {
        errors.push(
          `${service}: digest-locked remote service cannot declare a build context`,
        );
      }
      if (!FULL_IMAGE_DIGEST.test(locked.image)) {
        errors.push(`${service}: remote image is not pinned by a full digest`);
      }
      if (
        !["VERIFIED_GLOBAL_DEV", "VERIFIED_REGISTRY", "PINNED_SOURCE"].includes(
          locked.status,
        )
      ) {
        errors.push(
          `${service}: remote image status ${locked.status} is not admissible`,
        );
      }
      continue;
    }
    if (locked.kind !== "local-build") {
      errors.push(`${service}: unsupported lock kind ${locked.kind}`);
      continue;
    }
    if (
      actual?.buildContext !== locked.build?.context ||
      actual?.dockerfile !== locked.build?.dockerfile
    ) {
      errors.push(
        `${service}: build source ${actual?.buildContext ?? "missing"}/${actual?.dockerfile ?? "missing"} != lock ${locked.build?.context ?? "missing"}/${locked.build?.dockerfile ?? "missing"}`,
      );
    }
    const normalizedContext = (locked.build?.context ?? "").replace(
      /^\.\//,
      "",
    );
    const expectedDockerfile = `${normalizedContext}/${locked.build?.dockerfile ?? ""}`;
    if (!(locked.sourceFiles ?? []).includes(expectedDockerfile)) {
      errors.push(
        `${service}: sourceFiles do not include ${expectedDockerfile}`,
      );
    }
    for (const sourcePath of locked.sourceFiles ?? []) {
      if (!sourcePath.startsWith(`${normalizedContext}/`)) {
        errors.push(
          `${service}: source file ${sourcePath} escapes build context`,
        );
      }
    }
    const dockerfileText = localDockerfileTexts[service];
    const baseImages = dockerfileText
      ? [
          ...dockerfileText.matchAll(
            /^FROM\s+([^\s]+)(?:\s+AS\s+[^\s]+)?\s*$/gim,
          ),
        ].map((match) => match[1])
      : [];
    if (baseImages.length === 0) {
      errors.push(`${service}: Dockerfile has no readable FROM image`);
    }
    for (const baseImage of baseImages) {
      if (!FULL_IMAGE_DIGEST.test(baseImage)) {
        errors.push(
          `${service}: moving or unlocked Dockerfile FROM ${baseImage}`,
        );
      }
    }
    if (
      JSON.stringify(baseImages) !== JSON.stringify(locked.baseImages ?? [])
    ) {
      errors.push(`${service}: Dockerfile base image list differs from lock`);
    }
    const observedDigest = localSourceDigests?.[service];
    if (observedDigest !== locked.sourceDigest) {
      errors.push(
        `${service}: source digest drift (${observedDigest ?? "missing"} != ${locked.sourceDigest})`,
      );
    }
    const expectedTag = `src-${locked.sourceDigest.slice(0, 12)}`;
    if (!locked.image.endsWith(`:${expectedTag}`)) {
      errors.push(
        `${service}: local image tag must bind source digest ${expectedTag}`,
      );
    }
    if (locked.status !== "SOURCE_LOCKED") {
      errors.push(`${service}: local build status must be SOURCE_LOCKED`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateRecoveryRehearsal(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== "recovery-rehearsal/v1") {
    errors.push("recovery schemaVersion must be recovery-rehearsal/v1");
  }
  const statuses = new Set([
    "NOT_RUN",
    "AUTHORIZED",
    "RUNNING",
    "FAILED",
    "PASSED",
  ]);
  if (!statuses.has(manifest?.status))
    errors.push("recovery status is invalid");
  if (manifest?.status === "NOT_RUN") {
    if (manifest.authorization !== null) {
      errors.push("NOT_RUN recovery manifest cannot contain authorization");
    }
    if (manifest.startedAt !== null || manifest.completedAt !== null) {
      errors.push(
        "NOT_RUN recovery manifest cannot contain execution timestamps",
      );
    }
    if (!Array.isArray(manifest.receipts) || manifest.receipts.length !== 0) {
      errors.push("NOT_RUN recovery manifest cannot contain receipts");
    }
    return { ok: errors.length === 0, errors };
  }
  // Source review can validate the create-only admission state, but it cannot
  // prove that an operator was authorized or that a restore actually ran. A
  // future executed-evidence verifier must bind external authorization and
  // immutable receipt artifacts before any non-NOT_RUN state is admissible.
  errors.push(
    "source-only recovery admission accepts only NOT_RUN; executed evidence is not wired",
  );
  return { ok: errors.length === 0, errors };
}

export function validateIntegrationMatrix(matrix) {
  const errors = [];
  const blocked = [];
  if (matrix?.schemaVersion !== "integration-context-matrix/v1") {
    errors.push(
      "integration matrix schemaVersion must be integration-context-matrix/v1",
    );
  }
  const expected = {
    postgresql: {
      context: "PostgreSQL integration",
      isolation: "DISPOSABLE_DATABASE_AND_ROLE",
      isolationMessage: "disposable database and role",
    },
    temporal: {
      context: "Temporal integration",
      isolation: "OFFICIAL_TEST_ENV_OR_PURE_HISTORY_REPLAY",
      isolationMessage: "official test environment or pure history replay",
    },
  };
  for (const [name, requirement] of Object.entries(expected)) {
    const entry = matrix?.contexts?.[name];
    if (!entry) {
      errors.push(`${name}: integration context is missing`);
      continue;
    }
    if (entry.requiredContext !== requirement.context) {
      errors.push(`${name}: required context must be ${requirement.context}`);
    }
    if (entry.status === "BLOCKED") {
      blocked.push(name);
      if (entry.command !== null) {
        errors.push(
          `${name}: blocked context cannot publish an executable command`,
        );
      }
      continue;
    }
    if (entry.status !== "ENABLED") {
      errors.push(`${name}: status must be BLOCKED or ENABLED`);
      continue;
    }
    if (entry.isolation !== requirement.isolation) {
      errors.push(
        `${name}: enabled context requires ${requirement.isolationMessage}`,
      );
    }
    // The repository does not yet contain an allowlisted runner that executes
    // either context. Merely placing a shell string in JSON must never make a
    // required context green. Enabling a context therefore requires a code
    // change that adds and tests the bounded runner first.
    errors.push(
      `${name}: only BLOCKED is admissible until an allowlisted integration runner is wired`,
    );
  }
  return {
    ok: errors.length === 0,
    requiredContextsSatisfied: errors.length === 0 && blocked.length === 0,
    blocked,
    errors,
  };
}

async function jsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function filesBelow(root, predicate) {
  const output = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", "coverage", ".git"].includes(entry.name))
        continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (predicate(path)) output.push(path);
    }
  }
  await visit(root);
  return output.sort();
}

async function localBuildDigests(repositoryRoot, manifest) {
  const output = {};
  for (const [service, entry] of Object.entries(manifest.services ?? {})) {
    if (entry.kind !== "local-build") continue;
    const digest = createHash("sha256");
    for (const sourcePath of [...entry.sourceFiles].sort()) {
      const bytes = await readFile(resolve(repositoryRoot, sourcePath));
      const fileDigest = createHash("sha256").update(bytes).digest("hex");
      digest.update(`${sourcePath}\0${fileDigest}\n`);
    }
    output[service] = digest.digest("hex");
  }
  return output;
}

async function localDockerfiles(repositoryRoot, manifest) {
  const output = {};
  for (const [service, entry] of Object.entries(manifest.services ?? {})) {
    if (entry.kind !== "local-build") continue;
    const context = entry.build.context.replace(/^\.\//, "");
    output[service] = await readFile(
      resolve(repositoryRoot, context, entry.build.dockerfile),
      "utf8",
    );
  }
  return output;
}

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const value = process.argv
    .slice(3)
    .find((argument) => argument.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

function emit(result, failWhen = !result.ok) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (failWhen) process.exitCode = 1;
}

async function main() {
  const command = process.argv[2];
  const repositoryRoot = resolve(import.meta.dirname, "..");
  if (command === "coverage") {
    const policy = await jsonFile(resolve(repositoryRoot, option("policy")));
    const summary = await jsonFile(resolve(repositoryRoot, option("summary")));
    const apiRoot = resolve(repositoryRoot, "apps/api");
    const expectedSourceFiles = (
      await filesBelow(resolve(apiRoot, "src"), (path) => {
        const normalized = path.replaceAll("\\", "/");
        return (
          normalized.endsWith(".ts") &&
          !normalized.endsWith(".spec.ts") &&
          !normalized.includes("/testing/")
        );
      })
    ).map((path) => relative(apiRoot, path).replaceAll("\\", "/"));
    emit(evaluateCoverage(policy, summary, expectedSourceFiles));
    return;
  }
  if (command === "dependency-regression") {
    const base = await jsonFile(resolve(repositoryRoot, option("base")));
    const head = await jsonFile(resolve(repositoryRoot, option("head")));
    emit(evaluateDependencyAuditRegression(base, head));
    return;
  }
  if (command === "workflow") {
    const workflowRoot = resolve(
      repositoryRoot,
      option("dir", ".github/workflows"),
    );
    const workflowPaths = await filesBelow(workflowRoot, (path) =>
      [".yml", ".yaml"].includes(extname(path)),
    );
    const workflows = Object.fromEntries(
      await Promise.all(
        workflowPaths.map(async (path) => [
          relative(repositoryRoot, path),
          await readFile(path, "utf8"),
        ]),
      ),
    );
    emit(validateWorkflowPolicy(workflows));
    return;
  }
  if (command === "sast") {
    const roots = ["apps/api/src", "packages"].map((path) =>
      resolve(repositoryRoot, path),
    );
    const paths = (
      await Promise.all(
        roots.map((root) =>
          filesBelow(
            root,
            (path) =>
              [".ts", ".mts", ".js", ".mjs"].includes(extname(path)) &&
              !/\.(?:spec|test)\.[cm]?[jt]s$/.test(path),
          ),
        ),
      )
    ).flat();
    const files = Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [
          relative(repositoryRoot, path),
          await readFile(path, "utf8"),
        ]),
      ),
    );
    const findings = scanSourceForSecurityFindings(files);
    emit({ ok: findings.length === 0, findings });
    return;
  }
  if (command === "compose") {
    const manifest = await jsonFile(
      resolve(repositoryRoot, option("manifest")),
    );
    const composePaths = option("compose").split(",");
    const composeText = (
      await Promise.all(
        composePaths.map((path) =>
          readFile(resolve(repositoryRoot, path), "utf8"),
        ),
      )
    ).join("\n");
    emit(
      validateComposeLock({
        composeText,
        manifest,
        profile: option("profile", "default"),
        localSourceDigests: await localBuildDigests(repositoryRoot, manifest),
        localDockerfileTexts: await localDockerfiles(repositoryRoot, manifest),
      }),
    );
    return;
  }
  if (command === "recovery") {
    emit(
      validateRecoveryRehearsal(
        await jsonFile(resolve(repositoryRoot, option("manifest"))),
      ),
    );
    return;
  }
  if (command === "integration") {
    const result = validateIntegrationMatrix(
      await jsonFile(resolve(repositoryRoot, option("matrix"))),
    );
    const requireReady = process.argv.slice(3).includes("--require-ready");
    emit(
      result,
      !result.ok || (requireReady && !result.requiredContextsSatisfied),
    );
    return;
  }
  throw new Error(`unknown command: ${command ?? "<missing>"}`);
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
