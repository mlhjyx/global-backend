import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { open } from "node:fs/promises";
import { GraphBuilder } from "../graph";
import { GraphNodeKind, SourceLocationV1 } from "../schema";
import {
  lineOf,
  readUtf8,
  relativePath,
  sha256,
  stableJson,
  walkFiles,
} from "../utils";

const GOVERNANCE_ID =
  /\b(CAP|SCN|PAGE|OBJ|OWN|DEC)-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;

const APPROVAL_JSON_BYTE_LIMIT = 64 * 1024;
const APPROVAL_ROLE_IDS = [
  "OWN-PRODUCT",
  "OWN-DATA-PRIVACY",
  "OWN-QA-EVIDENCE",
  "OWN-SECURITY",
  "LEGAL-REVIEW",
  "MERGE-AUTHORIZER",
] as const;
const DECISION_SUBJECT_IDS = ["ADR-026", "ADR-027"] as const;
const AUTHORITY_PURPOSE_BY_ROLE = Object.freeze({
  "OWN-PRODUCT": "DECISION_REVIEW",
  "OWN-DATA-PRIVACY": "DECISION_REVIEW",
  "OWN-QA-EVIDENCE": "QA_EVIDENCE_REVIEW",
  "OWN-SECURITY": "SECURITY_REVIEW",
  "LEGAL-REVIEW": "LEGAL_REVIEW",
  "MERGE-AUTHORIZER": "MERGE_AUTHORIZATION",
});
const AUTHORITY_REVISION = /^approval-authorities\/r[1-9][0-9]*$/;
const POLICY_REVISION = /^program-c\/policy-r[1-9][0-9]*$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const APPROVAL_SCHEMA_VERSIONS = Object.freeze({
  authority: "approval-authorities/v1",
  receipt: "product-privacy-approval-readback-receipt/v1",
  attestation: "trusted-approval-evidence-manifest/v1",
  verifier: "program-c-merge-authorization-consumption/v1",
  release: "release-bundle/v1",
});
const APPROVAL_SCHEMA_CANONICAL_SHA256 = Object.freeze({
  receipt: "fc440f57d9932fbcd8827df2d29a4e98fe87f2a68028d11e22a7467ba384e998",
  attestation:
    "70e64fc4c2b766124d5a29cecb1997ac5c26aad4e75061afb0918b6d76715b1e",
  verifier: "64aef09506fef75aa33f1cb038fd8607f383df468a4bf680773434433b8ac271",
  release: "3406f720c2dbac3b072f71a5805629f63dc6924072b0643cf573d235e716e3f1",
});
const AUTHORITY_RELATIONSHIPS = Object.freeze([
  {
    role: "OWN-PRODUCT",
    decisions: DECISION_SUBJECT_IDS,
    relation: "decision_approval_for",
  },
  {
    role: "OWN-DATA-PRIVACY",
    decisions: DECISION_SUBJECT_IDS,
    relation: "decision_approval_for",
  },
  {
    role: "OWN-QA-EVIDENCE",
    decisions: DECISION_SUBJECT_IDS,
    relation: "qa_evidence_review_for",
  },
  {
    role: "OWN-SECURITY",
    decisions: DECISION_SUBJECT_IDS,
    relation: "security_review_for",
  },
  {
    role: "LEGAL-REVIEW",
    decisions: ["ADR-026"],
    relation: "legal_input_for",
  },
  {
    role: "MERGE-AUTHORIZER",
    decisions: DECISION_SUBJECT_IDS,
    relation: "merge_authorization_for",
  },
] as const);
const STATIC_APPROVAL_ATTRIBUTES = Object.freeze({
  evidenceClass: "STATIC_CONTRACT",
  hostedReadback: "EXTERNAL_UNOBSERVED",
  runtimeEvidence: false,
  acceptance: false,
});

type JsonRecord = Record<string, unknown>;

interface BoundedJson {
  text: string;
  value: JsonRecord;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function recordAt(value: JsonRecord, key: string): JsonRecord | undefined {
  const child = value[key];
  return isRecord(child) ? child : undefined;
}

function stringAt(value: JsonRecord, key: string): string | undefined {
  const child = value[key];
  return typeof child === "string" ? child : undefined;
}

function stringArrayAt(value: JsonRecord | undefined, key: string): string[] {
  const child = value?.[key];
  return Array.isArray(child) && child.every((item) => typeof item === "string")
    ? child
    : [];
}

function sameOrderedStrings(
  actual: string[],
  expected: readonly string[],
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (
    index < text.length &&
    (text[index] === " " ||
      text[index] === "\t" ||
      text[index] === "\n" ||
      text[index] === "\r")
  )
    index += 1;
  return index;
}

function scanJsonString(text: string, start: number): number {
  if (text[start] !== '"') throw new Error("invalid JSON string");
  let index = start + 1;
  while (index < text.length) {
    const codePoint = text.charCodeAt(index);
    if (text[index] === '"') return index + 1;
    if (codePoint < 0x20) throw new Error("invalid JSON string");
    if (text[index] === "\\") {
      const escape = text[index + 1];
      if (escape === "u") {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6)))
          throw new Error("invalid JSON escape");
        index += 6;
        continue;
      }
      if (!escape || !'"\\/bfnrt'.includes(escape))
        throw new Error("invalid JSON escape");
      index += 2;
      continue;
    }
    index += 1;
  }
  throw new Error("unterminated JSON string");
}

function scanJsonValue(text: string, start: number, depth = 0): number {
  if (depth > 128) throw new Error("JSON nesting too deep");
  const index = skipJsonWhitespace(text, start);
  const character = text[index];
  if (character === '"') return scanJsonString(text, index);
  if (character === "{") {
    const keys = new Set<string>();
    let next = skipJsonWhitespace(text, index + 1);
    if (text[next] === "}") return next + 1;
    while (next < text.length) {
      const keyStart = next;
      next = scanJsonString(text, next);
      const key = JSON.parse(text.slice(keyStart, next)) as string;
      if (keys.has(key)) throw new Error("duplicate JSON key");
      keys.add(key);
      next = skipJsonWhitespace(text, next);
      if (text[next] !== ":") throw new Error("invalid JSON object");
      next = skipJsonWhitespace(text, scanJsonValue(text, next + 1, depth + 1));
      if (text[next] === "}") return next + 1;
      if (text[next] !== ",") throw new Error("invalid JSON object");
      next = skipJsonWhitespace(text, next + 1);
    }
    throw new Error("unterminated JSON object");
  }
  if (character === "[") {
    let next = skipJsonWhitespace(text, index + 1);
    if (text[next] === "]") return next + 1;
    while (next < text.length) {
      next = skipJsonWhitespace(text, scanJsonValue(text, next, depth + 1));
      if (text[next] === "]") return next + 1;
      if (text[next] !== ",") throw new Error("invalid JSON array");
      next = skipJsonWhitespace(text, next + 1);
    }
    throw new Error("unterminated JSON array");
  }
  const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  number.lastIndex = index;
  const numeric = number.exec(text);
  if (numeric) return index + numeric[0].length;
  for (const literal of ["true", "false", "null"])
    if (text.startsWith(literal, index)) return index + literal.length;
  throw new Error("invalid JSON value");
}

function parseUniqueJson(text: string): JsonRecord | undefined {
  const end = skipJsonWhitespace(text, scanJsonValue(text, 0));
  if (end !== text.length) throw new Error("trailing JSON content");
  const value: unknown = JSON.parse(text);
  return isRecord(value) ? value : undefined;
}

function hasExactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  return sameOrderedStrings(Object.keys(value).sort(), [...expected].sort());
}

function canonicalInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    CANONICAL_INSTANT.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value
  );
}

function assignedAuthorityRole(
  candidate: JsonRecord,
  expectedRole: (typeof APPROVAL_ROLE_IDS)[number],
): boolean {
  if (
    !hasExactKeys(candidate, [
      "role",
      "status",
      "actor_id",
      "actor_node_id",
      "actor_login",
      "effective_from",
      "effective_until",
      "scope",
      "assignment_evidence",
      "revocation_status",
      "superseded_by",
    ]) ||
    stringAt(candidate, "role") !== expectedRole ||
    stringAt(candidate, "status") !== "ASSIGNED" ||
    !Number.isSafeInteger(candidate.actor_id) ||
    Number(candidate.actor_id) < 1 ||
    typeof candidate.actor_node_id !== "string" ||
    candidate.actor_node_id.length < 1 ||
    candidate.actor_node_id.length > 256 ||
    typeof candidate.actor_login !== "string" ||
    candidate.actor_login.length < 1 ||
    candidate.actor_login.length > 256 ||
    !canonicalInstant(candidate.effective_from) ||
    !canonicalInstant(candidate.effective_until) ||
    Date.parse(candidate.effective_from) >=
      Date.parse(candidate.effective_until) ||
    !["ACTIVE", "REVOKED"].includes(String(candidate.revocation_status)) ||
    !(
      candidate.superseded_by === null ||
      (typeof candidate.superseded_by === "string" &&
        AUTHORITY_REVISION.test(candidate.superseded_by))
    )
  )
    return false;
  const scope = recordAt(candidate, "scope");
  const evidence = recordAt(candidate, "assignment_evidence");
  return Boolean(
    scope &&
    hasExactKeys(scope, [
      "repository_id",
      "decision_adr",
      "policy_revision",
      "purpose",
    ]) &&
    scope.repository_id === 1291151138 &&
    DECISION_SUBJECT_IDS.includes(
      String(scope.decision_adr) as (typeof DECISION_SUBJECT_IDS)[number],
    ) &&
    typeof scope.policy_revision === "string" &&
    POLICY_REVISION.test(scope.policy_revision) &&
    scope.purpose === AUTHORITY_PURPOSE_BY_ROLE[expectedRole] &&
    evidence &&
    hasExactKeys(evidence, [
      "evidence_kind",
      "assignment_pr_number",
      "assignment_head_sha",
      "observed_at",
      "evidence_sha256",
    ]) &&
    evidence.evidence_kind === "BASE_REGISTRY_ASSIGNMENT" &&
    Number.isSafeInteger(evidence.assignment_pr_number) &&
    Number(evidence.assignment_pr_number) >= 1 &&
    typeof evidence.assignment_head_sha === "string" &&
    GIT_SHA.test(evidence.assignment_head_sha) &&
    canonicalInstant(evidence.observed_at) &&
    typeof evidence.evidence_sha256 === "string" &&
    DIGEST.test(evidence.evidence_sha256),
  );
}

function validatedAuthorityRoles(
  authority: JsonRecord,
): Array<{ role: string; status: "UNASSIGNED" | "ASSIGNED" }> | undefined {
  const revision = stringAt(authority, "revision");
  if (
    !hasExactKeys(authority, [
      "schema_version",
      "repository",
      "revision",
      "actor_policy",
      "roles",
    ]) ||
    stringAt(authority, "schema_version") !==
      APPROVAL_SCHEMA_VERSIONS.authority ||
    !(
      revision === "approval-authorities/initial-unassigned" ||
      AUTHORITY_REVISION.test(revision ?? "")
    ) ||
    stringAt(authority, "actor_policy") !== "DISTINCT_ACTORS_REQUIRED"
  )
    return undefined;
  const repository = recordAt(authority, "repository");
  const candidates = authority.roles;
  if (
    !repository ||
    !hasExactKeys(repository, ["id", "full_name"]) ||
    repository.id !== 1291151138 ||
    stringAt(repository, "full_name") !== "mlhjyx/global-backend" ||
    !Array.isArray(candidates) ||
    candidates.length !== APPROVAL_ROLE_IDS.length
  )
    return undefined;
  const roles: Array<{ role: string; status: "UNASSIGNED" | "ASSIGNED" }> = [];
  const assignedActorIds = new Set<number>();
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (!isRecord(candidate)) return undefined;
    const role = APPROVAL_ROLE_IDS[index];
    const status = stringAt(candidate, "status");
    if (status === "UNASSIGNED") {
      if (
        !hasExactKeys(candidate, ["role", "status"]) ||
        stringAt(candidate, "role") !== role
      )
        return undefined;
      roles.push({ role, status });
      continue;
    }
    if (!assignedAuthorityRole(candidate, role)) return undefined;
    const actorId = Number(candidate.actor_id);
    if (assignedActorIds.has(actorId)) return undefined;
    assignedActorIds.add(actorId);
    roles.push({ role, status: "ASSIGNED" });
  }
  if (
    (roles.some(({ status }) => status === "ASSIGNED") &&
      !AUTHORITY_REVISION.test(revision ?? "")) ||
    (revision === "approval-authorities/initial-unassigned" &&
      roles.some(({ status }) => status !== "UNASSIGNED"))
  )
    return undefined;
  return roles;
}

function schemaContractMatches(
  document: BoundedJson,
  expectedSha256: string,
): boolean {
  return sha256(stableJson(document.value)) === expectedSha256;
}

async function readBoundedJson(file: string): Promise<BoundedJson | undefined> {
  let handle;
  try {
    handle = await open(
      file,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch {
    return undefined;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > APPROVAL_JSON_BYTE_LIMIT)
      return undefined;
    const buffer = Buffer.alloc(APPROVAL_JSON_BYTE_LIMIT + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > APPROVAL_JSON_BYTE_LIMIT) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      buffer.subarray(0, length),
    );
    const value = parseUniqueJson(text);
    return value ? { text, value } : undefined;
  } catch {
    return undefined;
  } finally {
    await handle.close();
  }
}

function schemaVersion(document: BoundedJson): string | undefined {
  const property = recordAt(
    recordAt(document.value, "properties") ?? {},
    "schema_version",
  );
  return stringAt(property ?? {}, "const");
}

function schemaEnum(document: BoundedJson, ...keys: string[]): string[] {
  let cursor: JsonRecord | undefined = document.value;
  for (const key of keys) cursor = cursor ? recordAt(cursor, key) : undefined;
  return stringArrayAt(cursor, "enum");
}

function approvalLocation(
  relative: string,
  document: BoundedJson,
  literal: string,
): SourceLocationV1 {
  const offset = document.text.indexOf(`"${literal}"`);
  return {
    path: relative,
    line: lineOf(document.text, Math.max(0, offset)),
  };
}

function approvalAttributes(
  attributes: Record<string, boolean | number | string | string[] | null> = {},
): Record<string, boolean | number | string | string[] | null> {
  return { ...STATIC_APPROVAL_ATTRIBUTES, ...attributes };
}

function addStaticApprovalEdge(
  builder: GraphBuilder,
  input: {
    from: string;
    to: string;
    relation: string;
    location: SourceLocationV1;
  },
): void {
  builder.addEdge({
    kind: "references",
    from: input.from,
    to: input.to,
    attributes: approvalAttributes({ relation: input.relation }),
    location: input.location,
  });
}

async function extractTrustedApprovalContracts(
  builder: GraphBuilder,
  repositoryRoot: string,
): Promise<void> {
  const paths = {
    authority: "docs/governance/approval-authorities.json",
    receipt: "docs/governance/trusted-approval-readback.schema.json",
    attestation:
      "docs/governance/trusted-approval-evidence-manifest.schema.json",
    verifier:
      "docs/governance/program-c-merge-authorization-consumption.schema.json",
    release: "docs/governance/release-bundle.schema.json",
  } as const;
  const [authority, receipt, attestation, verifier, release] =
    await Promise.all(
      Object.values(paths).map((relative) =>
        readBoundedJson(path.join(repositoryRoot, relative)),
      ),
    );
  if (!authority || !receipt || !attestation || !verifier || !release) return;

  const roles = validatedAuthorityRoles(authority.value);
  const receiptRoles = schemaEnum(
    receipt,
    "$defs",
    "core",
    "properties",
    "role",
  );
  const receiptDecisions = schemaEnum(
    receipt,
    "$defs",
    "core",
    "properties",
    "decision_adr",
  );
  const verifierDecisions = schemaEnum(verifier, "properties", "decision_adr");
  const receiptVersion = schemaVersion(receipt);
  const attestationVersion = schemaVersion(attestation);
  const verifierVersion = schemaVersion(verifier);
  const releaseVersion = schemaVersion(release);
  const attestationProperties = recordAt(attestation.value, "properties") ?? {};
  const verifierProperties = recordAt(verifier.value, "properties") ?? {};
  const verifierDefinition = recordAt(
    recordAt(verifier.value, "$defs") ?? {},
    "verifier",
  );
  if (
    !roles ||
    !schemaContractMatches(receipt, APPROVAL_SCHEMA_CANONICAL_SHA256.receipt) ||
    !schemaContractMatches(
      attestation,
      APPROVAL_SCHEMA_CANONICAL_SHA256.attestation,
    ) ||
    !schemaContractMatches(
      verifier,
      APPROVAL_SCHEMA_CANONICAL_SHA256.verifier,
    ) ||
    !schemaContractMatches(release, APPROVAL_SCHEMA_CANONICAL_SHA256.release) ||
    receiptVersion !== APPROVAL_SCHEMA_VERSIONS.receipt ||
    attestationVersion !== APPROVAL_SCHEMA_VERSIONS.attestation ||
    verifierVersion !== APPROVAL_SCHEMA_VERSIONS.verifier ||
    releaseVersion !== APPROVAL_SCHEMA_VERSIONS.release ||
    !sameOrderedStrings(receiptRoles, APPROVAL_ROLE_IDS) ||
    !sameOrderedStrings(receiptDecisions, DECISION_SUBJECT_IDS) ||
    !sameOrderedStrings(verifierDecisions, DECISION_SUBJECT_IDS) ||
    !recordAt(attestationProperties, "attestation_bundle") ||
    !recordAt(attestationProperties, "trusted_root") ||
    !recordAt(verifierProperties, "independent_verifier") ||
    !verifierDefinition
  )
    return;

  const receiptId = `governance-evidence:${receiptVersion}`;
  const attestationId = `governance-evidence:${attestationVersion}`;
  const verifierId = "governance-verifier:independent-external-workflow";
  const releaseId = `governance-consumer:${releaseVersion}`;
  const receiptLocation = approvalLocation(
    paths.receipt,
    receipt,
    receiptVersion,
  );
  const attestationLocation = approvalLocation(
    paths.attestation,
    attestation,
    attestationVersion,
  );
  const verifierLocation = approvalLocation(
    paths.verifier,
    verifier,
    "verifier",
  );
  const releaseLocation = approvalLocation(
    paths.release,
    release,
    releaseVersion,
  );

  builder.addNode({
    id: receiptId,
    kind: "evidence",
    label: receiptVersion,
    attributes: approvalAttributes({
      contractRole: "TRUSTED_APPROVAL_RECEIPT",
    }),
    location: receiptLocation,
  });
  builder.addNode({
    id: attestationId,
    kind: "evidence",
    label: attestationVersion,
    attributes: approvalAttributes({ contractRole: "ATTESTATION_MANIFEST" }),
    location: attestationLocation,
  });
  builder.addNode({
    id: verifierId,
    kind: "external_system",
    label: "independent external verifier workflow",
    attributes: approvalAttributes({ contractRole: "VERIFIER_WORKFLOW" }),
    location: verifierLocation,
  });
  builder.addNode({
    id: releaseId,
    kind: "evidence",
    label: releaseVersion,
    attributes: approvalAttributes({ contractRole: "RELEASE_CONSUMER" }),
    location: releaseLocation,
  });

  const decisions = [...DECISION_SUBJECT_IDS];
  for (const decision of decisions) {
    const decisionId = `governance:${decision}`;
    const location = approvalLocation(paths.receipt, receipt, decision);
    builder.addNode({
      id: decisionId,
      kind: "decision",
      label: decision,
      attributes: approvalAttributes({ decisionStatus: "HOLD" }),
      location,
    });
    addStaticApprovalEdge(builder, {
      from: decisionId,
      to: receiptId,
      relation: "verified_by",
      location,
    });
    addStaticApprovalEdge(builder, {
      from: receiptId,
      to: decisionId,
      relation: "authorizes_provenance_for",
      location,
    });
  }

  for (const { role, status } of roles) {
    const location = approvalLocation(paths.authority, authority, role);
    const roleId = `governance:${role}`;
    builder.addNode({
      id: roleId,
      kind: "owner",
      label: role,
      attributes: approvalAttributes({
        assignmentStatus: status,
        assignee: status === "UNASSIGNED" ? "UNASSIGNED" : "ASSIGNED_REDACTED",
      }),
      location,
    });
  }
  for (const relationship of AUTHORITY_RELATIONSHIPS) {
    const location = approvalLocation(
      paths.authority,
      authority,
      relationship.role,
    );
    for (const decision of relationship.decisions) {
      addStaticApprovalEdge(builder, {
        from: `governance:${relationship.role}`,
        to: `governance:${decision}`,
        relation: relationship.relation,
        location,
      });
    }
  }

  addStaticApprovalEdge(builder, {
    from: receiptId,
    to: verifierId,
    relation: "attested_by",
    location: verifierLocation,
  });
  addStaticApprovalEdge(builder, {
    from: receiptId,
    to: attestationId,
    relation: "has_attestation_contract",
    location: attestationLocation,
  });
  addStaticApprovalEdge(builder, {
    from: receiptId,
    to: releaseId,
    relation: "authorizes_provenance_for",
    location: releaseLocation,
  });
}

function kindFor(prefix: string): GraphNodeKind {
  switch (prefix) {
    case "CAP":
      return "capability";
    case "SCN":
      return "scenario";
    case "PAGE":
      return "page";
    case "OBJ":
      return "business_object";
    case "OWN":
      return "owner";
    case "DEC":
      return "decision";
    default:
      throw new Error(`unsupported governance prefix ${prefix}`);
  }
}

function addGovernanceNode(
  builder: GraphBuilder,
  id: string,
  location: SourceLocationV1,
): string {
  const prefix = id.split("-", 1)[0];
  return builder.addNode({
    id: `governance:${id}`,
    kind: kindFor(prefix),
    label: id,
    attributes:
      prefix === "OWN"
        ? { accountableRole: id, assignee: "UNASSIGNED" }
        : { registryId: id },
    location,
  });
}

function splitMarkdownRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

export async function extractGovernance(
  builder: GraphBuilder,
  repositoryRoot: string,
): Promise<void> {
  await extractTrustedApprovalContracts(builder, repositoryRoot);
  const governanceRoot = path.join(repositoryRoot, "docs", "governance");
  const files = await walkFiles(governanceRoot, (relative) =>
    relative.endsWith(".md"),
  );
  for (const absolute of files) {
    const text = await readUtf8(absolute);
    const relative = relativePath(repositoryRoot, absolute);
    const fileNode = builder.addNode({
      id: `file:${relative}`,
      kind: "source_file",
      label: relative,
      attributes: { authorityLayer: "registry" },
      location: { path: relative, line: 1 },
    });

    for (const match of text.matchAll(GOVERNANCE_ID)) {
      const id = match[0];
      const location = {
        path: relative,
        line: lineOf(text, match.index ?? 0),
      };
      const node = addGovernanceNode(builder, id, location);
      builder.addEdge({
        kind: "references",
        from: fileNode,
        to: node,
        location,
      });
    }

    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (!line.trimStart().startsWith("|")) continue;
      const ids = [...line.matchAll(GOVERNANCE_ID)].map((match) => match[0]);
      if (ids.length === 0) continue;
      const location = { path: relative, line: index + 1 };
      const primary = addGovernanceNode(builder, ids[0], location);
      for (const referencedId of ids.slice(1)) {
        if (referencedId === ids[0]) continue;
        const referenced = addGovernanceNode(builder, referencedId, location);
        const prefix = referencedId.split("-", 1)[0];
        if (prefix === "OWN") {
          builder.addEdge({
            kind: "owns",
            from: referenced,
            to: primary,
            location,
          });
        } else if (
          ids[0].startsWith("CAP-") &&
          referencedId.startsWith("CAP-")
        ) {
          builder.addEdge({
            kind: "depends_on",
            from: primary,
            to: referenced,
            attributes: { relation: "parent-or-related-capability" },
            location,
          });
        } else {
          builder.addEdge({
            kind: "references",
            from: primary,
            to: referenced,
            location,
          });
        }
      }

      const cells = splitMarkdownRow(line);
      if (ids[0].startsWith("OWN-") && cells.length >= 3) {
        builder.addNode({
          id: `governance:${ids[0]}`,
          kind: "owner",
          label: ids[0],
          attributes: {
            roleLabel: cells[1]?.replaceAll("`", "") ?? ids[0],
            assignmentStatus: cells[2]?.replaceAll("`", "") ?? "UNKNOWN",
            assignee: "UNASSIGNED",
          },
          location,
        });
      }
      if (ids[0].startsWith("CAP-") && cells.length >= 2) {
        const outcomeCell =
          /^`?CAP-/.test(cells[1] ?? "") && cells.length >= 3
            ? cells[2]
            : cells[1];
        const productStatus = cells
          .map((cell) => cell.replaceAll("`", ""))
          .map(
            (cell) =>
              /\b(APPROVED_NOT_BUILT|APPROVED_WITH_CONDITION|APPROVED|DEFERRED(?:\/PROPOSED)?|PROPOSED\/EXTERNAL_OWNED|UNKNOWN\/EXTERNAL_OWNED)\b/.exec(
                cell,
              )?.[1],
          )
          .find((value) => value !== undefined);
        builder.addNode({
          id: `governance:${ids[0]}`,
          kind: "capability",
          label: ids[0],
          attributes: {
            userOutcome: outcomeCell?.replaceAll("`", "").slice(0, 500) ?? "",
            productStatus: productStatus ?? "UNKNOWN",
          },
          location,
        });
      }
      if (ids[0].startsWith("OBJ-BLK-") && cells.length >= 3) {
        builder.addNode({
          id: `governance:${ids[0]}`,
          kind: "business_object",
          label: ids[0],
          attributes: {
            boundaryStatus: "OPEN_EXTERNAL_OWNERSHIP_BLOCKER",
            missingBoundary: cells[1]?.replaceAll("`", "").slice(0, 500) ?? "",
            blockedScope: cells[2]?.replaceAll("`", "").slice(0, 500) ?? "",
          },
          location,
        });
      }
      if (ids[0].startsWith("SCN-") && cells.length >= 2) {
        builder.addNode({
          id: `governance:${ids[0]}`,
          kind: "scenario",
          label: ids[0],
          attributes: {
            scenario: cells[1]?.replaceAll("`", "").slice(0, 500) ?? "",
          },
          location,
        });
      }
      if (line.includes("EXTERNAL_OWNED") || line.includes("UNKNOWN")) {
        builder.addDiagnostic({
          code: line.includes("EXTERNAL_OWNED")
            ? "EXTERNAL_OWNED"
            : "UNKNOWN_RELATION",
          severity: "info",
          message: `${ids[0]} contains an explicit non-local or unknown boundary`,
          nodeId: primary,
          location,
        });
      }
    }
  }
}
