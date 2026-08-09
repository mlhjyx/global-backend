import { posix as pathPosix } from "node:path";

const SHA_40 = /^[0-9a-f]{40}$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]*$/i;
const PROVIDER_STATUSES = new Set([
  "IMPLEMENTED",
  "PARTIAL",
  "DESIGN_ONLY",
  "NOT_STARTED",
]);
const ENABLEMENT = new Set(["ENABLED", "DISABLED", "CONDITIONAL"]);
const PERSONAL_DATA_CLASSES = new Set([
  "NONE",
  "COMPANY_ONLY",
  "RESTRICTED_POSSIBLE",
  "PERSONAL_DATA",
]);
const DELIVERY_STATES = new Set([
  "INTERNAL_ONLY",
  "PILOT",
  "GA",
  "HISTORICAL",
]);
const RELEASE_STATUSES = new Set([
  "CANDIDATE",
  "PILOT",
  "GA",
  "ROLLED_BACK",
]);
const EVIDENCE_RESULTS = new Set(["PASS", "FAIL", "UNKNOWN"]);
const EVIDENCE_ENVIRONMENTS = new Set([
  "development",
  "test",
  "pilot",
  "production",
]);
const PROMOTION_STATES = new Set(["PILOT", "GA"]);
const PROVIDER_EVIDENCE_KINDS = new Set([
  "TEST_ANCHOR",
  "HISTORICAL_EVIDENCE",
]);
const MAX_RUNTIME_EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;

function issue(code, message, path = null) {
  return Object.freeze({ code, message, ...(path ? { path } : {}) });
}

function result(issues, extra = {}) {
  return Object.freeze({ issues: Object.freeze([...issues]), ...extra });
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoInstant(value) {
  if (!isNonEmptyString(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
  return new Set(values).size === values.length;
}

function sameStringSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right)) return false;
  if (left.length !== right.length || !uniqueStrings(left) || !uniqueStrings(right)) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function normalizedRepoPath(value) {
  if (!isNonEmptyString(value)) return null;
  const normalized = pathPosix.normalize(value);
  if (
    value.startsWith("/") ||
    value.split("/").includes("..") ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../")
  ) {
    return null;
  }
  return normalized;
}

function pushRequiredString(issues, object, field, code, prefix = "") {
  if (!isNonEmptyString(object?.[field])) {
    issues.push(issue(code, `${prefix}${field} must be a non-empty string`));
  }
}

function markdownCell(value) {
  if (Array.isArray(value)) return value.map(markdownCell).join("<br>");
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdownList(values) {
  if (!Array.isArray(values) || values.length === 0) return "- None";
  return values.map((value) => `- ${value}`).join("\n");
}

function jsonBlock(value) {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function containsTemplateToken(value) {
  if (typeof value === "string") {
    return /^(?:TBD|TODO|REPLACE(?:_|$)|<[^>]+>|__[^_]+__)|\bREPLACE_WITH\b/i.test(
      value.trim(),
    );
  }
  if (Array.isArray(value)) return value.some(containsTemplateToken);
  if (isObject(value)) return Object.values(value).some(containsTemplateToken);
  return false;
}

export function parseSeedProviders(source) {
  const seeds = [];
  for (const match of String(source).matchAll(/create:\s*\{([^{}]*)\}/gs)) {
    const body = match[1];
    const key = body.match(/\bkey:\s*['"]([^'"]+)['"]/)?.[1];
    const sourceClass = body.match(/\bclass:\s*['"]([^'"]+)['"]/)?.[1];
    const status = body.match(/\bstatus:\s*['"](ENABLED|DISABLED)['"]/)?.[1];
    if (!key || !sourceClass || !status) continue;
    seeds.push({
      key,
      source_class: sourceClass,
      default_enablement: key === "sandbox" ? "CONDITIONAL" : status,
    });
  }
  return seeds;
}

export function validateRuntimeEvidence(evidence, options = {}) {
  const issues = [];
  const now = options.now instanceof Date ? options.now : new Date();

  if (!isObject(evidence)) {
    return result([issue("EVIDENCE_OBJECT_REQUIRED", "evidence must be an object")], {
      classification: "INVALID",
      eligible_for_promotion: false,
    });
  }
  if (evidence.schema_version !== "runtime-evidence/v1") {
    issues.push(
      issue(
        "EVIDENCE_SCHEMA_UNSUPPORTED",
        "schema_version must equal runtime-evidence/v1",
      ),
    );
  }
  if (!isNonEmptyString(evidence.evidence_id) || !IDENTIFIER.test(evidence.evidence_id)) {
    issues.push(issue("EVIDENCE_ID_INVALID", "evidence_id is invalid"));
  }
  if (!SHA_40.test(evidence.commit ?? "")) {
    issues.push(issue("EVIDENCE_COMMIT_INVALID", "commit must be a full Git SHA"));
  }
  if (!EVIDENCE_ENVIRONMENTS.has(evidence.environment)) {
    issues.push(
      issue("EVIDENCE_ENVIRONMENT_INVALID", "environment is not recognized"),
    );
  }
  if (!isIsoInstant(evidence.verified_at)) {
    issues.push(
      issue("EVIDENCE_VERIFIED_AT_INVALID", "verified_at must be an ISO instant"),
    );
  }
  if (!isIsoInstant(evidence.valid_until)) {
    issues.push(
      issue("EVIDENCE_VALID_UNTIL_INVALID", "valid_until must be an ISO instant"),
    );
  }
  if (
    isIsoInstant(evidence.verified_at) &&
    isIsoInstant(evidence.valid_until) &&
    Date.parse(evidence.valid_until) <= Date.parse(evidence.verified_at)
  ) {
    issues.push(
      issue(
        "EVIDENCE_WINDOW_INVALID",
        "valid_until must be later than verified_at",
      ),
    );
  }
  if (
    isIsoInstant(evidence.verified_at) &&
    isIsoInstant(evidence.valid_until) &&
    Date.parse(evidence.valid_until) - Date.parse(evidence.verified_at) >
      MAX_RUNTIME_EVIDENCE_WINDOW_MS
  ) {
    issues.push(
      issue(
        "EVIDENCE_WINDOW_TOO_LONG",
        "RuntimeEvidence validity cannot exceed 24 hours",
      ),
    );
  }
  if (!isNonEmptyString(evidence.evidence_kind)) {
    issues.push(
      issue("EVIDENCE_KIND_INVALID", "evidence_kind must be a non-empty string"),
    );
  }
  if (!EVIDENCE_RESULTS.has(evidence.result)) {
    issues.push(issue("EVIDENCE_RESULT_INVALID", "result is not recognized"));
  }
  if (!SHA256_DIGEST.test(evidence.artifact_digest ?? "")) {
    issues.push(
      issue(
        "EVIDENCE_DIGEST_INVALID",
        "artifact_digest must be sha256 followed by 64 lowercase hex characters",
      ),
    );
  }
  if (
    evidence.artifact_path !== undefined &&
    normalizedRepoPath(evidence.artifact_path) === null
  ) {
    issues.push(
      issue(
        "EVIDENCE_ARTIFACT_PATH_INVALID",
        "artifact_path must identify a repository-relative file",
      ),
    );
  }

  const classification =
    issues.length > 0
      ? "INVALID"
      : now.getTime() >= Date.parse(evidence.verified_at) &&
          now.getTime() < Date.parse(evidence.valid_until)
        ? "CURRENT"
        : "HISTORICAL";
  return result(issues, {
    classification,
    eligible_for_promotion:
      classification === "CURRENT" && evidence.result === "PASS",
  });
}

function validateProviderShape(provider, index, existingPaths) {
  const issues = [];
  const prefix = `providers[${index}].`;
  if (!isObject(provider)) {
    return [issue("PROVIDER_OBJECT_REQUIRED", `${prefix} must be an object`)];
  }
  if (!isNonEmptyString(provider.key) || !IDENTIFIER.test(provider.key)) {
    issues.push(issue("PROVIDER_KEY_INVALID", `${prefix}key is invalid`));
  }
  if (!PROVIDER_STATUSES.has(provider.status)) {
    issues.push(issue("PROVIDER_STATUS_INVALID", `${prefix}status is invalid`));
  }
  if (
    !Array.isArray(provider.source_classes) ||
    provider.source_classes.length === 0 ||
    provider.source_classes.some((item) => !isNonEmptyString(item)) ||
    !uniqueStrings(provider.source_classes)
  ) {
    issues.push(
      issue(
        "PROVIDER_SOURCE_CLASSES_INVALID",
        `${prefix}source_classes must be unique non-empty strings`,
      ),
    );
  }
  pushRequiredString(issues, provider, "purpose", "PROVIDER_PURPOSE_INVALID", prefix);
  if (!Array.isArray(provider.taxonomy) || provider.taxonomy.length === 0) {
    issues.push(
      issue("PROVIDER_TAXONOMY_INVALID", `${prefix}taxonomy must not be empty`),
    );
  }
  if (
    !isObject(provider.license) ||
    !isNonEmptyString(provider.license.classification) ||
    !isNonEmptyString(provider.license.note)
  ) {
    issues.push(
      issue(
        "PROVIDER_LICENSE_INVALID",
        `${prefix}license needs classification and note`,
      ),
    );
  }
  if (!PERSONAL_DATA_CLASSES.has(provider.personal_data_class)) {
    issues.push(
      issue(
        "PROVIDER_PERSONAL_DATA_CLASS_INVALID",
        `${prefix}personal_data_class is invalid`,
      ),
    );
  }
  if (!ENABLEMENT.has(provider.default_enablement)) {
    issues.push(
      issue(
        "PROVIDER_ENABLEMENT_INVALID",
        `${prefix}default_enablement is invalid`,
      ),
    );
  }
  if (
    !Array.isArray(provider.call_gates) ||
    provider.call_gates.length === 0 ||
    provider.call_gates.some((item) => !isNonEmptyString(item))
  ) {
    issues.push(
      issue("PROVIDER_CALL_GATES_INVALID", `${prefix}call_gates must not be empty`),
    );
  }
  if (!Array.isArray(provider.test_paths) || provider.test_paths.length === 0) {
    issues.push(
      issue("PROVIDER_TEST_PATHS_INVALID", `${prefix}test_paths must not be empty`),
    );
  }
  for (const testPath of asArray(provider.test_paths)) {
    const normalized = normalizedRepoPath(testPath);
    if (!normalized || !/(?:^|\/)[^/]*(?:spec|test)\.[cm]?[jt]sx?$/.test(normalized)) {
      issues.push(
        issue("PROVIDER_TEST_PATH_INVALID", `${prefix}${testPath} is not a test path`),
      );
    } else if (existingPaths && !existingPaths.has(normalized)) {
      issues.push(
        issue("PROVIDER_TEST_MISSING", `${prefix}${normalized} does not exist`, normalized),
      );
    }
  }
  if (
    !Array.isArray(provider.evidence_refs) ||
    provider.evidence_refs.length === 0 ||
    provider.evidence_refs.some(
      (ref) =>
        !isObject(ref) ||
        !isNonEmptyString(ref.kind) ||
        !isNonEmptyString(ref.path),
    )
  ) {
    issues.push(
      issue(
        "PROVIDER_EVIDENCE_REFS_INVALID",
        `${prefix}evidence_refs must include kind and path`,
      ),
    );
  } else {
    for (const ref of provider.evidence_refs) {
      const normalized = normalizedRepoPath(ref.path);
      if (!PROVIDER_EVIDENCE_KINDS.has(ref.kind)) {
        issues.push(
          issue(
            "PROVIDER_EVIDENCE_KIND_INVALID",
            `${prefix}${ref.kind} is not a recognized evidence kind`,
          ),
        );
      }
      if (!normalized || (existingPaths && !existingPaths.has(normalized))) {
        issues.push(
          issue(
            "PROVIDER_EVIDENCE_MISSING",
            `${prefix}${ref.path} does not exist`,
            normalized,
          ),
        );
      }
    }
  }
  return issues;
}

export function validateProviderRegistry(registry, context = {}) {
  const issues = [];
  if (!isObject(registry) || registry.schema_version !== "provider-registry/v1") {
    issues.push(
      issue(
        "PROVIDER_REGISTRY_SCHEMA_INVALID",
        "schema_version must equal provider-registry/v1",
      ),
    );
  }
  const providers = asArray(registry?.providers);
  if (providers.length === 0) {
    issues.push(issue("PROVIDER_REGISTRY_EMPTY", "providers must not be empty"));
  }
  for (const [index, provider] of providers.entries()) {
    issues.push(
      ...validateProviderShape(provider, index, context.existing_paths),
    );
  }

  const providerKeys = providers.map((provider) => provider?.key);
  if (!uniqueStrings(providerKeys)) {
    issues.push(issue("PROVIDER_KEY_DUPLICATE", "provider keys must be unique"));
  }

  const documented = new Map(
    providers
      .filter((provider) => isNonEmptyString(provider?.key))
      .map((provider) => [provider.key, provider]),
  );
  const seeded = new Map(
    asArray(context.seed_providers).map((provider) => [provider.key, provider]),
  );
  const sourceClassManifest = isObject(context.source_class_manifest)
    ? context.source_class_manifest
    : {};
  if (providers.length > 0 && Object.keys(sourceClassManifest).length === 0) {
    issues.push(
      issue(
        "PROVIDER_SOURCE_CLASS_MANIFEST_EMPTY",
        "code-owned provider SourceClass manifest is missing or empty",
      ),
    );
  }
  if (providers.length > 0 && seeded.size === 0) {
    issues.push(
      issue(
        "PROVIDER_SEED_PARSE_EMPTY",
        "provider seed source produced no key/SourceClass/enablement records",
      ),
    );
  }
  for (const [key, seed] of seeded) {
    const provider = documented.get(key);
    if (!provider) {
      issues.push(
        issue("PROVIDER_SEED_UNDOCUMENTED", `seeded provider ${key} is undocumented`),
      );
      continue;
    }
    if (!asArray(provider.source_classes).includes(seed.source_class)) {
      issues.push(
        issue(
          "PROVIDER_SOURCE_CLASS_DRIFT",
          `${key} does not include seeded SourceClass ${seed.source_class}`,
        ),
      );
    }
    if (provider.default_enablement !== seed.default_enablement) {
      issues.push(
        issue(
          "PROVIDER_ENABLEMENT_DRIFT",
          `${key} documents ${provider.default_enablement}, code seeds ${seed.default_enablement}`,
        ),
      );
    }
  }
  for (const key of documented.keys()) {
    if (!seeded.has(key)) {
      issues.push(
        issue("PROVIDER_DOCUMENTED_NOT_SEEDED", `${key} is documented but not seeded`),
      );
    }
    const provider = documented.get(key);
    if (!sameStringSet(provider?.source_classes, sourceClassManifest[key])) {
      issues.push(
        issue(
          "PROVIDER_SOURCE_CLASS_DRIFT",
          `${key} SourceClass set does not exactly match the code-owned manifest`,
        ),
      );
    }
  }
  for (const key of Object.keys(sourceClassManifest)) {
    if (!documented.has(key)) {
      issues.push(
        issue(
          "PROVIDER_SOURCE_CLASS_UNDOCUMENTED",
          `code-owned SourceClass manifest contains undocumented provider ${key}`,
        ),
      );
    }
  }
  return result(issues, { provider_count: providers.length });
}

export function renderProviderRegistry(registry) {
  const providers = [...asArray(registry?.providers)].sort((left, right) =>
    String(left.key).localeCompare(String(right.key)),
  );
  const rows = providers
    .map((provider) => {
      const evidence = asArray(provider.evidence_refs).map(
        (ref) => `${ref.kind}: ${ref.path}`,
      );
      return `| \`${markdownCell(provider.key)}\` | \`${markdownCell(provider.status)}\` | ${markdownCell(provider.source_classes)} | ${markdownCell(provider.purpose)} | ${markdownCell(provider.taxonomy)} | ${markdownCell(provider.license?.classification)} — ${markdownCell(provider.license?.note)} | \`${markdownCell(provider.personal_data_class)}\` | \`${markdownCell(provider.default_enablement)}\` | ${markdownCell(provider.call_gates)} | ${markdownCell(provider.test_paths)}<br>${markdownCell(evidence)} |`;
    })
    .join("\n");

  return `# Provider Registry

> 文档 ID：\`BACKEND-PROVIDER-REGISTRY-001\`
> 生命周期：\`CURRENT\`
> 状态：\`CURRENT\`
> 当前事实来源：\`docs/governance/provider-registry.json\` + \`apps/api/src/discovery/provider-source-classes.json\` + \`apps/api/src/discovery/provider.registry.ts\`
> Generated by：\`node scripts/governance-verify.mjs generate-provider-doc\`

This page is generated from the machine registry. Edit the JSON source and regenerate; do not hand-edit this table.

## Fields

- **Status** is implementation status, not runtime health.
- **SourceClass** must exactly match the code-owned manifest; instantiated discovery adapters assert the same set before routing.
- **Personal data class** describes the most sensitive admitted payload, not the licence.
- **Default enablement** is the seed default; runtime policy can still fail closed.
- **Call gates** are mandatory pre-call controls. Test and evidence anchors do not prove a current runtime result.

## Providers

| Key | Status | SourceClass | Purpose | Taxonomy | Licence | Personal data class | Default enablement | Call gates | Tests / evidence |
|---|---|---|---|---|---|---|---|---|---|
${rows}
`;
}

export {
  DELIVERY_STATES,
  EVIDENCE_ENVIRONMENTS,
  IDENTIFIER,
  PROMOTION_STATES,
  RELEASE_STATUSES,
  SHA_40,
  asArray,
  containsTemplateToken,
  isIsoInstant,
  isNonEmptyString,
  isObject,
  issue,
  jsonBlock,
  markdownList,
  normalizedRepoPath,
  pushRequiredString,
  result,
  sameStringSet,
  uniqueStrings,
};
