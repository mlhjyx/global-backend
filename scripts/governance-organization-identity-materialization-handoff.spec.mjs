import assert from "node:assert/strict";
import { test } from "node:test";
import * as packet from "./governance-organization-identity-root-materialization-packet.mjs";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  realpathSync,
  linkSync,
  unlinkSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  APPROVED_PLAN,
  APPROVED_SPEC,
  canonicalJsonBytes,
} from "./governance-organization-identity-launcher.mjs";
import {
  verifyMaterializationFile,
  verifyMaterializationDestinations,
} from "./governance-organization-identity-materialization-preflight.mjs";

const sourceRepo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const script = (name) => `scripts/governance-organization-identity-${name}`;
const aPaths = [
  "root-materialization-packet.mjs",
  "root-materialization-packet.spec.mjs",
  "materialization-preflight.mjs",
  "materialization-preflight.spec.mjs",
  "materialization-handoff.mjs",
  "materialization-handoff.spec.mjs",
].map(script);
const closure = [
  ...aPaths,
  script("launcher.mjs"),
  ...[
    "launcher-execution.spec.mjs",
    "launcher-trust.spec.mjs",
    "launcher-request.spec.mjs",
    "test-fixtures.mjs",
  ].map(script),
];
const bPaths = [
  script("bootstrap.mjs"),
  script("bootstrap.spec.mjs"),
  script("bootstrap-supplemental.spec.mjs"),
  "docs/governance/organization-identity-bootstrap-contract.json",
];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = (obj) => hash(canonicalJsonBytes(obj));
const runGit = (repo, ...args) =>
  execFileSync("git", ["-C", repo, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  })
    .toString()
    .trim();
const descriptor = (file) => ({
  path: file,
  sha256: hash(readFileSync(file)),
  size: statSync(file).size,
  mode: statSync(file).mode & 0o7777,
});
const scopes = {
  plan: ["AUTHORITY_MODEL", "PLAN_SPEC"],
  phaseA: [
    "PHASE_A_SCOPE",
    "SOURCE_BYTES",
    "GENERATOR_CLOSURE",
    "TESTS",
    "ACYCLIC_CONTRACT",
  ],
  phaseB: [
    "PHASE_B_SCOPE",
    "BOOTSTRAP_BYTES",
    "BOOTSTRAP_CONTRACT",
    "CONTRACT_REBIND",
    "TESTS",
  ],
  whole: [
    "SOURCE_BYTES",
    "GENERATOR_CLOSURE",
    "PLANNED_BYTES",
    "ROOT_DESTINATIONS",
    "WHOLE_PACKET",
    "ACYCLIC_CONTRACT",
    "SOURCE_DESTINATION_SEPARATION",
    "EXCLUSIVE_OUTPUT",
    "DRIFT",
    "HISTORICAL_HOLD",
  ],
};
function fixtureReview(root, kind, subjects, suffix = "") {
  const examples = path.join(root, `${kind}${suffix}.counterexamples.json`);
  const report = path.join(root, `${kind}${suffix}.md`);
  writeFileSync(
    examples,
    JSON.stringify({
      evidenceClass: "TEMPORARY_FIXTURE_NOT_AUTHORITY",
      kind,
      cases: ["fixture-only"],
    }),
    { mode: 0o600 },
  );
  const binding = {
    schemaVersion: "organization-identity-materialization-review-binding/v1",
    kind,
    scope: scopes[kind],
    subjects,
    counterexampleSetSha256: descriptor(examples).sha256,
  };
  writeFileSync(
    report,
    `# TEMPORARY FIXTURE NOT INDEPENDENT AUTHORITY\nMaterialization-Binding: ${JSON.stringify(binding)}\nCritical: 0\nImportant: 0\nVerdict: PASS\n`,
    { mode: 0o600 },
  );
  return { report: descriptor(report), counterexamples: descriptor(examples) };
}
function tuple(repo, at, file) {
  const bytes = execFileSync("git", [
    "-C",
    repo,
    "cat-file",
    "blob",
    `${at}:${file}`,
  ]);
  return {
    commit: at,
    blobId: runGit(repo, "rev-parse", `${at}:${file}`),
    sha256: hash(bytes),
    size: bytes.length,
  };
}
async function fixture() {
  const root = mkdtempSync(
    path.join(tmpdir(), "identity-generation-nonauthority-"),
  );
  const repo = path.join(root, "repo");
  execFileSync(
    "git",
    ["clone", "--shared", "--no-checkout", sourceRepo, repo],
    { stdio: "pipe" },
  );
  runGit(repo, "config", "user.name", "Non-authority fixture");
  runGit(repo, "config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(repo, ".git/info/exclude"), ".superpowers/\n", {
    flag: "a",
  });
  const base = runGit(repo, "rev-parse", "HEAD");
  runGit(repo, "read-tree", base);
  for (const file of [
    ...closure,
    ...bPaths,
    APPROVED_PLAN.path,
    APPROVED_SPEC.path,
    ".gitignore",
  ]) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
    writeFileSync(
      path.join(repo, file),
      readFileSync(path.join(sourceRepo, file)),
      { mode: statSync(path.join(sourceRepo, file)).mode & 0o7777 },
    );
  }
  // Keep the fixture's A range nonempty after the implementation itself is committed.
  writeFileSync(
    path.join(repo, aPaths[1]),
    "\n// Non-authority fixture Phase A boundary.\n",
    { flag: "a" },
  );
  runGit(repo, "add", "--", ...aPaths);
  runGit(
    repo,
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "test: non-authority Phase A fixture",
  );
  const a = runGit(repo, "rev-parse", "HEAD");
  const api = await import(pathToFileURL(path.join(repo, aPaths[0])));
  const out = path.join(repo, ".superpowers/sdd/generation-fixture");
  mkdirSync(out, { recursive: true });
  const installedPaths = [
    "/usr/bin/env",
    "/root/.fnm/node-versions/v22.23.1/installation/bin/node",
    "/usr/bin/git",
    "/root/.fnm/node-versions/v22.23.1/installation/lib/node_modules/corepack/dist/corepack.js",
    "/root/.fnm/node-versions/v22.23.1/installation/lib/node_modules/corepack/dist/lib/corepack.cjs",
    "/root/.cache/node/corepack/v1/pnpm/9.15.9/bin/pnpm.cjs",
    "/root/.cache/node/corepack/v1/pnpm/9.15.9/dist/pnpm.cjs",
  ];
  const useInstalled = installedPaths.every((file) => existsSync(file));
  const observedPaths = useInstalled
    ? installedPaths.map((file) => realpathSync(file))
    : installedPaths.map((_, index) => {
        const file = path.join(root, `non-authority-tool-${index}`);
        writeFileSync(
          file,
          `// Non-authority role ${index} regular byte fixture.\n`,
          { mode: index < 3 ? 0o755 : 0o644 },
        );
        return file;
      });
  const roles = [
    "ENV",
    "NODE",
    "GIT",
    "COREPACK_SHIM",
    "COREPACK_LIB_COREPACK_CJS",
    "PNPM_SHIM",
    "PNPM_ENTRYPOINT",
  ];
  const sourceRoots = [
    ...new Set(observedPaths.map((file) => path.dirname(file))),
  ];
  const sources = observedPaths.map((file, i) =>
    api.observeMaterializationSource(
      { role: roles[i], path: file },
      sourceRoots,
    ),
  );
  const handoff = {
    schemaVersion: "organization-identity-materialization-handoff/v1",
    phaseABaseCommit: base,
    phaseACommit: a,
    phaseBCommit: null,
    approvedPlan: APPROVED_PLAN,
    approvedSpec: APPROVED_SPEC,
    sourceRoots,
    sources,
    reviewRoots: [out],
    reviews: { plan: null, phaseA: null, phaseB: null },
  };
  return { root, repo, out, api, handoff, useInstalled };
}

test("ordinary generation exposes acyclic preparation and request writing", () => {
  assert.equal(typeof packet.prepareLauncherMaterialization, "function");
  assert.equal(
    typeof packet.writeLauncherRootMaterializationRequestFile,
    "function",
  );
});

test("actual seven-source Phase A to B to candidate then whole-review request is acyclic and never root authority", async (t) => {
  const f = await fixture();
  // V8 reads source files after test teardown. Retain this uniquely named,
  // non-authority code fixture so coverage includes the committed execution.
  t.diagnostic(
    `Non-authority committed fixture: ${f.root}; actual installed seven sources: ${f.useInstalled}`,
  );
  const { api, repo, out } = f;
  const preparation = api.prepareLauncherMaterialization(f.handoff);
  assert.equal(
    preparation.status,
    "PHASE_A_PREPARED_NOT_AUTHORIZED",
    JSON.stringify(preparation),
  );
  assert.equal(
    digest(preparation.launcherContract),
    preparation.launcherContractSha256,
  );
  assert.equal(preparation.sourceToolClosure.length, 7);
  const oldContract = JSON.parse(readFileSync(path.join(repo, bPaths[3])));
  writeFileSync(
    path.join(repo, bPaths[3]),
    JSON.stringify(
      {
        ...oldContract,
        launcherContractSha256: preparation.launcherContractSha256,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    path.join(repo, bPaths[0]),
    readFileSync(path.join(repo, bPaths[0]), "utf8").replace(
      /const ACCEPTED_LAUNCHER_CONTRACT_SHA256\s*=\s*"[a-f0-9]{64}";/,
      `const ACCEPTED_LAUNCHER_CONTRACT_SHA256 = "${preparation.launcherContractSha256}";`,
    ),
  );
  runGit(repo, "add", "--", bPaths[0], bPaths[3]);
  runGit(
    repo,
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "test: non-authority Phase B fixture",
  );
  const b = runGit(repo, "rev-parse", "HEAD");
  const planSubjects = {
    approvedPlan: APPROVED_PLAN,
    approvedSpec: APPROVED_SPEC,
  };
  const aSubjects = {
    ...planSubjects,
    phaseABaseCommit: f.handoff.phaseABaseCommit,
    phaseACommit: f.handoff.phaseACommit,
    codeClosureSha256: preparation.codeClosureSha256,
  };
  const bSubjects = {
    ...aSubjects,
    phaseBCommit: b,
    launcherContractSha256: preparation.launcherContractSha256,
    bootstrapSha256: tuple(repo, b, bPaths[0]).sha256,
    bootstrapContractSha256: tuple(repo, b, bPaths[3]).sha256,
  };
  const handoff = {
    ...f.handoff,
    phaseBCommit: b,
    reviews: {
      plan: fixtureReview(out, "plan", planSubjects),
      phaseA: fixtureReview(out, "phaseA", aSubjects),
      phaseB: fixtureReview(out, "phaseB", bSubjects),
    },
  };
  const candidatePath = path.join(out, "candidate.json");
  const built = api.buildLauncherMaterializationPacket({
    handoff,
    outputPath: candidatePath,
  });
  assert.equal(
    built.status,
    "CANDIDATE_READY_NOT_AUTHORIZED",
    JSON.stringify(built),
  );
  assert.equal(
    built.packet.launcherContractSha256,
    preparation.launcherContractSha256,
  );
  assert.equal(built.packet.launcherFileCount, 4);
  assert.equal(
    api.validateLauncherMaterializationPacket(built.packet, handoff).status,
    built.status,
  );
  const written = api.writeLauncherMaterializationPacketFile({
    outputPath: candidatePath,
    packet: built.packet,
    handoff,
  });
  assert.equal(
    written.status,
    "CANDIDATE_WRITTEN_NOT_AUTHORIZED",
    JSON.stringify(written),
  );
  assert.deepEqual(JSON.parse(readFileSync(candidatePath)), built.packet);
  const fields = {
    handoff,
    candidate: descriptor(candidatePath),
    wholeReview: null,
    reviewReceiptPath: path.join(out, "receipt.json"),
  };
  assert.equal(
    api.buildLauncherRootMaterializationRequest(fields).status,
    "HOLD",
  );
  const prematurePath = path.join(out, "premature-request.json");
  assert.equal(
    api.writeLauncherRootMaterializationRequestFile({
      outputPath: prematurePath,
      fields,
    }).status,
    "HOLD",
  );
  assert.equal(existsSync(prematurePath), false);
  const wholeReview = fixtureReview(out, "whole", built.wholeReviewSubjects);
  const completeFields = { ...fields, wholeReview };
  const request = api.buildLauncherRootMaterializationRequest(completeFields);
  assert.equal(
    request.status,
    "READY_FOR_EXACT_AUTHORIZATION",
    JSON.stringify(request),
  );
  assert.equal(
    api.validateLauncherRootMaterializationRequest(
      request.request,
      built.packet,
      completeFields,
    ).status,
    request.status,
  );
  const requestPath = path.join(out, "request.json");
  const saved = api.writeLauncherRootMaterializationRequestFile({
    outputPath: requestPath,
    fields: completeFields,
  });
  assert.equal(
    saved.status,
    "READY_FOR_EXACT_AUTHORIZATION",
    JSON.stringify(saved),
  );
  assert.equal(saved.authority, "USER_EXACT_ROOT_AUTHORIZATION_STILL_REQUIRED");
  assert.equal(
    saved.receiptFile.sha256,
    request.request.launcherMaterializationPacketReviewReceiptSha256,
  );
  assert.equal(saved.requestFile.sha256, digest(request.request));
  assert.equal(
    api.writeLauncherRootMaterializationRequestFile({
      outputPath: requestPath,
      fields: completeFields,
    }).status,
    "HOLD",
  );

  const deny = (bad) => {
    const badPath = path.join(out, "denied.json");
    assert.equal(
      api.writeLauncherMaterializationPacketFile({
        outputPath: badPath,
        packet: built.packet,
        handoff: bad,
      }).status,
      "HOLD",
    );
    assert.equal(existsSync(badPath), false);
  };
  deny({ ...handoff, unexpected: true });
  deny({ ...handoff, phaseBCommit: handoff.phaseACommit });
  deny({ ...handoff, sourceRoots: [out] });
  deny({
    ...handoff,
    approvedPlan: { ...APPROVED_PLAN, sha256: "0".repeat(64) },
  });
  for (const key of [
    "sha256",
    "nlink",
    "uid",
    "gid",
    "ino",
    "dev",
    "mode",
    "size",
    "mtimeNs",
    "ctimeNs",
  ]) {
    deny({
      ...handoff,
      sources: handoff.sources.map((s, i) =>
        i
          ? s
          : {
              ...s,
              observation: {
                ...s.observation,
                [key]: `${s.observation[key]}1`,
              },
            },
      ),
    });
  }
  deny({
    ...handoff,
    reviews: { ...handoff.reviews, phaseA: handoff.reviews.plan },
  });
  const badPacket = {
    ...built.packet,
    bootstrapFilePlan: { ...built.packet.bootstrapFilePlan, size: 1 },
  };
  assert.equal(
    api.validateLauncherMaterializationPacket(badPacket, handoff).status,
    "HOLD",
  );
  const badCandidate = path.join(out, "candidate-hardlink.json");
  linkSync(candidatePath, badCandidate);
  assert.equal(
    api.buildLauncherRootMaterializationRequest({
      ...completeFields,
      candidate: descriptor(badCandidate),
    }).status,
    "HOLD",
  );
  unlinkSync(badCandidate);
  const badReport = wholeReview.report.path;
  writeFileSync(badReport, `${readFileSync(badReport, "utf8")}Critical: 0\n`);
  const duplicate = {
    ...completeFields,
    wholeReview: { ...wholeReview, report: descriptor(badReport) },
  };
  assert.equal(
    api.buildLauncherRootMaterializationRequest(duplicate).status,
    "HOLD",
  );
  assert.equal(
    api.buildLauncherRootMaterializationRequest(completeFields).status,
    "HOLD",
  );
  const cleanReview = fixtureReview(
    out,
    "whole",
    built.wholeReviewSubjects,
    "-again",
  );
  const narrow = fixtureReview(out, "phaseA", aSubjects, "-narrow");
  assert.equal(
    api.buildLauncherRootMaterializationRequest({
      ...completeFields,
      wholeReview: narrow,
    }).status,
    "HOLD",
  );
  const wrongSubjects = fixtureReview(
    out,
    "whole",
    { ...built.wholeReviewSubjects, phaseBCommit: handoff.phaseACommit },
    "-stale",
  );
  assert.equal(
    api.buildLauncherRootMaterializationRequest({
      ...completeFields,
      wholeReview: wrongSubjects,
    }).status,
    "HOLD",
  );
  writeFileSync(cleanReview.counterexamples.path, "changed counterexamples");
  assert.equal(
    api.buildLauncherRootMaterializationRequest({
      ...completeFields,
      wholeReview: cleanReview,
    }).status,
    "HOLD",
  );
  const linkedParent = path.join(out, "linked-parent");
  symlinkSync(out, linkedParent);
  assert.equal(
    api.writeLauncherMaterializationPacketFile({
      outputPath: path.join(linkedParent, "no.json"),
      packet: built.packet,
      handoff,
    }).status,
    "HOLD",
  );
  assert.equal(existsSync(path.join(out, "no.json")), false);
  const frozenGenerator = readFileSync(path.join(repo, aPaths[0]));
  writeFileSync(path.join(repo, aPaths[0]), "// drift\n", { flag: "a" });
  deny(handoff);
  runGit(repo, "add", "--", aPaths[0]);
  runGit(
    repo,
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "test: forbidden intermediate Phase B source drift",
  );
  writeFileSync(path.join(repo, aPaths[0]), frozenGenerator);
  runGit(repo, "add", "--", aPaths[0]);
  runGit(
    repo,
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-m",
    "test: restore source cannot erase intermediate drift",
  );
  const badB = { ...handoff, phaseBCommit: runGit(repo, "rev-parse", "HEAD") };
  assert.equal(
    api.buildLauncherMaterializationPacket({
      handoff: badB,
      outputPath: path.join(out, "intermediate.json"),
    }).code,
    "PHASE_B_SCOPE_INVALID",
  );
  deny(badB);
  assert.equal(existsSync(built.packet.launcherRoot), false);
});

test("only explicit approved system ENV source permits hard links; destinations and generic files remain strict", (t) => {
  if (!existsSync("/usr/lib/cargo/bin/coreutils/env")) {
    t.skip(
      "The narrowly approved installed system ENV source is absent on this host",
    );
    return;
  }
  const env = realpathSync("/usr/bin/env");
  const roots = [path.dirname(env)];
  const observed = packet.observeMaterializationSource(
    { role: "ENV", path: env },
    roots,
  );
  assert.equal(observed.role, "ENV", JSON.stringify(observed));
  assert.ok(BigInt(observed.observation.nlink) > 1n);
  assert.equal(
    packet.observeMaterializationSource({ role: "NODE", path: env }, roots)
      .status,
    "HOLD",
  );
  assert.equal(
    packet.observeMaterializationSource({ role: "ENV", path: env }, [
      "/usr/lib/cargo/bin",
    ]).status,
    "HOLD",
  );
  assert.equal(
    verifyMaterializationFile(env, descriptor(env), roots).status,
    "HOLD",
  );
  const root = mkdtempSync(
    path.join(tmpdir(), "identity-hardlink-nonauthority-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, "env");
  const second = path.join(root, "linked-env");
  writeFileSync(first, "fixture", { mode: 0o755 });
  linkSync(first, second);
  assert.equal(
    packet.observeMaterializationSource({ role: "ENV", path: second }, [root])
      .status,
    "HOLD",
  );
  assert.equal(verifyMaterializationDestinations([second]).status, "HOLD");
});
