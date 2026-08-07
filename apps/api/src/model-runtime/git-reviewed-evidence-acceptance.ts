import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION =
  "git-reviewed-evidence-acceptance/2026-08-07-v1" as const;

const CLASSIFICATION = "GIT_REVIEWED_CREATE_ONLY_ACCEPTANCE" as const;
const DECISION = "ACCEPT" as const;
const HANDLE_CLASSIFICATION =
  "OPAQUE_GIT_REVIEWED_EVIDENCE_ACCEPTANCE" as const;
const MAXIMUM_ARTIFACT_BYTES = 2 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;
const GIT_COMMIT = /^[0-9a-f]{40}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{2,191}$/u;
const PR_MERGE_SUBJECT = /^Merge pull request #([1-9][0-9]*) from /u;
const EXEC_FILE_SYNC = execFileSync;
const SPAWN_SYNC = spawnSync;
const CREATE_HASH = createHash;
const LSTAT = lstat;
const OPEN = open;
const REALPATH = realpath;
const IS_ABSOLUTE = isAbsolute;
const PATH_RELATIVE = relative;
const PATH_RESOLVE = resolve;
const PATH_SEPARATOR = sep;
const FS_OPEN_READ_ONLY_NO_FOLLOW = constants.O_RDONLY | constants.O_NOFOLLOW;
const FS_OPEN_CREATE_ONLY =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_NOFOLLOW;
const FREEZE_OBJECT = Object.freeze.bind(Object);
const OBJECT_KEYS = Object.keys.bind(Object);
const OBJECT_VALUES = Object.values.bind(Object);
const OBJECT_GET_PROTOTYPE = Object.getPrototypeOf.bind(Object);
const OBJECT_PROTOTYPE = Object.prototype;
const ARRAY_IS_ARRAY = Array.isArray.bind(Array);
const ARRAY_PUSH = Function.call.bind(Array.prototype.push) as <T>(
  value: T[],
  item: T,
) => number;
const ARRAY_JOIN = Function.call.bind(Array.prototype.join) as (
  value: readonly unknown[],
  separator: string,
) => string;
const ARRAY_SORT = Function.call.bind(Array.prototype.sort) as <T>(
  value: T[],
  compare?: (left: T, right: T) => number,
) => T[];
const STRING_SPLIT = Function.call.bind(String.prototype.split) as (
  value: string,
  separator: string | RegExp,
) => string[];
const STRING_REPLACE_ALL = Function.call.bind(String.prototype.replaceAll) as (
  value: string,
  search: string | RegExp,
  replacement: string,
) => string;
const STRING_INCLUDES = Function.call.bind(String.prototype.includes) as (
  value: string,
  search: string,
) => boolean;
const STRING_TRIM = Function.call.bind(String.prototype.trim) as (
  value: string,
) => string;
const JSON_PARSE = JSON.parse.bind(JSON);
const JSON_STRINGIFY = JSON.stringify.bind(JSON);
const STRUCTURED_CLONE = structuredClone;
const BUFFER_EQUALS = Function.call.bind(Buffer.prototype.equals) as (
  value: Buffer,
  other: Uint8Array,
) => boolean;
const BUFFER_TO_STRING = Function.call.bind(Buffer.prototype.toString) as (
  value: Buffer,
  encoding: BufferEncoding,
) => string;
const BUFFER_IS_BUFFER = Buffer.isBuffer.bind(Buffer);
const SHA256_TEST = SHA256.test.bind(SHA256);
const GIT_COMMIT_TEST = GIT_COMMIT.test.bind(GIT_COMMIT);
const IDENTIFIER_TEST = IDENTIFIER.test.bind(IDENTIFIER);
const PR_MERGE_SUBJECT_EXEC = PR_MERGE_SUBJECT.exec.bind(PR_MERGE_SUBJECT);
const TO_NUMBER = Number;
const NUMBER_IS_FINITE = Number.isFinite.bind(Number);
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger.bind(Number);
const TOP_LEVEL_KEYS = FREEZE_OBJECT([
  "schemaVersion",
  "artifactId",
  "classification",
  "createOnly",
  "decision",
  "acceptedEvidenceClass",
  "taskId",
  "evidenceKind",
  "candidateReceipt",
  "candidateReceiptDigest",
  "subject",
  "artifactDigest",
] as const);
const SUBJECT_KEYS = FREEZE_OBJECT([
  "executionId",
  "outputDigest",
  "candidateLedgerDigest",
  "fixedSourceCommit",
  "sourceBundleDigest",
  "manifestDigest",
  "compiledRuntimeDigest",
  "compiledBindingDigest",
  "settlementObserverDigest",
  "knownSettlementDigest",
  "alias",
  "protocol",
  "reasoning",
] as const);

export interface GitReviewedEvidenceAcceptanceSubject {
  executionId: string;
  outputDigest: string;
  candidateLedgerDigest: string;
  fixedSourceCommit: string;
  sourceBundleDigest: string;
  manifestDigest: string;
  compiledRuntimeDigest: string;
  compiledBindingDigest: string;
  settlementObserverDigest: string;
  knownSettlementDigest: string;
  alias: string;
  protocol: string;
  reasoning: string;
}

export interface GitReviewedEvidenceAcceptanceArtifact {
  schemaVersion: typeof GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION;
  artifactId: string;
  classification: typeof CLASSIFICATION;
  createOnly: true;
  decision: typeof DECISION;
  acceptedEvidenceClass: string;
  taskId: string;
  evidenceKind: string;
  candidateReceipt: Readonly<Record<string, unknown>>;
  candidateReceiptDigest: string;
  subject: Readonly<GitReviewedEvidenceAcceptanceSubject>;
  artifactDigest: string;
}

export interface VerifiedGitReviewedEvidenceAcceptance {
  readonly __opaque?: never;
}

export interface GitReviewedEvidenceAcceptanceAttestation {
  classification: typeof HANDLE_CLASSIFICATION;
  schemaVersion: typeof GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION;
  repositoryRoot: string;
  artifactPath: string;
  artifactId: string;
  artifactDigest: string;
  artifactCommit: string;
  mergeCommit: string;
  pullRequestNumber: number;
  originMainCommit: string;
  acceptedEvidenceClass: string;
  taskId: string;
  evidenceKind: string;
  candidateReceipt: Readonly<Record<string, unknown>>;
  candidateReceiptDigest: string;
  subject: Readonly<GitReviewedEvidenceAcceptanceSubject>;
}

const VERIFIED_ACCEPTANCES = new WeakMap<
  object,
  GitReviewedEvidenceAcceptanceAttestation
>();
const GET_VERIFIED_ACCEPTANCE =
  VERIFIED_ACCEPTANCES.get.bind(VERIFIED_ACCEPTANCES);
const SET_VERIFIED_ACCEPTANCE =
  VERIFIED_ACCEPTANCES.set.bind(VERIFIED_ACCEPTANCES);

function fail(code: string): never {
  throw new Error(code);
}

function stableSerialize(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON_STRINGIFY(value);
  }
  if (typeof value === "number") {
    if (!NUMBER_IS_FINITE(value)) {
      fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
    }
    return JSON_STRINGIFY(value);
  }
  if (ARRAY_IS_ARRAY(value)) {
    const serialized: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      ARRAY_PUSH(serialized, stableSerialize(value[index]));
    }
    return `[${ARRAY_JOIN(serialized, ",")}]`;
  }
  if (plainRecord(value)) {
    const keys = OBJECT_KEYS(value);
    ARRAY_SORT(keys);
    const serialized: string[] = [];
    for (const key of keys) {
      ARRAY_PUSH(
        serialized,
        `${JSON_STRINGIFY(key)}:${stableSerialize(value[key])}`,
      );
    }
    return `{${ARRAY_JOIN(serialized, ",")}}`;
  }
  return fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
}

function digest(value: unknown): string {
  return CREATE_HASH("sha256").update(stableSerialize(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of OBJECT_VALUES(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    FREEZE_OBJECT(value);
  }
  return value;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(STRUCTURED_CLONE(value));
}

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = OBJECT_KEYS(value);
  if (keys.length !== expected.length) return false;
  for (const key of keys) {
    let found = false;
    for (const candidate of expected) {
      if (candidate === key) {
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== "object" || ARRAY_IS_ARRAY(value)) {
    return false;
  }
  const prototype = OBJECT_GET_PROTOTYPE(value);
  return prototype === OBJECT_PROTOTYPE || prototype === null;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER_TEST(value);
}

function validDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_TEST(value);
}

function validCommit(value: unknown): value is string {
  return typeof value === "string" && GIT_COMMIT_TEST(value);
}

function validateSubject(
  value: unknown,
): asserts value is GitReviewedEvidenceAcceptanceSubject {
  if (!plainRecord(value) || !exactKeys(value, SUBJECT_KEYS)) {
    fail("GIT_EVIDENCE_ACCEPTANCE_SUBJECT_INVALID");
  }
  for (const key of [
    "outputDigest",
    "candidateLedgerDigest",
    "sourceBundleDigest",
    "manifestDigest",
    "compiledRuntimeDigest",
    "compiledBindingDigest",
    "settlementObserverDigest",
    "knownSettlementDigest",
  ] as const) {
    if (!validDigest(value[key])) {
      fail("GIT_EVIDENCE_ACCEPTANCE_SUBJECT_INVALID");
    }
  }
  if (!validCommit(value.fixedSourceCommit)) {
    fail("GIT_EVIDENCE_ACCEPTANCE_SUBJECT_INVALID");
  }
  for (const key of [
    "executionId",
    "alias",
    "protocol",
    "reasoning",
  ] as const) {
    if (!validIdentifier(value[key])) {
      fail("GIT_EVIDENCE_ACCEPTANCE_SUBJECT_INVALID");
    }
  }
}

function assertCandidateSubjectBinding(
  candidateReceipt: Readonly<Record<string, unknown>>,
  subject: GitReviewedEvidenceAcceptanceSubject,
  taskId: string,
  evidenceKind: string,
): void {
  const bindings: ReadonlyArray<readonly [unknown, unknown]> = [
    [candidateReceipt.taskId, taskId],
    [candidateReceipt.evidenceKind, evidenceKind],
    [candidateReceipt.executionId, subject.executionId],
    [candidateReceipt.outputDigest, subject.outputDigest],
    [candidateReceipt.ledgerDigest, subject.candidateLedgerDigest],
    [candidateReceipt.fixedSourceCommit, subject.fixedSourceCommit],
    [candidateReceipt.sourceBundleDigest, subject.sourceBundleDigest],
    [candidateReceipt.manifestDigest, subject.manifestDigest],
    [candidateReceipt.compiledRuntimeDigest, subject.compiledRuntimeDigest],
    [candidateReceipt.compiledBindingDigest, subject.compiledBindingDigest],
    [
      candidateReceipt.settlementObserverDigest,
      subject.settlementObserverDigest,
    ],
    [candidateReceipt.knownSettlementDigest, subject.knownSettlementDigest],
    [candidateReceipt.alias, subject.alias],
    [candidateReceipt.protocol, subject.protocol],
    [candidateReceipt.reasoning, subject.reasoning],
  ];
  for (const [actual, expected] of bindings) {
    if (actual !== expected) {
      fail("GIT_EVIDENCE_ACCEPTANCE_SUBJECT_MISMATCH");
    }
  }
}

function exactArtifact(value: unknown): GitReviewedEvidenceAcceptanceArtifact {
  if (!plainRecord(value) || !exactKeys(value, TOP_LEVEL_KEYS)) {
    return fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
  }
  const artifact = value as unknown as GitReviewedEvidenceAcceptanceArtifact;
  validateSubject(artifact.subject);
  if (
    artifact.schemaVersion !==
      GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION ||
    artifact.classification !== CLASSIFICATION ||
    artifact.createOnly !== true ||
    artifact.decision !== DECISION ||
    !validIdentifier(artifact.artifactId) ||
    !validIdentifier(artifact.acceptedEvidenceClass) ||
    !validIdentifier(artifact.taskId) ||
    !validIdentifier(artifact.evidenceKind) ||
    !plainRecord(artifact.candidateReceipt) ||
    !validDigest(artifact.candidateReceiptDigest) ||
    artifact.candidateReceiptDigest !== digest(artifact.candidateReceipt) ||
    !validDigest(artifact.artifactDigest)
  ) {
    return fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
  }
  assertCandidateSubjectBinding(
    artifact.candidateReceipt,
    artifact.subject,
    artifact.taskId,
    artifact.evidenceKind,
  );
  const { artifactDigest, ...withoutDigest } = artifact;
  if (artifactDigest !== digest(withoutDigest)) {
    fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_DIGEST_MISMATCH");
  }
  return deepFreeze(immutableClone(artifact));
}

export function createGitReviewedEvidenceAcceptanceArtifact(input: {
  artifactId: string;
  acceptedEvidenceClass: string;
  taskId: string;
  evidenceKind: string;
  candidateReceipt: Readonly<Record<string, unknown>>;
  subject: GitReviewedEvidenceAcceptanceSubject;
}): GitReviewedEvidenceAcceptanceArtifact {
  const candidateReceipt = immutableClone(input.candidateReceipt);
  const subject = immutableClone(input.subject);
  const withoutDigest = {
    schemaVersion: GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION,
    artifactId: input.artifactId,
    classification: CLASSIFICATION,
    createOnly: true as const,
    decision: DECISION,
    acceptedEvidenceClass: input.acceptedEvidenceClass,
    taskId: input.taskId,
    evidenceKind: input.evidenceKind,
    candidateReceipt,
    candidateReceiptDigest: digest(candidateReceipt),
    subject,
  };
  return exactArtifact({
    ...withoutDigest,
    artifactDigest: digest(withoutDigest),
  });
}

export async function writeGitReviewedEvidenceAcceptanceArtifact(input: {
  artifactPath: string;
  artifact: GitReviewedEvidenceAcceptanceArtifact;
}): Promise<void> {
  const artifact = exactArtifact(immutableClone(input.artifact));
  let handle;
  try {
    handle = await OPEN(input.artifactPath, FS_OPEN_CREATE_ONLY, 0o644);
  } catch {
    return fail("GIT_EVIDENCE_ACCEPTANCE_CREATE_ONLY");
  }
  try {
    await handle.writeFile(`${JSON_STRINGIFY(artifact, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function withinRoot(root: string, path: string): boolean {
  const location = PATH_RELATIVE(root, path);
  return (
    location !== ".." &&
    !location.startsWith(`..${PATH_SEPARATOR}`) &&
    !IS_ABSOLUTE(location)
  );
}

function safeRelativePath(path: string): boolean {
  if (
    path.length === 0 ||
    IS_ABSOLUTE(path) ||
    STRING_INCLUDES(path, "\\") ||
    STRING_INCLUDES(path, "\n") ||
    STRING_INCLUDES(path, "\t")
  ) {
    return false;
  }
  for (const segment of STRING_SPLIT(path, "/")) {
    if (segment === "..") return false;
  }
  return true;
}

async function secureRead(path: string): Promise<Buffer> {
  const before = await LSTAT(path).catch(() =>
    fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID"),
  );
  if (!before.isFile() || before.isSymbolicLink()) {
    fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
  }
  let handle;
  try {
    handle = await OPEN(path, FS_OPEN_READ_ONLY_NO_FOLLOW);
  } catch {
    return fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size > MAXIMUM_ARTIFACT_BYTES
    ) {
      fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function gitBytes(root: string, args: readonly string[]): Buffer {
  try {
    return EXEC_FILE_SYNC("git", [...args], {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return fail("GIT_EVIDENCE_ACCEPTANCE_GIT_VERIFICATION_FAILED");
  }
}

function gitText(root: string, args: readonly string[]): string {
  return STRING_TRIM(BUFFER_TO_STRING(gitBytes(root, args), "utf8"));
}

function gitSuccess(root: string, args: readonly string[]): boolean {
  return (
    SPAWN_SYNC("git", [...args], { cwd: root, stdio: "ignore" }).status === 0
  );
}

function gitShowMaybe(
  root: string,
  commit: string,
  path: string,
): Buffer | undefined {
  const result = SPAWN_SYNC("git", ["show", `${commit}:${path}`], {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
  });
  return result.status === 0 && BUFFER_IS_BUFFER(result.stdout)
    ? result.stdout
    : undefined;
}

function nonEmptyLines(value: string): readonly string[] {
  if (value.length === 0) return [];
  const result: string[] = [];
  for (const line of STRING_SPLIT(value, "\n")) {
    if (line.length > 0) ARRAY_PUSH(result, line);
  }
  return result;
}

function deriveArtifactCommit(root: string, path: string): string {
  const additions = nonEmptyLines(
    gitText(root, [
      "log",
      "--format=%H",
      "--diff-filter=A",
      "--no-merges",
      "HEAD",
      "--",
      path,
    ]),
  );
  const history = nonEmptyLines(
    gitText(root, ["log", "--format=%H", "--no-merges", "HEAD", "--", path]),
  );
  if (
    additions.length !== 1 ||
    history.length !== 1 ||
    additions[0] !== history[0] ||
    !validCommit(additions[0])
  ) {
    fail("GIT_EVIDENCE_ACCEPTANCE_IMMUTABLE_HISTORY_REQUIRED");
  }
  const status = gitText(root, [
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "-r",
    "--root",
    additions[0],
    "--",
    path,
  ]);
  if (status !== `A\t${path}`) {
    fail("GIT_EVIDENCE_ACCEPTANCE_IMMUTABLE_HISTORY_REQUIRED");
  }
  return additions[0];
}

function derivePullRequestMerge(input: {
  root: string;
  path: string;
  artifactCommit: string;
  artifactBytes: Buffer;
  originMainCommit: string;
}): { mergeCommit: string; pullRequestNumber: number } {
  const firstParent = nonEmptyLines(
    gitText(input.root, [
      "rev-list",
      "--first-parent",
      "--reverse",
      input.originMainCommit,
    ]),
  );
  let introduction: string | undefined;
  for (const commit of firstParent) {
    if (gitShowMaybe(input.root, commit, input.path) != null) {
      introduction = commit;
      break;
    }
  }
  if (!introduction) {
    return fail("GIT_EVIDENCE_ACCEPTANCE_NOT_ON_MAIN");
  }
  const parentLine = gitText(input.root, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    introduction,
  ]);
  const parents = STRING_SPLIT(parentLine, " ");
  let introducedByMergedParent = false;
  for (let index = 2; index < parents.length; index += 1) {
    if (
      gitSuccess(input.root, [
        "merge-base",
        "--is-ancestor",
        input.artifactCommit,
        parents[index]!,
      ])
    ) {
      introducedByMergedParent = true;
      break;
    }
  }
  if (parents.length < 3 || !introducedByMergedParent) {
    return fail("GIT_EVIDENCE_ACCEPTANCE_PR_MERGE_REQUIRED");
  }
  const subject = gitText(input.root, [
    "log",
    "-1",
    "--format=%s",
    introduction,
  ]);
  const match = PR_MERGE_SUBJECT_EXEC(subject);
  const introducedBytes = gitShowMaybe(input.root, introduction, input.path);
  const pullRequestNumber = TO_NUMBER(match?.[1] ?? "");
  if (
    !match ||
    !NUMBER_IS_SAFE_INTEGER(pullRequestNumber) ||
    pullRequestNumber < 1 ||
    !introducedBytes ||
    !BUFFER_EQUALS(introducedBytes, input.artifactBytes)
  ) {
    return fail("GIT_EVIDENCE_ACCEPTANCE_PR_MERGE_REQUIRED");
  }
  return {
    mergeCommit: introduction,
    pullRequestNumber,
  };
}

export async function verifyGitReviewedEvidenceAcceptanceArtifact(input: {
  repositoryRoot: string;
  artifactPath: string;
}): Promise<VerifiedGitReviewedEvidenceAcceptance> {
  const root = await REALPATH(input.repositoryRoot).catch(() =>
    fail("GIT_EVIDENCE_ACCEPTANCE_REPOSITORY_INVALID"),
  );
  const requestedPath = PATH_RESOLVE(input.artifactPath);
  const requestedMetadata = await LSTAT(requestedPath).catch(() =>
    fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID"),
  );
  if (requestedMetadata.isSymbolicLink() || !requestedMetadata.isFile()) {
    fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
  }
  const artifactPath = await REALPATH(requestedPath).catch(() =>
    fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID"),
  );
  if (!withinRoot(root, artifactPath)) {
    fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
  }
  const artifactRelativePath = STRING_REPLACE_ALL(
    PATH_RELATIVE(root, artifactPath),
    PATH_SEPARATOR,
    "/",
  );
  if (!safeRelativePath(artifactRelativePath)) {
    fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
  }
  if (
    !gitSuccess(root, [
      "ls-files",
      "--error-unmatch",
      "--",
      artifactRelativePath,
    ])
  ) {
    fail("GIT_EVIDENCE_ACCEPTANCE_NOT_TRACKED");
  }
  const status = gitText(root, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    artifactRelativePath,
  ]);
  if (status.length !== 0) {
    fail("GIT_EVIDENCE_ACCEPTANCE_BYTES_MISMATCH");
  }
  const artifactBytes = await secureRead(artifactPath);
  const headCommit = gitText(root, ["rev-parse", "HEAD"]);
  const originMainCommit = gitText(root, ["rev-parse", "origin/main"]);
  if (!validCommit(headCommit) || !validCommit(originMainCommit)) {
    fail("GIT_EVIDENCE_ACCEPTANCE_GIT_VERIFICATION_FAILED");
  }
  const artifactCommit = deriveArtifactCommit(root, artifactRelativePath);
  for (const descendant of [headCommit, originMainCommit]) {
    if (
      !gitSuccess(root, [
        "merge-base",
        "--is-ancestor",
        artifactCommit,
        descendant,
      ])
    ) {
      fail("GIT_EVIDENCE_ACCEPTANCE_NOT_ON_MAIN");
    }
  }
  const addCommitBytes = gitBytes(root, [
    "show",
    `${artifactCommit}:${artifactRelativePath}`,
  ]);
  const headBytes = gitBytes(root, ["show", `HEAD:${artifactRelativePath}`]);
  const originBytes = gitBytes(root, [
    "show",
    `origin/main:${artifactRelativePath}`,
  ]);
  if (
    !BUFFER_EQUALS(artifactBytes, addCommitBytes) ||
    !BUFFER_EQUALS(artifactBytes, headBytes) ||
    !BUFFER_EQUALS(artifactBytes, originBytes)
  ) {
    fail("GIT_EVIDENCE_ACCEPTANCE_BYTES_MISMATCH");
  }
  const { mergeCommit, pullRequestNumber } = derivePullRequestMerge({
    root,
    path: artifactRelativePath,
    artifactCommit,
    artifactBytes,
    originMainCommit,
  });
  if (
    !gitSuccess(root, ["merge-base", "--is-ancestor", mergeCommit, headCommit])
  ) {
    fail("GIT_EVIDENCE_ACCEPTANCE_NOT_ON_MAIN");
  }
  let parsed: unknown;
  try {
    parsed = JSON_PARSE(BUFFER_TO_STRING(artifactBytes, "utf8"));
  } catch {
    return fail("GIT_EVIDENCE_ACCEPTANCE_ARTIFACT_INVALID");
  }
  const artifact = exactArtifact(parsed);
  const attestation = deepFreeze({
    classification: HANDLE_CLASSIFICATION,
    schemaVersion: GIT_REVIEWED_EVIDENCE_ACCEPTANCE_SCHEMA_VERSION,
    repositoryRoot: root,
    artifactPath,
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    artifactCommit,
    mergeCommit,
    pullRequestNumber,
    originMainCommit,
    acceptedEvidenceClass: artifact.acceptedEvidenceClass,
    taskId: artifact.taskId,
    evidenceKind: artifact.evidenceKind,
    candidateReceipt: immutableClone(artifact.candidateReceipt),
    candidateReceiptDigest: artifact.candidateReceiptDigest,
    subject: immutableClone(artifact.subject),
  });
  const handle = FREEZE_OBJECT({}) as VerifiedGitReviewedEvidenceAcceptance;
  SET_VERIFIED_ACCEPTANCE(handle, attestation);
  return handle;
}

export function getGitReviewedEvidenceAcceptanceAttestation(
  acceptance: VerifiedGitReviewedEvidenceAcceptance,
): GitReviewedEvidenceAcceptanceAttestation | undefined {
  return GET_VERIFIED_ACCEPTANCE(acceptance);
}

function stableAttestationDigest(
  value: GitReviewedEvidenceAcceptanceAttestation,
): string {
  const { originMainCommit: _observedOriginMainCommit, ...stable } = value;
  return digest(stable);
}

export async function assertGitReviewedEvidenceAcceptanceCurrent(
  acceptance: VerifiedGitReviewedEvidenceAcceptance,
): Promise<void> {
  const expected = GET_VERIFIED_ACCEPTANCE(acceptance);
  if (!expected) fail("GIT_EVIDENCE_ACCEPTANCE_HANDLE_REQUIRED");
  const current = await verifyGitReviewedEvidenceAcceptanceArtifact({
    repositoryRoot: expected.repositoryRoot,
    artifactPath: expected.artifactPath,
  });
  const observed = GET_VERIFIED_ACCEPTANCE(current);
  if (
    !observed ||
    stableAttestationDigest(observed) !== stableAttestationDigest(expected)
  ) {
    fail("GIT_EVIDENCE_ACCEPTANCE_BINDING_DRIFT");
  }
}

if (typeof module !== "undefined") {
  FREEZE_OBJECT(module.exports);
}
