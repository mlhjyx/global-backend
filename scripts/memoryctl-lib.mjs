import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  constants,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  lstat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GRAPH_SCHEMA = "memoryctl-graph/v1";
export const CANDIDATE_SCHEMA = "memoryctl-candidate/v1";
const MAX_GRAPH_BYTES = 2 * 1024 * 1024;
const MAX_OBSERVATION_BYTES = 2 * 1024;
const MAX_ENTITIES = 1000;
const MAX_RELATIONS = 4000;
const WRITE_TOOL_NAMES = [
  "create_entities",
  "create_relations",
  "add_observations",
  "delete_entities",
  "delete_observations",
  "delete_relations",
];
const READ_TOOL_NAMES = ["read_graph", "search_nodes", "open_nodes"];

export class MemoryCtlError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "MemoryCtlError";
    this.code = code;
    this.details = details;
  }
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function canonicalJson(value) {
  if (value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assert(condition, code, message, details) {
  if (!condition) throw new MemoryCtlError(code, message, details);
}

function isIsoDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function scanString(value, field) {
  const normalized = value.normalize("NFKC");
  const detectors = [
    ["PEM_PRIVATE_KEY", /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/i],
    ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/],
    ["CREDENTIAL_URL", /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i],
    ["GITHUB_TOKEN", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/],
    ["OPENAI_KEY", /\bsk-[A-Za-z0-9_-]{20,}\b/],
    ["AWS_KEY", /\bAKIA[0-9A-Z]{16}\b/],
    ["EMAIL", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ["PHONE", /(?<!\d)(?:\+?\d[\s().-]?){8,}\d(?!\d)/],
  ];
  for (const [detector, pattern] of detectors) {
    if (pattern.test(normalized)) {
      throw new MemoryCtlError("SENSITIVE_CONTENT", "candidate contains blocked sensitive content", {
        detector,
        field,
      });
    }
  }
}

function scanValue(value, field = "$") {
  if (typeof value === "string") return scanString(value, field);
  if (Array.isArray(value)) return value.forEach((item, index) => scanValue(item, `${field}[${index}]`));
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (key === "personalData" && item === true) {
        throw new MemoryCtlError("SENSITIVE_CONTENT", "candidate declares personal data", { field });
      }
      scanValue(item, `${field}.${key}`);
    }
  }
}

function normalizeEntity(entity) {
  assert(entity && typeof entity === "object", "CANDIDATE_ENTITY", "candidate requires an entity");
  assert(typeof entity.name === "string" && entity.name.length > 0, "CANDIDATE_ENTITY", "entity.name is required");
  assert(typeof entity.entityType === "string" && entity.entityType.length > 0, "CANDIDATE_ENTITY", "entity.entityType is required");
  return { name: entity.name, entityType: entity.entityType };
}

export function validateCandidate(candidate) {
  assert(candidate && typeof candidate === "object", "CANDIDATE_INVALID", "candidate must be an object");
  assert(candidate.schemaVersion === CANDIDATE_SCHEMA, "CANDIDATE_SCHEMA", "unsupported candidate schema");
  assert(typeof candidate.id === "string" && /^[a-z0-9][a-z0-9-]{7,127}$/.test(candidate.id), "CANDIDATE_ID", "invalid candidate id");
  assert(typeof candidate.project === "string" && candidate.project.length > 0, "CANDIDATE_PROJECT", "project is required");
  assert(["inbox", "reviewed"].includes(candidate.status), "CANDIDATE_STATUS", "candidate status must be inbox or reviewed");
  assert(["merged_pr", "user_decision", "verified_operation", "lesson", "research", "navigation", "proposal", "inference"].includes(candidate.kind), "CANDIDATE_KIND", "unsupported candidate kind");
  assert(["derived", "approved_reference", "external", "unverified"].includes(candidate.authority), "CANDIDATE_AUTHORITY", "unsupported candidate authority");
  const entity = normalizeEntity(candidate.entity);
  assert(Array.isArray(candidate.observations) && candidate.observations.length > 0, "CANDIDATE_OBSERVATIONS", "candidate requires observations");
  for (const observation of candidate.observations) {
    assert(typeof observation === "string" && Buffer.byteLength(observation) <= MAX_OBSERVATION_BYTES, "CANDIDATE_OBSERVATION", "invalid or oversized observation");
  }
  assert(candidate.source && typeof candidate.source === "object", "CANDIDATE_SOURCE", "candidate requires a source receipt");
  assert(typeof candidate.source.kind === "string" && typeof candidate.source.reference === "string", "CANDIDATE_SOURCE", "source kind and reference are required");
  if (["merged_pr", "verified_operation"].includes(candidate.kind)) {
    assert(typeof candidate.sourceCommit === "string" && /^[0-9a-f]{40}$/.test(candidate.sourceCommit), "CANDIDATE_SOURCE_COMMIT", "automatic candidates require a full sourceCommit");
  }
  if (candidate.kind === "user_decision") {
    const approval = candidate.approval;
    assert(approval && approval.kind === "user_explicit", "CANDIDATE_APPROVAL", "user decision requires an explicit approval receipt");
    assert(typeof approval.reference === "string" && approval.reference.length > 0, "CANDIDATE_APPROVAL", "approval reference is required");
    assert(typeof approval.approvedBy === "string" && approval.approvedBy.length > 0, "CANDIDATE_APPROVAL", "approval approver is required");
    assert(isIsoDate(approval.approvedAt), "CANDIDATE_APPROVAL", "approval timestamp must be an ISO date");
    assert(typeof approval.statementHash === "string" && /^[0-9a-f]{64}$/.test(approval.statementHash), "CANDIDATE_APPROVAL", "approval requires a statement hash");
  }
  assert(isIsoDate(candidate.validAsOf), "CANDIDATE_DATE", "validAsOf must be an ISO date");
  assert(isIsoDate(candidate.reviewAfter), "CANDIDATE_DATE", "reviewAfter must be an ISO date");
  assert(typeof candidate.owner === "string" && candidate.owner.startsWith("OWN-"), "CANDIDATE_OWNER", "owner must be an existing Owner ID");
  const relations = candidate.relations ?? [];
  assert(Array.isArray(relations), "CANDIDATE_RELATIONS", "relations must be an array");
  for (const relation of relations) {
    assert(relation && typeof relation.from === "string" && typeof relation.to === "string" && typeof relation.relationType === "string", "CANDIDATE_RELATION", "invalid relation");
  }
  const supersedes = candidate.supersedes ?? [];
  assert(Array.isArray(supersedes) && supersedes.every((item) => typeof item === "string"), "CANDIDATE_SUPERSEDES", "supersedes must be an array of entity names");
  scanValue(candidate);
  return { ...candidate, entity, relations, supersedes };
}

export function parseGraphText(text) {
  assert(Buffer.byteLength(text) <= MAX_GRAPH_BYTES, "GRAPH_TOO_LARGE", "memory graph exceeds the configured size limit");
  const entities = [];
  const relations = [];
  const names = new Set();
  const relationKeys = new Set();
  const lines = text.length === 0 ? [] : text.split("\n").filter(Boolean);
  for (const [index, line] of lines.entries()) {
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      throw new MemoryCtlError("GRAPH_JSON", "memory graph has invalid JSONL", { line: index + 1 });
    }
    if (item.type === "entity") {
      assert(typeof item.name === "string" && typeof item.entityType === "string" && Array.isArray(item.observations), "GRAPH_ENTITY", "invalid entity", { line: index + 1 });
      assert(!names.has(item.name), "GRAPH_DUPLICATE_ENTITY", "duplicate entity name", { name: item.name });
      item.observations.forEach((observation) => assert(typeof observation === "string" && Buffer.byteLength(observation) <= MAX_OBSERVATION_BYTES, "GRAPH_OBSERVATION", "invalid observation", { name: item.name }));
      names.add(item.name);
      entities.push({ name: item.name, entityType: item.entityType, observations: item.observations });
    } else if (item.type === "relation") {
      assert(typeof item.from === "string" && typeof item.to === "string" && typeof item.relationType === "string", "GRAPH_RELATION", "invalid relation", { line: index + 1 });
      const key = `${item.from}\u0000${item.to}\u0000${item.relationType}`;
      assert(!relationKeys.has(key), "GRAPH_DUPLICATE_RELATION", "duplicate relation", { key });
      relationKeys.add(key);
      relations.push({ from: item.from, to: item.to, relationType: item.relationType });
    } else {
      throw new MemoryCtlError("GRAPH_TYPE", "memory graph contains an unknown record type", { line: index + 1 });
    }
  }
  assert(entities.length <= MAX_ENTITIES && relations.length <= MAX_RELATIONS, "GRAPH_LIMIT", "memory graph exceeds entity or relation limits");
  for (const relation of relations) {
    assert(names.has(relation.from) && names.has(relation.to), "GRAPH_DANGLING_RELATION", "memory graph contains a dangling relation", relation);
  }
  return { entities, relations };
}

export function serializeGraph(graph) {
  const entities = [...graph.entities]
    .map((entity) => ({ ...entity, observations: [...new Set(entity.observations)].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const relations = [...graph.relations].sort((a, b) => `${a.from}\u0000${a.to}\u0000${a.relationType}`.localeCompare(`${b.from}\u0000${b.to}\u0000${b.relationType}`));
  return [...entities.map((entity) => JSON.stringify({ type: "entity", ...entity })), ...relations.map((relation) => JSON.stringify({ type: "relation", ...relation }))].join("\n");
}

export function mergeCandidate(graph, candidate) {
  const next = { entities: graph.entities.map((entity) => ({ ...entity, observations: [...entity.observations] })), relations: graph.relations.map((relation) => ({ ...relation })) };
  const subject = next.entities.find((entity) => entity.name === candidate.entity.name);
  if (subject) {
    assert(subject.entityType === candidate.entity.entityType, "ENTITY_TYPE_CONFLICT", "existing entity has a different type", { name: subject.name });
    subject.observations.push(...candidate.observations);
  } else {
    next.entities.push({ ...candidate.entity, observations: [...candidate.observations] });
  }
  const receiptName = `memory_fact_v1:${candidate.id}`;
  const receipt = {
    name: receiptName,
    entityType: "memory_fact_v1",
    observations: [canonicalJson({
      authority: candidate.authority,
      candidateHash: sha256(canonicalJson(candidate)),
      approval: candidate.approval ?? null,
      kind: candidate.kind,
      owner: candidate.owner,
      project: candidate.project,
      reviewAfter: candidate.reviewAfter,
      source: candidate.source,
      sourceCommit: candidate.sourceCommit ?? null,
      validAsOf: candidate.validAsOf,
    })],
  };
  const existingReceipt = next.entities.find((entity) => entity.name === receiptName);
  if (existingReceipt) {
    assert(existingReceipt.observations.includes(receipt.observations[0]), "CANDIDATE_ID_CONFLICT", "candidate id already exists with different content", { id: candidate.id });
  } else {
    next.entities.push(receipt);
  }
  const relations = [
    { from: receiptName, to: candidate.entity.name, relationType: "documents" },
    ...candidate.relations,
    ...candidate.supersedes.map((oldName) => ({ from: receiptName, to: oldName, relationType: "supersedes" })),
  ];
  const known = new Set(next.entities.map((entity) => entity.name));
  for (const relation of relations) {
    assert(known.has(relation.from) && known.has(relation.to), "CANDIDATE_DANGLING_RELATION", "candidate relation references an unknown entity", relation);
    if (!next.relations.some((item) => item.from === relation.from && item.to === relation.to && item.relationType === relation.relationType)) next.relations.push(relation);
  }
  parseGraphText(serializeGraph(next));
  return next;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await securePathStatus(path, "directory", false);
}

async function readRegularFile(path, allowMissing = false) {
  try {
    const info = await lstat(path);
    assert(info.isFile(), "UNSAFE_PATH", "path must be a regular file", { path });
    return await readFile(path, "utf8");
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return "";
    throw error;
  }
}

async function securePathStatus(path, kind, allowMissing = true) {
  try {
    const info = await lstat(path);
    assert(!info.isSymbolicLink(), "UNSAFE_PATH", "managed memory path cannot be a symbolic link", { path, kind });
    assert(kind === "directory" ? info.isDirectory() : info.isFile(), "UNSAFE_PATH", "managed memory path has an unexpected type", { path, kind });
    assert((info.mode & 0o077) === 0, "INSECURE_PERMISSIONS", "managed memory path is readable or writable by group or others", { path, mode: (info.mode & 0o777).toString(8) });
    assert(info.uid === process.getuid?.(), "INSECURE_OWNERSHIP", "managed memory path is not owned by the current user", { path, uid: info.uid });
    return { exists: true, mode: info.mode & 0o777 };
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function assertCandidateIsInInbox(candidatePath, inboxDir) {
  const candidateInfo = await lstat(candidatePath);
  assert(candidateInfo.isFile() && candidateInfo.nlink === 1, "UNSAFE_CANDIDATE", "candidate must be a regular non-linked file", { candidatePath });
  assert((candidateInfo.mode & 0o077) === 0, "INSECURE_PERMISSIONS", "candidate is readable or writable by group or others", { candidatePath, mode: (candidateInfo.mode & 0o777).toString(8) });
  assert(candidateInfo.uid === process.getuid?.(), "INSECURE_OWNERSHIP", "candidate is not owned by the current user", { candidatePath, uid: candidateInfo.uid });
  const inboxRoot = await realpath(inboxDir);
  const realCandidate = await realpath(candidatePath);
  const pathFromInbox = relative(inboxRoot, realCandidate);
  assert(pathFromInbox && !pathFromInbox.startsWith(".."), "UNSAFE_CANDIDATE", "candidate must be in the configured Inbox", { candidatePath, inboxDir });
}

async function assertSecureGraphWritePaths(paths, { audit = false, backup = false, inbox = false } = {}) {
  await securePathStatus(paths.graphDir, "directory", false);
  await securePathStatus(paths.graphPath, "file");
  await securePathStatus(paths.lockPath, "file");
  await securePathStatus(paths.journalPath, "file");
  if (audit) await securePathStatus(paths.auditDir, "directory", false);
  if (backup) await securePathStatus(paths.backupDir, "directory", false);
  if (inbox) await securePathStatus(paths.inboxDir, "directory", false);
}

async function fsyncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeDurable(path, content, flags = "w") {
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function createBackup(paths, content) {
  await ensurePrivateDirectory(paths.backupDir);
  const hash = sha256(content);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(paths.backupDir, `knowledge-graph-${stamp}-${hash}-${randomUUID()}.jsonl`);
  await writeDurable(backupPath, content, "wx");
  await writeDurable(`${backupPath}.manifest.json`, `${canonicalJson({ hash, path: paths.graphPath, schema: GRAPH_SCHEMA, size: Buffer.byteLength(content) })}\n`, "wx");
  return backupPath;
}

async function replaceGraphAtomically(paths, content, journal) {
  const tempPath = join(paths.graphDir, `.${journal.candidateId ?? "restore"}.${randomUUID()}.tmp`);
  await writeDurable(paths.journalPath, `${canonicalJson({ ...journal, state: "prepared" })}\n`, "w");
  await writeDurable(tempPath, content, "wx");
  await rename(tempPath, paths.graphPath);
  await fsyncDirectory(paths.graphDir);
  const written = await readRegularFile(paths.graphPath);
  assert(sha256(written) === sha256(content), "POST_WRITE_HASH", "memory graph verification failed after atomic replacement");
  parseGraphText(written);
}

async function acquireLock(lockPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  while (true) {
    try {
      await writeDurable(lockPath, canonicalJson({ token, pid: process.pid, createdAt: new Date().toISOString() }), "wx");
      return async () => {
        const current = await readRegularFile(lockPath, true);
        if (current) {
          const value = JSON.parse(current);
          assert(value.token === token, "LOCK_OWNERSHIP", "lock ownership changed before release");
          await unlink(lockPath);
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new MemoryCtlError("LOCK_TIMEOUT", "memory graph is busy; lock was not taken");
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
  }
}

function defaultPaths(options) {
  const graphPath = resolve(options.graphPath);
  const graphDir = dirname(graphPath);
  return {
    graphPath,
    graphDir,
    lockPath: `${graphPath}.lock`,
    journalPath: `${graphPath}.journal`,
    inboxDir: resolve(options.inboxDir ?? join(graphDir, "inbox")),
    auditDir: resolve(options.auditDir ?? join(graphDir, "audit")),
    backupDir: resolve(options.backupDir ?? "/data/codex-memory/backups"),
  };
}

export async function createCandidate(input, options) {
  const paths = defaultPaths(options);
  const candidate = validateCandidate({ ...input, schemaVersion: CANDIDATE_SCHEMA });
  await ensurePrivateDirectory(paths.inboxDir);
  await assertSecureGraphWritePaths(paths, { inbox: true });
  const path = join(paths.inboxDir, `${candidate.id}.json`);
  const content = `${canonicalJson(candidate)}\n`;
  try {
    await writeDurable(path, content, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readRegularFile(path);
    assert(existing === content, "CANDIDATE_ID_CONFLICT", "candidate id already exists with different content", { id: candidate.id });
  }
  return { candidatePath: path, candidateHash: sha256(canonicalJson(candidate)) };
}

export async function verifyGraph(options) {
  const paths = defaultPaths(options);
  const pathSecurity = {
    auditDir: await securePathStatus(paths.auditDir, "directory"),
    backupDir: await securePathStatus(paths.backupDir, "directory"),
    graph: await securePathStatus(paths.graphPath, "file"),
    graphDir: await securePathStatus(paths.graphDir, "directory", false),
    inboxDir: await securePathStatus(paths.inboxDir, "directory"),
  };
  const text = await readRegularFile(paths.graphPath, true);
  const graph = parseGraphText(text);
  const journal = await readRegularFile(paths.journalPath, true);
  let latestAudit = null;
  try {
    const names = await readdir(paths.auditDir);
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const audit = JSON.parse(await readRegularFile(join(paths.auditDir, name)));
      if (!latestAudit || audit.promotedAt > latestAudit.promotedAt) latestAudit = audit;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const graphHash = sha256(text);
  return {
    graphHash,
    graphPath: paths.graphPath,
    entityCount: graph.entities.length,
    journalPresent: Boolean(journal),
    lastPublishedGraphHash: latestAudit?.graphHash ?? null,
    relationCount: graph.relations.length,
    pathSecurity,
    untrackedDrift: latestAudit ? latestAudit.graphHash !== graphHash : null,
    writeToolsBlocked: WRITE_TOOL_NAMES,
    readToolsRequired: READ_TOOL_NAMES,
  };
}

export async function backupGraph(options) {
  const paths = defaultPaths(options);
  await ensurePrivateDirectory(paths.backupDir);
  await assertSecureGraphWritePaths(paths, { backup: true });
  const content = await readRegularFile(paths.graphPath, true);
  parseGraphText(content);
  return { backupPath: await createBackup(paths, content), graphHash: sha256(content) };
}

export async function restoreGraph(backupPath, options) {
  const paths = defaultPaths(options);
  await ensurePrivateDirectory(paths.backupDir);
  await assertSecureGraphWritePaths(paths, { backup: true });
  const backupRoot = await realpath(paths.backupDir);
  const resolvedBackup = resolve(backupPath);
  const backupInfo = await lstat(resolvedBackup);
  assert(backupInfo.isFile() && backupInfo.nlink === 1, "UNSAFE_BACKUP", "backup must be a regular non-linked file");
  const realBackup = await realpath(resolvedBackup);
  assert(relative(backupRoot, realBackup) && !relative(backupRoot, realBackup).startsWith(".."), "UNSAFE_BACKUP", "backup must be inside the configured backup directory");
  const content = await readRegularFile(realBackup);
  parseGraphText(content);
  const manifest = JSON.parse(await readRegularFile(`${realBackup}.manifest.json`));
  assert(manifest.hash === sha256(content), "BACKUP_HASH", "backup manifest hash does not match its content");
  const release = await acquireLock(paths.lockPath, options.lockTimeoutMs);
  try {
    const before = await readRegularFile(paths.graphPath, true);
    const beforeHash = sha256(before);
    assert(options.expectedGraphHash === beforeHash, "GRAPH_HASH", "memory graph changed before restore", { expected: options.expectedGraphHash, actual: beforeHash });
    const currentBackupPath = await createBackup(paths, before);
    await replaceGraphAtomically(paths, content, { candidateId: "restore", newHash: sha256(content), oldHash: beforeHash, restoreFrom: realBackup });
    await unlink(paths.journalPath);
    return { backupPath: currentBackupPath, graphHash: sha256(content), restoredFrom: realBackup };
  } finally {
    await release();
  }
}

async function verifyMergedPr(candidate, options) {
  const source = candidate.source;
  assert(typeof source.repository === "string" && /^[^/\s]+\/[^/\s]+$/.test(source.repository), "PROMOTION_PENDING", "merged PR receipt requires an owner/repository");
  assert(Number.isInteger(source.prNumber) && source.prNumber > 0, "PROMOTION_PENDING", "merged PR receipt requires a PR number");
  assert(source.baseRef === "main", "PROMOTION_PENDING", "automatic promotion only permits PRs merged to main");
  assert(source.mergeSha === candidate.sourceCommit, "PROMOTION_PENDING", "merged PR receipt must bind mergeSha to sourceCommit");
  const expectedReference = `https://github.com/${source.repository}/pull/${source.prNumber}`;
  const expectedEntityName = `merged_pr:${source.repository}#${source.prNumber}@${candidate.sourceCommit}`;
  const expectedObservation = canonicalJson({ baseRef: "main", mergeSha: candidate.sourceCommit, prNumber: source.prNumber, repository: source.repository });
  assert(Object.keys(source).sort().join(",") === "baseRef,kind,mergeSha,prNumber,reference,repository", "PROMOTION_PENDING", "merged PR receipt contains unverified source fields");
  assert(source.kind === "merged_pr" && source.reference === expectedReference, "PROMOTION_PENDING", "merged PR receipt source is not canonical");
  assert(candidate.authority === "derived", "PROMOTION_PENDING", "automatic merged PR receipt must be derived");
  assert(candidate.entity.name === expectedEntityName && candidate.entity.entityType === "merged_pr", "PROMOTION_PENDING", "automatic promotion may only record the verified PR receipt");
  assert(candidate.observations.length === 1 && candidate.observations[0] === expectedObservation, "PROMOTION_PENDING", "automatic promotion may only record verified PR metadata");
  assert(candidate.relations.length === 0 && candidate.supersedes.length === 0, "PROMOTION_PENDING", "automatic merged PR receipt cannot create relationships");
  if (options.verifyMergedPr) {
    await options.verifyMergedPr(candidate);
    return;
  }
  try {
    const { stdout: remote } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: candidate.project });
    const normalizedRemote = remote.trim().replace(/^git@github\.com:/, "https://github.com/").replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "");
    assert(normalizedRemote === source.repository, "PROMOTION_PENDING", "merged PR repository does not match the candidate project origin");
    await execFileAsync("git", ["merge-base", "--is-ancestor", candidate.sourceCommit, "origin/main"], { cwd: candidate.project });
    const { stdout } = await execFileAsync("gh", ["pr", "view", String(source.prNumber), "--repo", source.repository, "--json", "state,baseRefName,mergeCommit"]);
    const pr = JSON.parse(stdout);
    assert(pr.state === "MERGED", "PROMOTION_PENDING", "PR is not merged");
    assert(pr.baseRefName === "main", "PROMOTION_PENDING", "PR was not merged to main");
    assert(pr.mergeCommit?.oid === candidate.sourceCommit, "PROMOTION_PENDING", "PR merge commit does not match sourceCommit");
  } catch (error) {
    if (error instanceof MemoryCtlError) throw error;
    throw new MemoryCtlError("PROMOTION_PENDING", "could not mechanically verify the merged PR; keep the candidate in Inbox", { cause: error?.message });
  }
}

async function validatePromotion(candidate, options) {
  if (candidate.kind === "merged_pr") {
    await verifyMergedPr(candidate, options);
  } else if (candidate.kind === "verified_operation") {
    throw new MemoryCtlError("PROMOTION_PENDING", "verified operations require a future allowlisted verifier; keep the candidate in Inbox");
  } else if (candidate.kind === "user_decision") {
    // This receipt records an explicit human approval; local tooling cannot attest to a chat identity.
    assert(candidate.approval?.kind === "user_explicit", "PROMOTION_PENDING", "candidate requires a structured explicit user approval");
  } else {
    throw new MemoryCtlError("PROMOTION_PENDING", "only a verified merged PR or structured user decision can be promoted in v1");
  }
  assert(options.expectedCandidateHash === sha256(canonicalJson(candidate)), "CANDIDATE_HASH", "candidate hash changed or was not supplied");
}

export async function promoteCandidate(candidatePath, options) {
  const paths = defaultPaths(options);
  await Promise.all([ensurePrivateDirectory(paths.auditDir), ensurePrivateDirectory(paths.backupDir), ensurePrivateDirectory(paths.inboxDir)]);
  const resolvedCandidatePath = resolve(candidatePath);
  await assertSecureGraphWritePaths(paths, { audit: true, backup: true, inbox: true });
  await assertCandidateIsInInbox(resolvedCandidatePath, paths.inboxDir);
  const candidate = validateCandidate(JSON.parse(await readRegularFile(resolvedCandidatePath)));
  await validatePromotion(candidate, options);
  const release = await acquireLock(paths.lockPath, options.lockTimeoutMs);
  try {
    const before = await readRegularFile(paths.graphPath, true);
    const beforeHash = sha256(before);
    assert(options.expectedGraphHash === beforeHash, "GRAPH_HASH", "memory graph changed since the candidate was prepared", { expected: options.expectedGraphHash, actual: beforeHash });
    const graph = parseGraphText(before);
    const next = mergeCandidate(graph, candidate);
    const after = serializeGraph(next);
    const afterHash = sha256(after);
    if (after === before) return { changed: false, graphHash: beforeHash };
    const backupPath = await createBackup(paths, before);
    await replaceGraphAtomically(paths, after, { candidateId: candidate.id, newHash: afterHash, oldHash: beforeHash });
    const audit = {
      approval: candidate.approval ?? null,
      candidateHash: options.expectedCandidateHash,
      candidateId: candidate.id,
      graphHash: afterHash,
      previousGraphHash: beforeHash,
      promotedAt: new Date().toISOString(),
      sourceCommit: candidate.sourceCommit ?? null,
    };
    await writeDurable(join(paths.auditDir, `${candidate.id}.json`), `${canonicalJson(audit)}\n`, "wx");
    await unlink(paths.journalPath);
    return { changed: true, graphHash: afterHash, backupPath };
  } finally {
    await release();
  }
}
