import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFile,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
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
  assert(["merged_pr", "user_decision", "verified_operation", "lesson", "research", "navigation", "proposal", "inference"].includes(candidate.kind), "CANDIDATE_KIND", "unsupported candidate kind");
  assert(["derived", "approved_reference", "external", "unverified"].includes(candidate.authority), "CANDIDATE_AUTHORITY", "unsupported candidate authority");
  const entity = normalizeEntity(candidate.entity);
  assert(Array.isArray(candidate.observations) && candidate.observations.length > 0, "CANDIDATE_OBSERVATIONS", "candidate requires observations");
  for (const observation of candidate.observations) {
    assert(typeof observation === "string" && Buffer.byteLength(observation) <= MAX_OBSERVATION_BYTES, "CANDIDATE_OBSERVATION", "invalid or oversized observation");
  }
  assert(candidate.source && typeof candidate.source === "object", "CANDIDATE_SOURCE", "candidate requires a source receipt");
  assert(typeof candidate.source.kind === "string" && typeof candidate.source.reference === "string", "CANDIDATE_SOURCE", "source kind and reference are required");
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
      kind: candidate.kind,
      owner: candidate.owner,
      project: candidate.project,
      reviewAfter: candidate.reviewAfter,
      source: candidate.source,
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
  await (await open(path, constants.O_RDONLY)).close();
}

async function readRegularFile(path, allowMissing = false) {
  try {
    const info = await stat(path);
    assert(info.isFile(), "UNSAFE_PATH", "path must be a regular file", { path });
    return await readFile(path, "utf8");
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return "";
    throw error;
  }
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
    untrackedDrift: latestAudit ? latestAudit.graphHash !== graphHash : null,
    writeToolsBlocked: WRITE_TOOL_NAMES,
    readToolsRequired: READ_TOOL_NAMES,
  };
}

export async function backupGraph(options) {
  const paths = defaultPaths(options);
  const content = await readRegularFile(paths.graphPath, true);
  parseGraphText(content);
  return { backupPath: await createBackup(paths, content), graphHash: sha256(content) };
}

export async function restoreGraph(backupPath, options) {
  const paths = defaultPaths(options);
  await ensurePrivateDirectory(paths.backupDir);
  const backupRoot = await realpath(paths.backupDir);
  const resolvedBackup = resolve(backupPath);
  const backupInfo = await stat(resolvedBackup);
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

function validatePromotion(candidate, options) {
  const automaticKinds = new Set(["merged_pr", "verified_operation"]);
  if (automaticKinds.has(candidate.kind)) {
    assert(candidate.source.mechanicallyVerified === true, "PROMOTION_PENDING", "automatic promotion needs a mechanical source receipt");
  } else {
    assert(candidate.approval?.kind === "user_explicit" && typeof candidate.approval.reference === "string", "PROMOTION_PENDING", "candidate requires a structured explicit user approval");
  }
  assert(options.expectedCandidateHash === sha256(canonicalJson(candidate)), "CANDIDATE_HASH", "candidate hash changed or was not supplied");
}

export async function promoteCandidate(candidatePath, options) {
  const paths = defaultPaths(options);
  const candidate = validateCandidate(JSON.parse(await readRegularFile(resolve(candidatePath))));
  validatePromotion(candidate, options);
  await Promise.all([ensurePrivateDirectory(paths.auditDir), ensurePrivateDirectory(paths.backupDir)]);
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
      candidateHash: options.expectedCandidateHash,
      candidateId: candidate.id,
      graphHash: afterHash,
      previousGraphHash: beforeHash,
      promotedAt: new Date().toISOString(),
    };
    await writeDurable(join(paths.auditDir, `${candidate.id}.json`), `${canonicalJson(audit)}\n`, "wx");
    await unlink(paths.journalPath);
    return { changed: true, graphHash: afterHash, backupPath };
  } finally {
    await release();
  }
}
