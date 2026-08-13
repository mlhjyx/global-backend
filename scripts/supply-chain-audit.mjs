import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  OFFICIAL_REGISTRY,
  assertNoRepositoryNpmrc,
  buildTrustedPnpmEnvironment,
  listTrackedRepositoryNpmrc,
  readBoundedRegularText,
  validateRepositoryDependencySources,
} from "./supply-chain-source-policy.mjs";

const BASELINE_SCHEMA = "production-dependency-audit-baseline/v1";
const EXPOSURE_SCHEMA = "production-dependency-exposure/v1";
const GRAPH_DELTA_SCHEMA = "production-dependency-graph-delta-result/v1";
const FRESHNESS_SCHEMA = "production-dependency-baseline-freshness-result/v1";
// This exact marker is deliberately used by the workflow to select the
// trusted-base verifier after the one-time protocol bootstrap has merged.
const DEPENDENCY_GRAPH_COMPARABLE_AUDIT_PROTOCOL =
  "dependency-graph-comparable-audit/v2";
const AUDIT_COMMAND =
  "pnpm audit --prod --registry=https://registry.npmjs.org --json";
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const SHA_40 = /^[0-9a-f]{40}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const GHSA_ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const OWNER_ID = /^OWN-[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const SEVERITIES = Object.freeze([
  "info",
  "low",
  "moderate",
  "high",
  "critical",
]);
const SEVERITY_RANK = Object.freeze(
  Object.fromEntries(SEVERITIES.map((severity, index) => [severity, index])),
);

function issue(code, message) {
  return Object.freeze({ code, message });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validDate(value) {
  return isNonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function runReadOnlyGit(root, arguments_) {
  const execution = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", ...arguments_],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: MAX_INPUT_BYTES,
      timeout: 10_000,
    },
  );
  if (
    execution.error ||
    execution.signal ||
    execution.status !== 0 ||
    typeof execution.stdout !== "string"
  ) {
    throw new Error("DEPENDENCY_AUDIT_SUBJECT_UNREADABLE");
  }
  return execution.stdout.trim();
}

export function assertRepositoryAuditSubject(repositoryRoot, expectedCommit) {
  if (!SHA_40.test(expectedCommit ?? "")) {
    throw new Error("DEPENDENCY_AUDIT_SUBJECT_MISMATCH");
  }
  const root = resolve(repositoryRoot);
  let canonicalRoot;
  try {
    canonicalRoot = realpathSync(root);
  } catch {
    throw new Error("DEPENDENCY_AUDIT_SUBJECT_UNREADABLE");
  }
  if (
    canonicalRoot !== root ||
    runReadOnlyGit(root, ["rev-parse", "--show-toplevel"]) !== root ||
    runReadOnlyGit(root, ["rev-parse", "--verify", "HEAD"]) !== expectedCommit
  ) {
    throw new Error("DEPENDENCY_AUDIT_SUBJECT_MISMATCH");
  }
  if (
    runReadOnlyGit(root, [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]) !== ""
  ) {
    throw new Error("DEPENDENCY_AUDIT_SUBJECT_DIRTY");
  }
  return Object.freeze({ root, commit: expectedCommit });
}

function advisoryIdentity(advisory) {
  return `${advisory.ghsa_id}|${advisory.package}`;
}

function findingFingerprint(advisory, version, path) {
  return JSON.stringify([advisory.ghsa_id, advisory.package, version, path]);
}

function normalizeBaselineExposure(exposure, admittedIdentities) {
  const issues = [];
  if (
    !isObject(exposure) ||
    exposure.schema_version !== EXPOSURE_SCHEMA ||
    exposure.path_evidence !== "REQUIRED" ||
    !Array.isArray(exposure.findings)
  ) {
    return {
      evidence: [],
      fingerprints: [],
      issues: [
        issue(
          "BASELINE_EXPOSURE_INVALID",
          "baseline exposure must require canonical finding path evidence",
        ),
      ],
    };
  }
  const evidence = [];
  const fingerprints = [];
  for (const finding of exposure.findings) {
    if (
      !isObject(finding) ||
      !GHSA_ID.test(finding.ghsa_id ?? "") ||
      !isNonEmptyString(finding.package) ||
      !isNonEmptyString(finding.version) ||
      !isNonEmptyString(finding.path)
    ) {
      issues.push(
        issue(
          "BASELINE_EXPOSURE_INVALID",
          "every baseline exposure needs GHSA, package, installed version, and dependency path",
        ),
      );
      continue;
    }
    const identity = advisoryIdentity(finding);
    if (!admittedIdentities.has(identity)) {
      issues.push(
        issue(
          "BASELINE_EXPOSURE_UNKNOWN_ADVISORY",
          `baseline exposure is not tied to an admitted advisory: ${identity}`,
        ),
      );
    }
    const normalized = Object.freeze({
      ghsa_id: finding.ghsa_id,
      package: finding.package,
      version: finding.version,
      path: finding.path,
    });
    evidence.push(normalized);
    fingerprints.push(
      findingFingerprint(normalized, normalized.version, normalized.path),
    );
  }
  if (new Set(fingerprints).size !== fingerprints.length) {
    issues.push(
      issue(
        "BASELINE_EXPOSURE_DUPLICATE",
        "baseline exposure fingerprints must be unique",
      ),
    );
  }
  const sortedFingerprints = [...fingerprints].sort();
  if (
    fingerprints.some(
      (fingerprint, index) => fingerprint !== sortedFingerprints[index],
    )
  ) {
    issues.push(
      issue(
        "BASELINE_EXPOSURE_ORDER_INVALID",
        "baseline exposure findings must use canonical fingerprint order",
      ),
    );
  }
  return {
    evidence: Object.freeze(evidence),
    fingerprints: Object.freeze(sortedFingerprints),
    issues,
  };
}

function countsFor(advisories) {
  return Object.freeze(
    Object.fromEntries(
      SEVERITIES.map((severity) => [
        severity,
        advisories.filter((item) => item.severity === severity).length,
      ]),
    ),
  );
}

function sameCounts(left, right) {
  return SEVERITIES.every(
    (severity) =>
      Number.isInteger(left?.[severity]) && left[severity] === right[severity],
  );
}

function baselineAdvisoryIssues(advisory, validUntil) {
  const issues = [];
  if (!isObject(advisory)) {
    return [
      issue("BASELINE_ADVISORY_INVALID", "baseline advisory must be an object"),
    ];
  }
  if (!GHSA_ID.test(advisory.ghsa_id ?? "")) {
    issues.push(
      issue(
        "BASELINE_ADVISORY_INVALID",
        "baseline advisory must contain a GHSA id",
      ),
    );
  }
  if (!isNonEmptyString(advisory.package)) {
    issues.push(
      issue(
        "BASELINE_ADVISORY_INVALID",
        "baseline advisory package is required",
      ),
    );
  }
  if (
    !SEVERITIES.includes(advisory.severity) ||
    advisory.severity === "critical"
  ) {
    issues.push(
      issue(
        "BASELINE_ADVISORY_SEVERITY_INVALID",
        "critical advisories cannot be admitted to the legacy baseline",
      ),
    );
  }
  for (const field of ["vulnerable_versions", "patched_versions"]) {
    if (!isNonEmptyString(advisory[field])) {
      issues.push(
        issue(
          "BASELINE_ADVISORY_INVALID",
          `baseline advisory ${field} is required`,
        ),
      );
    }
  }
  if (
    advisory.url !== `https://github.com/advisories/${advisory.ghsa_id ?? ""}`
  ) {
    issues.push(
      issue(
        "BASELINE_ADVISORY_URL_INVALID",
        "baseline advisory URL must be the canonical GitHub advisory URL",
      ),
    );
  }
  const remediation = advisory.remediation;
  if (
    !isObject(remediation) ||
    !isNonEmptyString(remediation.stream) ||
    !OWNER_ID.test(remediation.owner ?? "") ||
    !validDate(remediation.due_at) ||
    !isNonEmptyString(remediation.reason)
  ) {
    issues.push(
      issue(
        "BASELINE_REMEDIATION_INVALID",
        "every baseline advisory needs a stream, governed owner, due date, and reason",
      ),
    );
  } else if (
    validDate(validUntil) &&
    Date.parse(remediation.due_at) > Date.parse(validUntil)
  ) {
    issues.push(
      issue(
        "BASELINE_REMEDIATION_AFTER_EXPIRY",
        "advisory remediation due date cannot exceed baseline validity",
      ),
    );
  }
  return issues;
}

export function validateProductionAuditBaseline(
  baseline,
  {
    now = new Date(),
    expectedBootstrapBase,
    expectedSourceLockfileDigest,
  } = {},
) {
  const issues = [];
  if (!isObject(baseline) || baseline.schema_version !== BASELINE_SCHEMA) {
    issues.push(
      issue(
        "BASELINE_SCHEMA_INVALID",
        `baseline schema_version must equal ${BASELINE_SCHEMA}`,
      ),
    );
  }

  const source = baseline?.source;
  if (
    !isObject(source) ||
    !SHA_40.test(source.base_commit ?? "") ||
    !SHA256.test(source.lockfile_digest ?? "") ||
    source.registry !== OFFICIAL_REGISTRY ||
    !/^pnpm@[0-9]+\.[0-9]+\.[0-9]+$/.test(source.package_manager ?? "") ||
    source.command !== AUDIT_COMMAND ||
    !validDate(source.captured_at)
  ) {
    issues.push(
      issue(
        "BASELINE_SOURCE_INVALID",
        "baseline source must bind an exact commit, lock digest, pnpm version, official registry, command, and capture time",
      ),
    );
  }

  const bootstrap = baseline?.bootstrap;
  if (
    !isObject(bootstrap) ||
    bootstrap.mode !== "INITIAL_BASELINE" ||
    !SHA_40.test(bootstrap.base_commit ?? "") ||
    bootstrap.base_commit !== source?.base_commit
  ) {
    issues.push(
      issue(
        "BASELINE_BOOTSTRAP_INVALID",
        "initial baseline bootstrap must bind the audited base commit",
      ),
    );
  }
  if (
    expectedBootstrapBase !== undefined &&
    bootstrap?.base_commit !== expectedBootstrapBase
  ) {
    issues.push(
      issue(
        "BASELINE_BOOTSTRAP_BASE_MISMATCH",
        "candidate baseline is not bound to the pull request base commit",
      ),
    );
  }
  if (
    expectedSourceLockfileDigest !== undefined &&
    source?.lockfile_digest !== expectedSourceLockfileDigest
  ) {
    issues.push(
      issue(
        "BASELINE_SOURCE_LOCK_MISMATCH",
        "candidate baseline lock digest does not match the trusted base lockfile",
      ),
    );
  }

  const governance = baseline?.governance;
  if (
    !isObject(governance) ||
    !OWNER_ID.test(governance.owner ?? "") ||
    !validDate(governance.valid_until) ||
    !isNonEmptyString(governance.policy)
  ) {
    issues.push(
      issue(
        "BASELINE_GOVERNANCE_INVALID",
        "baseline governance must define owner, validity, and ratchet policy",
      ),
    );
  } else {
    if (
      validDate(source?.captured_at) &&
      Date.parse(governance.valid_until) <= Date.parse(source.captured_at)
    ) {
      issues.push(
        issue(
          "BASELINE_VALIDITY_INVALID",
          "baseline validity must end after the capture time",
        ),
      );
    }
    const nowDate = now instanceof Date ? now : new Date(now);
    if (
      !Number.isFinite(nowDate.getTime()) ||
      nowDate.getTime() >= Date.parse(governance.valid_until)
    ) {
      issues.push(
        issue(
          "BASELINE_EXPIRED",
          "production dependency baseline has expired and must be reviewed",
        ),
      );
    }
  }

  const advisories = Array.isArray(baseline?.advisories)
    ? baseline.advisories
    : [];
  if (!Array.isArray(baseline?.advisories)) {
    issues.push(
      issue(
        "BASELINE_ADVISORIES_INVALID",
        "baseline advisories must be an array",
      ),
    );
  }
  for (const advisory of advisories) {
    issues.push(...baselineAdvisoryIssues(advisory, governance?.valid_until));
  }
  const identities = advisories
    .filter((advisory) => isObject(advisory))
    .map(advisoryIdentity);
  if (new Set(identities).size !== identities.length) {
    issues.push(
      issue(
        "BASELINE_ADVISORY_DUPLICATE",
        "baseline advisory identities must be unique",
      ),
    );
  }

  const normalizedExposure = normalizeBaselineExposure(
    baseline?.exposure,
    new Set(identities),
  );
  issues.push(...normalizedExposure.issues);

  const calculatedCounts = countsFor(advisories);
  if (
    !isObject(baseline?.summary) ||
    baseline.summary.advisories !== advisories.length ||
    baseline.summary.exposures !== normalizedExposure.evidence.length ||
    !sameCounts(baseline.summary.vulnerabilities, calculatedCounts)
  ) {
    issues.push(
      issue(
        "BASELINE_SUMMARY_MISMATCH",
        "baseline summary must be derived from its advisory entries",
      ),
    );
  }

  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    advisory_count: advisories.length,
    exposure_fingerprints: normalizedExposure.fingerprints,
  });
}

function normalizePnpmAudit(audit) {
  const issues = [];
  if (
    !isObject(audit) ||
    !isObject(audit.advisories) ||
    !isObject(audit.metadata)
  ) {
    return {
      advisories: [],
      issues: [
        issue(
          "AUDIT_FORMAT_INVALID",
          "audit input must be pnpm JSON with advisories and metadata",
        ),
      ],
    };
  }
  if (audit.metadata.devDependencies !== 0) {
    issues.push(
      issue(
        "AUDIT_NOT_PRODUCTION_ONLY",
        "audit metadata must prove that development dependencies were excluded",
      ),
    );
  }
  const metadataCounts = [
    audit.metadata.dependencies,
    audit.metadata.devDependencies,
    audit.metadata.optionalDependencies,
    audit.metadata.totalDependencies,
  ];
  if (
    metadataCounts.some((count) => !Number.isInteger(count) || count < 0) ||
    audit.metadata.totalDependencies !==
      audit.metadata.dependencies +
        audit.metadata.devDependencies +
        audit.metadata.optionalDependencies
  ) {
    issues.push(
      issue(
        "AUDIT_METADATA_INVALID",
        "pnpm audit dependency metadata must contain consistent non-negative integer counts",
      ),
    );
  }

  const advisories = [];
  let pathEvidenceComplete = true;
  for (const raw of Object.values(audit.advisories)) {
    if (
      !isObject(raw) ||
      !GHSA_ID.test(raw.github_advisory_id ?? "") ||
      !isNonEmptyString(raw.module_name) ||
      !SEVERITIES.includes(raw.severity) ||
      !isNonEmptyString(raw.vulnerable_versions) ||
      !isNonEmptyString(raw.patched_versions) ||
      raw.url !==
        `https://github.com/advisories/${raw.github_advisory_id ?? ""}` ||
      !Array.isArray(raw.findings) ||
      raw.findings.length === 0
    ) {
      issues.push(
        issue(
          "AUDIT_ADVISORY_INVALID",
          "pnpm advisory is missing canonical identity, severity, versions, URL, or findings",
        ),
      );
      continue;
    }
    const findingFingerprints = [];
    let findingsValid = true;
    for (const finding of raw.findings) {
      if (
        !isObject(finding) ||
        !isNonEmptyString(finding.version) ||
        !Array.isArray(finding.paths) ||
        finding.paths.some((path) => !isNonEmptyString(path))
      ) {
        findingsValid = false;
        break;
      }
      const paths = finding.paths.length === 0 ? [null] : finding.paths;
      if (finding.paths.length === 0) pathEvidenceComplete = false;
      for (const path of paths) {
        findingFingerprints.push(
          findingFingerprint(
            {
              ghsa_id: raw.github_advisory_id,
              package: raw.module_name,
            },
            finding.version,
            path,
          ),
        );
      }
    }
    if (
      !findingsValid ||
      new Set(findingFingerprints).size !== findingFingerprints.length
    ) {
      issues.push(
        issue(
          "AUDIT_FINDINGS_INVALID",
          "pnpm advisory findings must contain unique version and dependency-path evidence",
        ),
      );
      continue;
    }
    advisories.push(
      Object.freeze({
        ghsa_id: raw.github_advisory_id,
        package: raw.module_name,
        severity: raw.severity,
        vulnerable_versions: raw.vulnerable_versions,
        patched_versions: raw.patched_versions,
        url: raw.url,
        finding_fingerprints: Object.freeze([...findingFingerprints].sort()),
        finding_evidence: Object.freeze(
          raw.findings.flatMap((finding) =>
            finding.paths.map((path) =>
              Object.freeze({
                ghsa_id: raw.github_advisory_id,
                package: raw.module_name,
                version: finding.version,
                path,
              }),
            ),
          ),
        ),
      }),
    );
  }
  const identities = advisories.map(advisoryIdentity);
  if (new Set(identities).size !== identities.length) {
    issues.push(
      issue(
        "AUDIT_ADVISORY_DUPLICATE",
        "pnpm audit advisory identities are not unique",
      ),
    );
  }
  if (!sameCounts(audit.metadata.vulnerabilities, countsFor(advisories))) {
    issues.push(
      issue(
        "AUDIT_SUMMARY_MISMATCH",
        "pnpm audit metadata does not match parsed advisory counts",
      ),
    );
  }
  return {
    advisories: Object.freeze(
      [...advisories].sort((left, right) =>
        advisoryIdentity(left).localeCompare(advisoryIdentity(right)),
      ),
    ),
    issues,
    path_evidence_complete: pathEvidenceComplete,
  };
}

export function buildProductionAuditExposure(audit) {
  const normalized = normalizePnpmAudit(audit);
  if (normalized.issues.length > 0 || !normalized.path_evidence_complete) {
    throw new Error("cannot build baseline exposure without complete findings");
  }
  const evidence = normalized.advisories
    .flatMap((advisory) => advisory.finding_evidence)
    .sort((left, right) =>
      findingFingerprint(left, left.version, left.path).localeCompare(
        findingFingerprint(right, right.version, right.path),
      ),
    );
  return Object.freeze({
    schema_version: EXPOSURE_SCHEMA,
    path_evidence: "REQUIRED",
    findings: Object.freeze(evidence),
  });
}

export function evaluateProductionAudit(
  audit,
  baseline,
  {
    now = new Date(),
    expectedBootstrapBase,
    expectedSourceLockfileDigest,
    comparisonAudit,
  } = {},
) {
  const baselineValidation = validateProductionAuditBaseline(baseline, {
    now,
    expectedBootstrapBase,
    expectedSourceLockfileDigest,
  });
  const normalizedAudit = normalizePnpmAudit(audit);
  const issues = [...baselineValidation.issues, ...normalizedAudit.issues];
  const normalizedComparison =
    comparisonAudit === undefined ? null : normalizePnpmAudit(comparisonAudit);
  if (normalizedComparison !== null && normalizedComparison.issues.length > 0) {
    issues.push(
      issue(
        "AUDIT_COMPARISON_INVALID",
        "trusted PR base audit is incomplete or malformed",
      ),
    );
  }
  if (
    !normalizedAudit.path_evidence_complete ||
    (normalizedComparison !== null &&
      !normalizedComparison.path_evidence_complete)
  ) {
    issues.push(
      issue(
        "AUDIT_PATH_EVIDENCE_INCOMPLETE",
        "production audit requires installed dependency paths for canonical comparison",
      ),
    );
  }
  const comparisonByIdentity =
    normalizedComparison === null || normalizedComparison.issues.length > 0
      ? null
      : new Map(
          normalizedComparison.advisories.map((item) => [
            advisoryIdentity(item),
            new Set(item.finding_fingerprints),
          ]),
        );
  const baselineByIdentity = new Map(
    (Array.isArray(baseline?.advisories) ? baseline.advisories : [])
      .filter((item) => isObject(item))
      .map((item) => [advisoryIdentity(item), item]),
  );
  const baselineExposureFingerprints = new Set(
    baselineValidation.exposure_fingerprints,
  );
  const currentIdentities = new Set();
  const nowDate = now instanceof Date ? now : new Date(now);

  for (const current of normalizedAudit.advisories) {
    const identity = advisoryIdentity(current);
    currentIdentities.add(identity);
    if (
      current.finding_fingerprints.some(
        (fingerprint) => !baselineExposureFingerprints.has(fingerprint),
      )
    ) {
      issues.push(
        issue(
          "AUDIT_EXPOSURE_NOT_BASELINED",
          `production advisory exposure is outside the initial baseline: ${identity}`,
        ),
      );
    }
    if (current.severity === "critical") {
      issues.push(
        issue(
          "AUDIT_CRITICAL_ADVISORY",
          `critical production advisory is never baselined: ${identity}`,
        ),
      );
    }
    const admitted = baselineByIdentity.get(identity);
    if (!admitted) {
      issues.push(
        issue("AUDIT_NEW_ADVISORY", `new production advisory: ${identity}`),
      );
      continue;
    }
    if (comparisonByIdentity !== null) {
      const comparisonFindings = comparisonByIdentity.get(identity);
      if (comparisonFindings === undefined) {
        issues.push(
          issue(
            "AUDIT_REINTRODUCED_ADVISORY",
            `production advisory reappeared relative to the PR base: ${identity}`,
          ),
        );
      } else if (
        current.finding_fingerprints.some(
          (fingerprint) => !comparisonFindings.has(fingerprint),
        )
      ) {
        issues.push(
          issue(
            "AUDIT_EXPOSURE_EXPANDED",
            `production advisory gained a vulnerable version or dependency path: ${identity}`,
          ),
        );
      }
    }
    if (SEVERITY_RANK[current.severity] > SEVERITY_RANK[admitted.severity]) {
      issues.push(
        issue(
          "AUDIT_SEVERITY_ESCALATED",
          `production advisory severity increased: ${identity}`,
        ),
      );
    }
    if (
      current.vulnerable_versions !== admitted.vulnerable_versions ||
      current.patched_versions !== admitted.patched_versions ||
      current.url !== admitted.url
    ) {
      issues.push(
        issue(
          "AUDIT_ADVISORY_METADATA_DRIFT",
          `production advisory risk metadata changed and needs review: ${identity}`,
        ),
      );
    }
    if (
      Number.isFinite(nowDate.getTime()) &&
      validDate(admitted.remediation?.due_at) &&
      nowDate.getTime() >= Date.parse(admitted.remediation.due_at)
    ) {
      issues.push(
        issue(
          "AUDIT_REMEDIATION_OVERDUE",
          `production advisory remediation is overdue: ${identity}`,
        ),
      );
    }
  }

  if (expectedBootstrapBase !== undefined) {
    const baselineIdentities = [...baselineByIdentity.keys()].sort();
    const observedIdentities = [...currentIdentities].sort();
    const exactIdentitySet =
      baselineIdentities.length === observedIdentities.length &&
      baselineIdentities.every(
        (identity, index) => identity === observedIdentities[index],
      );
    const exactMetadata =
      exactIdentitySet &&
      normalizedAudit.advisories.every((current) => {
        const admitted = baselineByIdentity.get(advisoryIdentity(current));
        return (
          admitted?.severity === current.severity &&
          admitted?.vulnerable_versions === current.vulnerable_versions &&
          admitted?.patched_versions === current.patched_versions &&
          admitted?.url === current.url
        );
      });
    if (!exactMetadata) {
      issues.push(
        issue(
          "BASELINE_BOOTSTRAP_SET_MISMATCH",
          "initial baseline must exactly equal the audited advisory identities and metadata",
        ),
      );
    }
    const baselineExposure = [...baselineExposureFingerprints].sort();
    const observedExposure = normalizedAudit.advisories
      .flatMap((item) => item.finding_fingerprints)
      .sort();
    if (
      baselineExposure.length !== observedExposure.length ||
      baselineExposure.some(
        (fingerprint, index) => fingerprint !== observedExposure[index],
      )
    ) {
      issues.push(
        issue(
          "BASELINE_BOOTSTRAP_EXPOSURE_MISMATCH",
          "initial baseline must exactly equal the audited finding exposure",
        ),
      );
    }
  }

  const resolved = [...baselineByIdentity.keys()]
    .filter((identity) => !currentIdentities.has(identity))
    .sort();
  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
    current_advisories: normalizedAudit.advisories.length,
    resolved_advisories: Object.freeze(resolved),
  });
}

export function evaluateDependencyGraphDelta({
  trustedBase,
  candidate,
  relation,
  trustedBaseAudit,
  candidateAudit,
  baseline,
  now = new Date(),
} = {}) {
  const issues = [];
  if (!SHA_40.test(trustedBase ?? "") || !SHA_40.test(candidate ?? "")) {
    issues.push(
      issue(
        "DEPENDENCY_GRAPH_IDENTITY_INVALID",
        "dependency graph delta requires exact trusted-base and candidate commits",
      ),
    );
  }
  if (!["IDENTICAL_TO_TRUSTED_BASE", "CHANGED"].includes(relation ?? "")) {
    issues.push(
      issue(
        "DEPENDENCY_GRAPH_RELATION_INVALID",
        "dependency graph relation must be IDENTICAL_TO_TRUSTED_BASE or CHANGED",
      ),
    );
  }
  if (issues.length > 0) {
    return Object.freeze({
      ok: false,
      result: "AUDIT_INVALID_HOLD",
      trusted_base: trustedBase ?? null,
      candidate: candidate ?? null,
      issues: Object.freeze(issues),
    });
  }
  if (relation === "IDENTICAL_TO_TRUSTED_BASE") {
    return Object.freeze({
      ok: true,
      result: relation,
      trusted_base: trustedBase,
      candidate,
      issues: Object.freeze([]),
    });
  }
  if (
    trustedBaseAudit !== undefined &&
    candidateAudit !== undefined &&
    baseline !== undefined
  ) {
    const comparison = evaluateProductionAudit(candidateAudit, baseline, {
      now,
      comparisonAudit: trustedBaseAudit,
    });
    if (comparison.ok) {
      return Object.freeze({
        ok: true,
        result: "COMPARABLE_AUDIT_PASS",
        trusted_base: trustedBase,
        candidate,
        current_advisories: comparison.current_advisories,
        resolved_advisories: comparison.resolved_advisories,
        issues: Object.freeze([]),
      });
    }
    return Object.freeze({
      ok: false,
      result: "AUDIT_SNAPSHOT_INCONCLUSIVE",
      trusted_base: trustedBase,
      candidate,
      issues: comparison.issues,
    });
  }
  return Object.freeze({
    ok: false,
    result: "AUDIT_SNAPSHOT_INCONCLUSIVE",
    trusted_base: trustedBase,
    candidate,
    issues: Object.freeze([
      issue(
        "DEPENDENCY_GRAPH_CHANGED",
        "changed dependency graph requires a comparable external audit snapshot",
      ),
    ]),
  });
}

export function buildDependencyGraphDeltaReceipt(
  result,
  { trustedBaseAuditDigest, candidateAuditDigest, observedAt } = {},
) {
  if (
    !isObject(result) ||
    !SHA_40.test(result.trusted_base ?? "") ||
    !SHA_40.test(result.candidate ?? "") ||
    ![
      "IDENTICAL_TO_TRUSTED_BASE",
      "COMPARABLE_AUDIT_PASS",
      "AUDIT_SNAPSHOT_INCONCLUSIVE",
    ].includes(result.result) ||
    !Array.isArray(result.issues) ||
    result.ok !==
      ["IDENTICAL_TO_TRUSTED_BASE", "COMPARABLE_AUDIT_PASS"].includes(
        result.result,
      )
  ) {
    throw new Error("cannot build a dependency graph delta receipt");
  }
  if (result.result === "COMPARABLE_AUDIT_PASS") {
    if (
      !Number.isInteger(result.current_advisories) ||
      result.current_advisories < 0 ||
      !Array.isArray(result.resolved_advisories) ||
      !SHA256.test(trustedBaseAuditDigest ?? "") ||
      !SHA256.test(candidateAuditDigest ?? "") ||
      !validDate(observedAt)
    ) {
      throw new Error("cannot build a comparable dependency audit receipt");
    }
    return Object.freeze({
      schema_version: GRAPH_DELTA_SCHEMA,
      result: result.result,
      trusted_base: result.trusted_base,
      candidate: result.candidate,
      current_advisories: result.current_advisories,
      resolved_advisories: Object.freeze([...result.resolved_advisories]),
      trusted_base_audit_digest: trustedBaseAuditDigest,
      candidate_audit_digest: candidateAuditDigest,
      observed_at: new Date(observedAt).toISOString(),
      registry: OFFICIAL_REGISTRY,
    });
  }
  return Object.freeze({
    schema_version: GRAPH_DELTA_SCHEMA,
    result: result.result,
    trusted_base: result.trusted_base,
    candidate: result.candidate,
  });
}

export function evaluateProductionAuditBaselineFreshness(
  audit,
  baseline,
  options = {},
) {
  const ratchet = evaluateProductionAudit(audit, baseline, options);
  const issueCodes = new Set(ratchet.issues.map((item) => item.code));
  const result = ratchet.ok
    ? "FRESH"
    : issueCodes.has("AUDIT_CRITICAL_ADVISORY")
      ? "CRITICAL_ADVISORY_HOLD"
      : [
            "AUDIT_EXPOSURE_NOT_BASELINED",
            "AUDIT_NEW_ADVISORY",
            "AUDIT_REINTRODUCED_ADVISORY",
            "AUDIT_EXPOSURE_EXPANDED",
            "AUDIT_SEVERITY_ESCALATED",
            "AUDIT_ADVISORY_METADATA_DRIFT",
          ].some((code) => issueCodes.has(code))
        ? "BASELINE_STALE"
        : "AUDIT_INVALID_HOLD";
  return Object.freeze({
    ...ratchet,
    result,
  });
}

export function buildProductionAuditBaselineFreshnessReceipt(
  result,
  {
    subjectCommit,
    lockfileDigest,
    verifierDigest,
    sourcePolicyDigest,
    auditDigest,
    observedAt,
  } = {},
) {
  if (
    !isObject(result) ||
    ![
      "FRESH",
      "BASELINE_STALE",
      "CRITICAL_ADVISORY_HOLD",
      "AUDIT_INVALID_HOLD",
    ].includes(result.result) ||
    !Number.isInteger(result.current_advisories) ||
    result.current_advisories < 0 ||
    !Array.isArray(result.resolved_advisories) ||
    !Array.isArray(result.issues) ||
    !SHA_40.test(subjectCommit ?? "") ||
    ![lockfileDigest, verifierDigest, sourcePolicyDigest, auditDigest].every(
      (digest) => SHA256.test(digest ?? ""),
    ) ||
    !validDate(observedAt)
  ) {
    throw new Error("freshness provenance is invalid");
  }
  return Object.freeze({
    schema_version: FRESHNESS_SCHEMA,
    result: result.result,
    hold: result.result !== "FRESH",
    current_advisories: result.current_advisories,
    resolved_advisories: Object.freeze([...result.resolved_advisories]),
    issues: Object.freeze(result.issues.map((item) => item.code)),
    provenance: Object.freeze({
      subject_commit: subjectCommit,
      lockfile_digest: lockfileDigest,
      verifier_digest: verifierDigest,
      source_policy_digest: sourcePolicyDigest,
      audit_digest: auditDigest,
      observed_at: new Date(observedAt).toISOString(),
      registry: OFFICIAL_REGISTRY,
    }),
  });
}

export function buildProductionAuditReceipt(result) {
  if (
    !isObject(result) ||
    result.ok !== true ||
    !Number.isInteger(result.current_advisories) ||
    result.current_advisories < 0 ||
    !Array.isArray(result.resolved_advisories)
  ) {
    throw new Error("cannot build a passing receipt from an invalid result");
  }
  return Object.freeze({
    schema_version: "production-dependency-audit-result/v1",
    result:
      result.current_advisories === 0
        ? "PASS_CLEAR"
        : "RATCHET_PASS_WITH_LEGACY_RISK",
    current_advisories: result.current_advisories,
    resolved_advisories: Object.freeze([...result.resolved_advisories]),
    registry: OFFICIAL_REGISTRY,
  });
}

async function readBoundedJson(path) {
  return JSON.parse(await readBoundedRegularText(path, MAX_INPUT_BYTES));
}

function runPnpmProductionAudit(repositoryRoot = process.cwd()) {
  const root = resolve(repositoryRoot);
  assertNoRepositoryNpmrc(listTrackedRepositoryNpmrc(root));
  const execution = spawnSync(
    "pnpm",
    ["audit", "--prod", "--registry=https://registry.npmjs.org", "--json"],
    {
      encoding: "utf8",
      maxBuffer: MAX_INPUT_BYTES,
      env: buildTrustedPnpmEnvironment(),
      cwd: root,
    },
  );
  if (
    execution.error ||
    execution.signal ||
    ![0, 1].includes(execution.status)
  ) {
    throw new Error(
      "pnpm production audit did not complete with a parseable status",
    );
  }
  const audit = JSON.parse(execution.stdout);
  return Object.freeze({
    audit,
    digest: `sha256:${createHash("sha256")
      .update(execution.stdout)
      .digest("hex")}`,
  });
}

function parseOptionPairs(tokens, allowedOptions) {
  if (tokens.length % 2 !== 0) {
    throw new Error(`missing value for ${tokens.at(-1) ?? "argument"}`);
  }
  const options = Object.create(null);
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!allowedOptions.has(option)) {
      throw new Error(`unsupported argument: ${option}`);
    }
    if (!value) throw new Error(`missing value for ${option}`);
    if (Object.hasOwn(options, option)) {
      throw new Error(`duplicate argument: ${option}`);
    }
    options[option] = value;
  }
  return options;
}

function requireOptions(options, names) {
  for (const name of names) {
    if (!options[name]) throw new Error(`missing required argument: ${name}`);
  }
}

function parseCliArguments(argv) {
  const [command = "", ...tokens] = argv;
  if (command === "graph-delta") {
    const values = parseOptionPairs(
      tokens,
      new Set([
        "--trusted-base",
        "--candidate",
        "--relation",
        "--trusted-base-root",
        "--candidate-root",
      ]),
    );
    requireOptions(values, ["--trusted-base", "--candidate", "--relation"]);
    return Object.freeze({
      command,
      trustedBase: values["--trusted-base"],
      candidate: values["--candidate"],
      relation: values["--relation"],
      trustedBaseRoot: values["--trusted-base-root"],
      candidateRoot: values["--candidate-root"],
    });
  }
  if (command === "baseline-freshness") {
    const values = parseOptionPairs(
      tokens,
      new Set([
        "--baseline",
        "--audit-file",
        "--subject-commit",
        "--lockfile-digest",
        "--verifier-digest",
        "--source-policy-digest",
        "--audit-digest",
        "--observed-at",
      ]),
    );
    requireOptions(values, [
      "--baseline",
      "--audit-file",
      "--subject-commit",
      "--lockfile-digest",
      "--verifier-digest",
      "--source-policy-digest",
      "--audit-digest",
      "--observed-at",
    ]);
    return Object.freeze({
      command,
      baseline: values["--baseline"],
      auditFile: values["--audit-file"],
      subjectCommit: values["--subject-commit"],
      lockfileDigest: values["--lockfile-digest"],
      verifierDigest: values["--verifier-digest"],
      sourcePolicyDigest: values["--source-policy-digest"],
      auditDigest: values["--audit-digest"],
      observedAt: values["--observed-at"],
    });
  }
  if (command !== "verify")
    throw new Error(
      "expected command: verify, graph-delta, or baseline-freshness",
    );
  const options = {
    command,
    baseline: "docs/security/production-dependency-audit-baseline.json",
    auditFile: null,
    comparisonAuditFile: null,
    expectedBootstrapBase: undefined,
    expectedSourceLockfileDigest: undefined,
  };
  const values = parseOptionPairs(
    tokens,
    new Set([
      "--baseline",
      "--audit-file",
      "--comparison-audit-file",
      "--expected-bootstrap-base",
      "--expected-source-lockfile-digest",
    ]),
  );
  for (const [option, value] of Object.entries(values)) {
    if (option === "--baseline") options.baseline = value;
    else if (option === "--audit-file") options.auditFile = value;
    else if (option === "--comparison-audit-file") {
      options.comparisonAuditFile = value;
    } else if (option === "--expected-bootstrap-base") {
      options.expectedBootstrapBase = value;
    } else if (option === "--expected-source-lockfile-digest") {
      options.expectedSourceLockfileDigest = value;
    } else throw new Error(`unsupported argument: ${option}`);
  }
  return Object.freeze(options);
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  if (options.command === "graph-delta") {
    if (!options.trustedBaseRoot || !options.candidateRoot) {
      throw new Error(
        "dependency graph proof requires exact base and candidate roots",
      );
    }
    const trustedBaseSubject = assertRepositoryAuditSubject(
      options.trustedBaseRoot,
      options.trustedBase,
    );
    const candidateSubject = assertRepositoryAuditSubject(
      options.candidateRoot,
      options.candidate,
    );
    let auditInputs = Object.freeze({});
    let receiptInputs = Object.freeze({});
    if (options.relation === "CHANGED") {
      const trustedBaseRoot = trustedBaseSubject.root;
      const candidateRoot = candidateSubject.root;
      for (const root of [trustedBaseRoot, candidateRoot]) {
        const sourcePolicy = await validateRepositoryDependencySources(root);
        if (!sourcePolicy.ok) {
          throw new Error("repository dependency sources are not trusted");
        }
      }
      const trustedBaseAudit = runPnpmProductionAudit(trustedBaseRoot);
      const candidateAudit = runPnpmProductionAudit(candidateRoot);
      auditInputs = Object.freeze({
        trustedBaseAudit: trustedBaseAudit.audit,
        candidateAudit: candidateAudit.audit,
        baseline: await readBoundedJson(
          resolve(
            trustedBaseRoot,
            "docs/security/production-dependency-audit-baseline.json",
          ),
        ),
      });
      receiptInputs = Object.freeze({
        trustedBaseAuditDigest: trustedBaseAudit.digest,
        candidateAuditDigest: candidateAudit.digest,
        observedAt: new Date().toISOString(),
      });
    }
    const result = evaluateDependencyGraphDelta({ ...options, ...auditInputs });
    console.log(
      JSON.stringify(buildDependencyGraphDeltaReceipt(result, receiptInputs)),
    );
    if (!result.ok) {
      for (const item of result.issues)
        console.error(`[${item.code}] ${item.message}`);
      process.exitCode = 1;
    }
    return;
  }
  const sourcePolicy = await validateRepositoryDependencySources(process.cwd());
  if (!sourcePolicy.ok) {
    throw new Error("repository dependency sources are not trusted");
  }
  const baseline = await readBoundedJson(resolve(options.baseline));
  if (options.command === "baseline-freshness") {
    const audit = await readBoundedJson(resolve(options.auditFile));
    const result = evaluateProductionAuditBaselineFreshness(audit, baseline, {
      expectedSourceLockfileDigest: options.lockfileDigest,
    });
    const receipt = buildProductionAuditBaselineFreshnessReceipt(
      result,
      options,
    );
    console.log(JSON.stringify(receipt));
    if (!result.ok) {
      for (const item of result.issues)
        console.error(`[${item.code}] ${item.message}`);
      process.exitCode = 1;
    }
    return;
  }
  const audit = options.auditFile
    ? await readBoundedJson(resolve(options.auditFile))
    : runPnpmProductionAudit().audit;
  const comparisonAudit = options.comparisonAuditFile
    ? await readBoundedJson(resolve(options.comparisonAuditFile))
    : undefined;
  const result = evaluateProductionAudit(audit, baseline, {
    expectedBootstrapBase: options.expectedBootstrapBase,
    expectedSourceLockfileDigest: options.expectedSourceLockfileDigest,
    comparisonAudit,
  });
  if (!result.ok) {
    for (const item of result.issues) {
      console.error(`[${item.code}] ${item.message}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(buildProductionAuditReceipt(result)));
}

const directExecution =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (directExecution) {
  main().catch((error) => {
    console.error(
      `[AUDIT_EXECUTION_FAILED] ${
        error instanceof Error ? error.message : "unknown failure"
      }`,
    );
    process.exitCode = 1;
  });
}
