import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as admission from "./governance-organization-identity-current-main-admission.mjs";

const paths = [
  "apps/api/src/discovery/suppression-policy-lock.spec.ts",
  "apps/api/src/discovery/suppression-policy-lock.ts",
];
const hash = (value) => admission.sha256(Buffer.from(value));
const digest = (value) => admission.sha256(admission.canonicalJsonBytes(value));
const commit = "a".repeat(40);
const candidate = () => ({
  schemaVersion: "organization-identity-suppression-resolution-candidate/v1",
  repository: "mlhjyx/global-backend",
  branchPreRefreshCommit: commit,
  liveMainCommit: "b".repeat(40),
  mergeBaseCommit: "c".repeat(40),
  resultSourceCommit: "d".repeat(40),
  entries: paths.map((p, i) => ({
    path: p,
    baseBlobId: commit,
    branchBlobId: commit,
    mainBlobId: commit,
    resultBlobId: commit,
    resultSha256: hash("result"),
    hunkCount: 1,
    deltaSha256: hash("delta"),
    intent:
      i === 0
        ? "PRESERVE_TX_SCALAR_WORKSPACE_NEGATIVES"
        : "PRESERVE_TX_SCALAR_VOID_CAST",
  })),
  testEvidence: {
    subjectCommit: "d".repeat(40),
    command:
      "pnpm --filter @global/api exec vitest run src/discovery/suppression-policy-lock.spec.ts --maxWorkers=1",
    exitCode: 0,
    reportSha256: hash("test output"),
  },
});

test("resolution candidate validates exactly two paths without granting admission", () => {
  assert.equal(
    typeof admission.validateSuppressionResolutionCandidate,
    "function",
  );
  assert.deepEqual(
    admission.validateSuppressionResolutionCandidate(candidate()),
    {
      status: "PASS",
      evidenceClass: "STRUCTURE_ONLY",
      admissionGranted: false,
    },
  );
  const changes = [
    (c) => c.entries.pop(),
    (c) => c.entries.reverse(),
    (c) => c.entries.push(c.entries[0]),
    (c) => (c.entries[0].path = "apps/api/src/main.ts"),
    (c) => (c.entries[0].resultBlobId = null),
    (c) => (c.entries[0].hunkCount = 65),
    (c) => (c.entries[0].intent = "PRESERVE_TX_SCALAR_VOID_CAST"),
    (c) => (c.testEvidence.subjectCommit = commit),
    (c) => (c.testEvidence.exitCode = 1),
    (c) => (c.testEvidence.command = "sh -c true"),
    (c) => (c.entries[0].extra = true),
    (c) => (c.extra = true),
  ];
  for (const change of changes) {
    const c = candidate();
    change(c);
    assert.equal(
      admission.validateSuppressionResolutionCandidate(c).status,
      "HOLD",
    );
  }
});

test("resolution candidate rejects proxies and accessor getters without evaluating them", () => {
  assert.equal(
    typeof admission.validateSuppressionResolutionCandidate,
    "function",
  );
  let reads = 0;
  const c = candidate();
  Object.defineProperty(c, "entries", {
    get() {
      reads++;
      throw Error("do not invoke");
    },
  });
  for (const value of [
    null,
    undefined,
    c,
    new Proxy(
      {},
      {
        get() {
          reads++;
          throw Error("do not invoke");
        },
      },
    ),
  ])
    assert.equal(
      admission.validateSuppressionResolutionCandidate(value).status,
      "HOLD",
    );
  assert.equal(reads, 0);
});

test("resolution review binds independently supplied facts and refuses self-declared substitutes", () => {
  assert.equal(
    typeof admission.validateSuppressionResolutionReview,
    "function",
  );
  const c = candidate();
  const r = {
    schemaVersion: "organization-identity-suppression-resolution-review/v1",
    candidateSha256: digest(c),
    reportSha256: hash("independent review"),
    counterexampleSetSha256: hash("counterexamples"),
    reviewerClass: "INDEPENDENT_ADMISSION_RESOLUTION_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
  assert.equal(
    admission.validateSuppressionResolutionReview(r, r).status,
    "PASS",
  );
  assert.equal(admission.validateSuppressionResolutionReview(r).status, "HOLD");
  for (const delta of [
    { important: 1 },
    { candidateSha256: hash("other") },
    { extra: true },
    { reviewerClass: "AUTHOR" },
  ])
    assert.equal(
      admission.validateSuppressionResolutionReview({ ...r, ...delta }, r)
        .status,
      "HOLD",
    );
});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-resolution-v2-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("/usr/bin/git", ["-C", root, ...args], {
      encoding: "utf8",
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git(
    "remote",
    "add",
    "origin",
    "https://github.com/mlhjyx/global-backend.git",
  );
  await mkdir(path.join(root, ".github"));
  await writeFile(path.join(root, ".github/CODEOWNERS"), "* @owner\n");
  for (const p of paths) {
    await mkdir(path.dirname(path.join(root, p)), { recursive: true });
    await writeFile(path.join(root, p), "base\n");
  }
  git("add", ".");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature");
  for (const p of paths) await writeFile(path.join(root, p), "branch\n");
  git("add", ".");
  git("commit", "-qm", "feature");
  const branch = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  for (const p of paths) await writeFile(path.join(root, p), "main\n");
  git("add", ".");
  git("commit", "-qm", "main");
  const main = git("rev-parse", "HEAD");
  git("checkout", "-q", "feature");
  for (const p of paths)
    await writeFile(path.join(root, p), "reviewed result\n");
  git("add", ".");
  git("commit", "-qm", "result bytes");
  const result = git("rev-parse", "HEAD");
  const c = candidate();
  Object.assign(c, {
    branchPreRefreshCommit: branch,
    liveMainCommit: main,
    mergeBaseCommit: base,
    resultSourceCommit: result,
  });
  c.testEvidence.subjectCommit = result;
  for (const r of c.entries) {
    for (const [at, key] of [
      [base, "baseBlobId"],
      [branch, "branchBlobId"],
      [main, "mainBlobId"],
      [result, "resultBlobId"],
    ])
      r[key] = git("rev-parse", `${at}:${r.path}`);
    r.resultSha256 = hash("reviewed result\n");
    r.deltaSha256 = admission.sha256(
      execFileSync("/usr/bin/git", [
        "-C",
        root,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--binary",
        branch,
        result,
        "--",
        r.path,
      ]),
    );
  }
  return { root, git, c };
}

test("resolution observations bind real Git blobs, content, deltas, modes and conflict hunks", async (t) => {
  assert.equal(typeof admission.collectSuppressionResolutionFacts, "function");
  const f = await fixture(t),
    before = f.git("status", "--porcelain");
  const observed = admission.collectSuppressionResolutionFacts({
    repoRoot: f.root,
    candidate: f.c,
  });
  assert.equal(observed.status, "PASS", JSON.stringify(observed));
  assert.equal(observed.admissionGranted, false);
  assert.equal(observed.candidateSha256, digest(f.c));
  assert.equal(f.git("status", "--porcelain"), before);
  assert.equal(f.git("rev-parse", "HEAD"), f.c.resultSourceCommit);
  for (const change of [
    (c) => {
      c.resultSourceCommit = f.git(
        "rev-parse",
        `${c.resultSourceCommit}^{tree}`,
      );
      c.testEvidence.subjectCommit = c.resultSourceCommit;
    },
    (c) => (c.entries[0].resultSha256 = hash("other")),
    (c) => (c.entries[0].deltaSha256 = hash("other")),
    (c) => (c.entries[0].hunkCount = 2),
    (c) => (c.entries[0].baseBlobId = c.entries[0].mainBlobId),
  ]) {
    const c = structuredClone(f.c);
    change(c);
    assert.equal(
      admission.collectSuppressionResolutionFacts({
        repoRoot: f.root,
        candidate: c,
      }).status,
      "HOLD",
    );
  }
});

function review(c) {
  return {
    schemaVersion: "organization-identity-suppression-resolution-review/v1",
    candidateSha256: digest(c),
    reportSha256: hash("review"),
    counterexampleSetSha256: hash("counterexamples"),
    reviewerClass: "INDEPENDENT_ADMISSION_RESOLUTION_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
  };
}
function document(c, objectFacts, receipt) {
  return {
    schemaVersion: "organization-identity-current-main-admission/v2",
    status: "ADMITTED",
    artifactACommit: "2400bac28796bae44294114edc99eaccb1bd65b3",
    branchPreRefreshCommit: c.branchPreRefreshCommit,
    liveMainCommit: c.liveMainCommit,
    mergeBaseCommit: c.mergeBaseCommit,
    refreshMergeCommit: objectFacts.refreshMergeCommit,
    refreshParents: objectFacts.refreshParents,
    mainOnlyRange: `${c.mergeBaseCommit}..${c.liveMainCommit}`,
    mainOnlyPathCount: objectFacts.mainOnlyPaths.length,
    mainOnlyPathSetSha256: objectFacts.mainOnlyPathSetSha256,
    paths: objectFacts.mainOnlyPaths.map((r, i) => ({
      ...r,
      classifications: ["IDENTITY_AUTHORITY"],
      owner: objectFacts.owners[i].owner,
      evidenceSha256: [hash("evidence")],
      disposition: "ADMIT_IDENTITY_AUTHORITY_UNCHANGED",
      generatedRebuild: null,
    })),
    conflicts: c.entries.map(
      ({
        path,
        hunkCount,
        baseBlobId,
        branchBlobId,
        mainBlobId,
        resultBlobId,
      }) => ({
        path,
        hunkCount,
        baseBlobId,
        branchBlobId,
        mainBlobId,
        resultBlobId,
        resolutionSource: "REVIEWED_EXACT_SUPPRESSION_BLOB",
      }),
    ),
    migrations: [],
    rawDeltaSha256: hash("raw"),
    buildDeltaSha256: hash("build"),
    schemaDeltaSha256: hash("schema"),
    callerDeltaSha256: hash("caller"),
    review: {
      auditPacketSha256: hash("audit"),
      auditReviewReceiptSha256: hash("audit review"),
      reportSha256: hash("audit report"),
      verdict: "PASS",
    },
    suppressionResolution: {
      candidateSha256: digest(c),
      reviewReceiptSha256: digest(receipt),
    },
  };
}

test("v2 admission requires collected object facts and exact reviewed resolution bindings", async (t) => {
  assert.equal(
    typeof admission.validateAdmissionSuppressionResolutionBindings,
    "function",
  );
  const f = await fixture(t),
    r = review(f.c);
  f.git("checkout", "-qb", "refresh", f.c.branchPreRefreshCommit);
  try {
    f.git("merge", "--no-commit", "--no-ff", f.c.liveMainCommit);
  } catch {}
  for (const p of paths)
    await writeFile(path.join(f.root, p), "reviewed result\n");
  f.git("add", ".");
  f.git("commit", "-qm", "fixture refresh");
  const obj = admission.collectAdmissionObjectFacts({
    repoRoot: f.root,
    branchPreRefreshCommit: f.c.branchPreRefreshCommit,
    liveMainCommit: f.c.liveMainCommit,
    refreshMergeCommit: f.git("rev-parse", "HEAD"),
  });
  const local = admission.collectSuppressionResolutionFacts({
    repoRoot: f.root,
    candidate: f.c,
  });
  assert.equal(obj.status, "PASS");
  assert.equal(local.status, "PASS");
  const d = document(f.c, obj, r),
    args = {
      document: d,
      candidateFacts: local,
      reviewReceipt: r,
      expectedReview: r,
      objectFacts: obj,
    };
  assert.equal(
    admission.validateCurrentMainAdmissionStructure(d).status,
    "PASS",
  );
  assert.equal(
    admission.validateCurrentMainAdmissionStructure(d).admissionGranted,
    false,
  );
  assert.equal(
    admission.validateArtifactAMigrationBindings(d, {
      artifactACommit: d.artifactACommit,
      artifactAMigrationBlobs: [],
      mainOnlyMigrationPaths: [],
    }).status,
    "PASS",
  );
  assert.deepEqual(
    admission.validateAdmissionSuppressionResolutionBindings(args),
    {
      status: "PASS",
      evidenceClass: "LOCAL_RESOLUTION_BINDINGS_ONLY",
      admissionGranted: false,
    },
  );
  const old = {
    ...d,
    schemaVersion: "organization-identity-current-main-admission/v1",
  };
  delete old.suppressionResolution;
  assert.equal(
    admission.validateCurrentMainAdmissionStructure(old).status,
    "HOLD",
  );
  for (const change of [
    (a) => (a.candidateFacts = structuredClone(local)),
    (a) => (a.objectFacts = structuredClone(obj)),
    (a) => (a.expectedReview = undefined),
    (a) => (a.reviewReceipt = { ...r, important: 1 }),
    (a) =>
      (a.document = {
        ...d,
        suppressionResolution: {
          ...d.suppressionResolution,
          candidateSha256: hash("other"),
        },
      }),
    (a) =>
      (a.document = {
        ...d,
        conflicts: d.conflicts.map((x, i) =>
          i === 0 ? { ...x, resultBlobId: "f".repeat(40) } : x,
        ),
      }),
    (a) => (a.document = { ...d, suppressionResolution: null }),
    (a) =>
      (a.document = {
        ...d,
        conflicts: [
          ...d.conflicts,
          {
            path: "docs/evidence/site-builder/copy-runtime-eligibility.json",
            hunkCount: 1,
            baseBlobId: commit,
            branchBlobId: commit,
            mainBlobId: commit,
            resultBlobId: commit,
            resolutionSource: "LIVE_MAIN_GIT_BLOB",
          },
        ],
      }),
  ]) {
    const a = { ...args };
    change(a);
    assert.equal(
      admission.validateAdmissionSuppressionResolutionBindings(a).status,
      "HOLD",
    );
  }
});

test("audit review v2 binds resolution digests; v1 cannot carry an exception", () => {
  const r = {
    schemaVersion: "organization-identity-current-main-audit-review/v2",
    disposition: "PASS",
    auditPacketSha256: hash("a"),
    githubControllerContractSha256: hash("b"),
    githubControllerReviewReceiptSha256: hash("c"),
    protectedMainReadbackReceiptSha256: hash("d"),
    localBootstrapRunReceiptSetSha256: hash("e"),
    branchPreRefreshCommit: commit,
    advertisedLiveMainCommit: "b".repeat(40),
    mergeBaseCommit: "c".repeat(40),
    mainOnlyPathSetSha256: hash("f"),
    conflictSetSha256: hash("g"),
    migrationSetSha256: hash("h"),
    dispositionSetSha256: hash("i"),
    authorizationRequestSha256: hash("j"),
    fetchReceiptSha256: null,
    reportSha256: hash("k"),
    counterexampleSetSha256: hash("l"),
    reviewerClass: "INDEPENDENT_ADMISSION_AUDIT_REVIEW",
    critical: 0,
    important: 0,
    verdict: "PASS",
    suppressionResolutionCandidateSha256: hash("candidate"),
    suppressionResolutionReviewReceiptSha256: hash("review"),
  };
  assert.equal(admission.validateAuditReviewReceipt(r, r).status, "PASS");
  assert.equal(
    admission.validateAuditReviewReceipt(r, r).admissionGranted,
    false,
  );
  assert.equal(
    admission.validateAuditReviewReceipt(
      {
        ...r,
        schemaVersion: "organization-identity-current-main-audit-review/v1",
      },
      r,
    ).status,
    "HOLD",
  );
  assert.equal(
    admission.validateAuditReviewReceipt(
      { ...r, suppressionResolutionReviewReceiptSha256: null },
      r,
    ).status,
    "HOLD",
  );
  const noException = {
    ...r,
    suppressionResolutionCandidateSha256: null,
    suppressionResolutionReviewReceiptSha256: null,
  };
  assert.equal(
    admission.validateAuditReviewReceipt(noException, noException).status,
    "PASS",
  );
});
