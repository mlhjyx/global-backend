import { spawnSync } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BASELINE_SCHEMA = "production-dependency-audit-baseline/v1";
const OFFICIAL_REGISTRY = "https://registry.npmjs.org/";
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

function advisoryIdentity(advisory) {
  return `${advisory.ghsa_id}|${advisory.package}`;
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

  const calculatedCounts = countsFor(advisories);
  if (
    !isObject(baseline?.summary) ||
    baseline.summary.advisories !== advisories.length ||
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
    advisories.push(
      Object.freeze({
        ghsa_id: raw.github_advisory_id,
        package: raw.module_name,
        severity: raw.severity,
        vulnerable_versions: raw.vulnerable_versions,
        patched_versions: raw.patched_versions,
        url: raw.url,
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
  };
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
  const comparisonIdentities =
    normalizedComparison === null || normalizedComparison.issues.length > 0
      ? null
      : new Set(
          normalizedComparison.advisories.map((item) => advisoryIdentity(item)),
        );
  const baselineByIdentity = new Map(
    (Array.isArray(baseline?.advisories) ? baseline.advisories : [])
      .filter((item) => isObject(item))
      .map((item) => [advisoryIdentity(item), item]),
  );
  const currentIdentities = new Set();
  const nowDate = now instanceof Date ? now : new Date(now);

  for (const current of normalizedAudit.advisories) {
    const identity = advisoryIdentity(current);
    currentIdentities.add(identity);
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
    if (comparisonIdentities !== null && !comparisonIdentities.has(identity)) {
      issues.push(
        issue(
          "AUDIT_REINTRODUCED_ADVISORY",
          `production advisory reappeared relative to the PR base: ${identity}`,
        ),
      );
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
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES) {
    throw new Error("input must be a bounded regular file");
  }
  return JSON.parse(await readFile(path, "utf8"));
}

function runPnpmProductionAudit() {
  const execution = spawnSync(
    "pnpm",
    ["audit", "--prod", "--registry=https://registry.npmjs.org", "--json"],
    {
      encoding: "utf8",
      maxBuffer: MAX_INPUT_BYTES,
      env: {
        ...process.env,
        NPM_CONFIG_REGISTRY: OFFICIAL_REGISTRY,
        npm_config_registry: OFFICIAL_REGISTRY,
      },
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
  return JSON.parse(execution.stdout);
}

function parseCliArguments(argv) {
  const [command = "", ...tokens] = argv;
  if (command !== "verify") throw new Error("expected command: verify");
  const options = {
    baseline: "docs/security/production-dependency-audit-baseline.json",
    auditFile: null,
    comparisonAuditFile: null,
    expectedBootstrapBase: undefined,
    expectedSourceLockfileDigest: undefined,
  };
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!value) throw new Error(`missing value for ${option ?? "argument"}`);
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
  const baseline = await readBoundedJson(resolve(options.baseline));
  const audit = options.auditFile
    ? await readBoundedJson(resolve(options.auditFile))
    : runPnpmProductionAudit();
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
