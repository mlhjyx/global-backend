import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  OUTPUT_ROOT,
  REQUEST_ROOT,
  SHA,
  SHA_B,
  SHA_C,
  TOOL_ROOT,
} from "./governance-organization-identity-test-fixtures.mjs";
import {
  APPROVED_PLAN,
  canonicalJsonBytes,
  renderRootWrapper,
} from "./governance-organization-identity-launcher.mjs";
import { inspectMaterializationPacketFacts } from "./governance-organization-identity-materialization-preflight.mjs";

import {
  buildDiagnosticLauncherMaterializationPacket as buildLauncherMaterializationPacket,
  buildDiagnosticLauncherMaterializationPacketReviewReceipt as buildLauncherMaterializationPacketReviewReceipt,
  buildDiagnosticLauncherRootMaterializationRequest as buildLauncherRootMaterializationRequest,
  ROOT_MATERIALIZATION_PACKET_PATHS,
  validateLauncherMaterializationPacketStructure as validateLauncherMaterializationPacket,
  validateLauncherMaterializationPacketReviewReceiptStructure as validateLauncherMaterializationPacketReviewReceipt,
  validateLauncherRootMaterializationRequestStructure as validateLauncherRootMaterializationRequest,
  validateLauncherMaterializationPacket as executableReadiness,
  validateLauncherMaterializationPacketReviewReceipt as executableReviewReadiness,
  validateLauncherRootMaterializationRequest as executableRequestReadiness,
  buildLauncherMaterializationPacket as ordinaryPacketBuilder,
  buildLauncherRootMaterializationRequest as ordinaryRequestBuilder,
  writeLauncherMaterializationPacketFile,
} from "./governance-organization-identity-root-materialization-packet.mjs";

const PHASE_A_SUBJECT = "61384076273feddcb4c5b5309d4b46902dc50e5c";
const PHASE_B_SUBJECT = "56fde9df9448377f3ce6454ae12e332d2ccde946";
const LAUNCHER_CONTRACT_SHA256 =
  "3c71df7989da6312f0498bc8908ff07a581121fb24d03ab1e6ed36b0e2342292";

function gitIdentity(commit, filePath) {
  const objectName = `${commit}:${filePath}`;
  const blobId = execFileSync("git", ["rev-parse", objectName], {
    encoding: "utf8",
  }).trim();
  const bytes = execFileSync("git", ["cat-file", "blob", objectName]);
  return {
    path: filePath,
    commit,
    blobId,
    sha256: shaBuffer(bytes),
    size: bytes.length,
  };
}

function shaBuffer(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function artifactHandoff(overrides = {}) {
  const handoff = {
    plan: gitIdentity(
      APPROVED_PLAN.commit,
      ROOT_MATERIALIZATION_PACKET_PATHS.plan,
    ),
    spec: gitIdentity(
      "b060c5dd4afef9fe42dfe510b02f930f56cdf7fe",
      ROOT_MATERIALIZATION_PACKET_PATHS.spec,
    ),
    launcher: gitIdentity(
      PHASE_A_SUBJECT,
      ROOT_MATERIALIZATION_PACKET_PATHS.launcher,
    ),
    bootstrap: gitIdentity(
      PHASE_B_SUBJECT,
      ROOT_MATERIALIZATION_PACKET_PATHS.bootstrap,
    ),
    bootstrapContract: gitIdentity(
      PHASE_B_SUBJECT,
      ROOT_MATERIALIZATION_PACKET_PATHS.bootstrapContract,
    ),
    generator: gitIdentity(
      PHASE_A_SUBJECT,
      ROOT_MATERIALIZATION_PACKET_PATHS.generator,
    ),
    generatorSpec: gitIdentity(
      PHASE_A_SUBJECT,
      ROOT_MATERIALIZATION_PACKET_PATHS.generatorSpec,
    ),
    ...overrides,
  };
  return Object.freeze(
    Object.fromEntries(
      Object.entries(handoff).map(([key, value]) => [
        key,
        Object.freeze(value),
      ]),
    ),
  );
}

function roundTrip(value) {
  return JSON.parse(canonicalJsonBytes(value));
}

function validPacket(overrides = {}) {
  return buildLauncherMaterializationPacket({
    subjectCommit: PHASE_A_SUBJECT,
    phaseASubjectCommit: PHASE_A_SUBJECT,
    phaseBSubjectCommit: PHASE_B_SUBJECT,
    artifactHandoff: artifactHandoff(),
    outputPath: "/tmp/task-0L-root-materialization-packet-v4.json",
    ...overrides,
  });
}

function rehashPacket(packet) {
  const launcherContractSha256 = createPacketDigest(packet.launcherContract);
  return {
    ...packet,
    launcherContractSha256,
    contractFilePlan: {
      ...packet.contractFilePlan,
      sha256: launcherContractSha256,
      size: canonicalJsonBytes(packet.launcherContract).length,
    },
  };
}

function createPacketDigest(value) {
  return createHash("sha256").update(canonicalJsonBytes(value)).digest("hex");
}

function pathDigest(value) {
  return createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
}

function requestScopeDigest(request) {
  return createPacketDigest({
    authorizationClass: request.authorizationClass,
    subjectCommit: request.subjectCommit,
    launcherMaterializationPacketSha256:
      request.launcherMaterializationPacketSha256,
    launcherMaterializationPacketReviewReceiptSha256:
      request.launcherMaterializationPacketReviewReceiptSha256,
    launcherContractSha256: request.launcherContractSha256,
    sourceToolClosureSha256: request.sourceToolClosureSha256,
    materializedExecutableClosureSha256:
      request.materializedExecutableClosureSha256,
    launcherFileCount: request.launcherFileCount,
    toolRootFileCount: request.toolRootFileCount,
    runtimeRootCount: request.runtimeRootCount,
    requestRootCount: request.requestRootCount,
    outputRootCount: request.outputRootCount,
    launcherRoot: request.launcherRoot,
    toolRoot: request.toolRoot,
    runtimeRoot: request.runtimeRoot,
    requestRoot: request.requestRoot,
    outputRoot: request.outputRoot,
    chronology: request.chronology,
    targetMustBeAbsent: request.targetMustBeAbsent,
    containsCredentialValue: request.containsCredentialValue,
  });
}

function rehashRequest(request) {
  const scoped = { ...request, scopeSha256: requestScopeDigest(request) };
  const { requestId, ...withoutRequestId } = scoped;
  return { ...scoped, requestId: createPacketDigest(withoutRequestId) };
}

test("recovery: synthetic packet cannot obtain executable readiness or a written packet", async (t) => {
  const packet = validPacket();
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "identity-recovery-red-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  assert.equal(
    executableReadiness(packet).code,
    "SOURCE_UNAVAILABLE_OR_UNSAFE",
  );
  assert.notEqual(
    ordinaryPacketBuilder({
      subjectCommit: PHASE_A_SUBJECT,
      phaseBSubjectCommit: PHASE_B_SUBJECT,
    }).schemaVersion,
    packet.schemaVersion,
  );
  assert.notEqual(
    ordinaryRequestBuilder({ launcherMaterializationPacket: packet }).status,
    "PASS",
  );
  assert.notEqual(
    (
      await writeLauncherMaterializationPacketFile({
        outputPath: path.join(fixtureRoot, "packet.json"),
        packet,
      })
    ).status,
    "PASS",
  );
});

test("recovery: a fabricated receipt cannot claim independent review", () => {
  const packet = validPacket();
  const receipt = buildLauncherMaterializationPacketReviewReceipt({
    launcherMaterializationPacketSha256: createPacketDigest(packet),
    ...packet.approvedArtifacts,
    reportSha256: SHA,
    counterexampleSetSha256: SHA_B,
  });
  assert.equal(
    executableReviewReadiness(receipt, packet).code,
    "FULL_REVIEW_BYTE_REFERENCES_REQUIRED",
  );
});

test("recovery: actual source and planned bytes still reject the stale executing generator", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "identity-real-packet-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const historical = validPacket();
  const sources = await Promise.all(
    historical.sourceToolClosure.map(async (source, index) => {
      const sourceExecutablePath = path.join(root, `tool-${index}`);
      const bytes = Buffer.from(`real local executable fixture ${index}\n`);
      await writeFile(sourceExecutablePath, bytes, { mode: source.sourceMode });
      return {
        ...source,
        sourceExecutablePath,
        sourceExecutablePathSha256: pathDigest(sourceExecutablePath),
        sourceRealpathSha256: pathDigest(sourceExecutablePath),
        sourceSha256: shaBuffer(bytes),
        sourceSize: bytes.length,
      };
    }),
  );
  const candidate = validPacket({ sourceToolClosure: sources });
  assert.equal(executableReadiness(candidate).code, "PLANNED_BYTES_MISMATCH");
  const wrapper = Buffer.from(
    renderRootWrapper({
      envPath: `${candidate.toolRoot}/bin/env`,
      environment: candidate.runtimeEnvironment,
      nodePath: `${candidate.toolRoot}/bin/node`,
      launcherPath: `${candidate.launcherRoot}/identity-writer-launch.mjs`,
    }),
  );
  const launcher = execFileSync("git", [
    "cat-file",
    "blob",
    `${PHASE_A_SUBJECT}:${ROOT_MATERIALIZATION_PACKET_PATHS.launcher}`,
  ]);
  const bootstrap = execFileSync("git", [
    "cat-file",
    "blob",
    `${PHASE_B_SUBJECT}:${ROOT_MATERIALIZATION_PACKET_PATHS.bootstrap}`,
  ]);
  const planned = (entry, bytes) => ({
    ...entry,
    sha256: shaBuffer(bytes),
    size: bytes.length,
  });
  const launcherFilePlan = [
    planned(candidate.launcherFilePlan[0], wrapper),
    planned(candidate.launcherFilePlan[1], launcher),
  ];
  const packet = rehashPacket({
    ...candidate,
    launcherFilePlan,
    launcherContract: { ...candidate.launcherContract, launcherFilePlan },
    bootstrapFilePlan: planned(candidate.bootstrapFilePlan, bootstrap),
  });
  assert.equal(
    inspectMaterializationPacketFacts(packet).code,
    "EXECUTING_GENERATOR_MISMATCH",
  );
  assert.notEqual(executableReadiness(packet).status, "PASS");
});

test("packet current schemas reject historical versions and bind the current plan tuple", () => {
  const packet = validPacket();
  assert.equal(validateLauncherMaterializationPacket(packet).status, "PASS");
  assert.equal(
    validateLauncherMaterializationPacket(roundTrip(packet)).status,
    "PASS",
  );
  assert.equal(
    packet.schemaVersion,
    "organization-identity-launcher-materialization-packet/v4",
  );
  assert.equal(packet.subjectCommit, PHASE_A_SUBJECT);
  assert.equal(packet.phaseASubjectCommit, PHASE_A_SUBJECT);
  assert.equal(packet.phaseBSubjectCommit, PHASE_B_SUBJECT);
  assert.equal(packet.launcherContractSha256, LAUNCHER_CONTRACT_SHA256);
  assert.equal(packet.approvedArtifacts.planCommit, APPROVED_PLAN.commit);
  assert.equal(packet.approvedArtifacts.planBlobId, APPROVED_PLAN.blobId);
  assert.equal(packet.approvedArtifacts.planSha256, APPROVED_PLAN.sha256);
  assert.equal(
    packet.sourceToolClosureSha256,
    createPacketDigest(packet.sourceToolClosure),
  );
  assert.equal(
    packet.materializedExecutableClosureSha256,
    createPacketDigest(packet.materializedExecutableClosure),
  );
  assert.equal(
    validateLauncherMaterializationPacket({
      ...packet,
      schemaVersion: "organization-identity-launcher-materialization-packet/v3",
    }).status,
    "INTEGRITY_ERROR",
  );
});

test("packet artifact provenance separates Phase A launcher/generator from reviewed Phase B bootstrap", () => {
  const packet = validPacket();
  const expected = artifactHandoff();
  assert.equal(packet.approvedArtifacts.launcherCommit, PHASE_A_SUBJECT);
  assert.equal(packet.approvedArtifacts.generatorCommit, PHASE_A_SUBJECT);
  assert.equal(packet.approvedArtifacts.generatorSpecCommit, PHASE_A_SUBJECT);
  assert.equal(packet.approvedArtifacts.bootstrapCommit, PHASE_B_SUBJECT);
  assert.equal(
    packet.approvedArtifacts.bootstrapContractCommit,
    PHASE_B_SUBJECT,
  );
  for (const [prefix, identity] of Object.entries(expected)) {
    assert.equal(packet.approvedArtifacts[`${prefix}Commit`], identity.commit);
    assert.equal(packet.approvedArtifacts[`${prefix}BlobId`], identity.blobId);
    assert.equal(packet.approvedArtifacts[`${prefix}Sha256`], identity.sha256);
    assert.equal(packet.approvedArtifacts[`${prefix}Size`], identity.size);
  }
  assert.equal(
    packet.launcherContract.approvedLauncher.commit,
    packet.approvedArtifacts.launcherCommit,
  );
  assert.equal(
    packet.launcherContract.approvedLauncher.blobId,
    packet.approvedArtifacts.launcherBlobId,
  );
  assert.equal(
    validateLauncherMaterializationPacket(roundTrip(packet)).status,
    "PASS",
  );
});

test("packet rejects subject, source identity, root, and duplicated subtree drift", () => {
  const packet = validPacket();
  const phaseABootstrap = gitIdentity(
    PHASE_A_SUBJECT,
    ROOT_MATERIALIZATION_PACKET_PATHS.bootstrap,
  );
  const invalidPackets = [
    { ...packet, subjectCommit: "9".repeat(40) },
    { ...packet, phaseASubjectCommit: PHASE_B_SUBJECT },
    { ...packet, phaseBSubjectCommit: PHASE_A_SUBJECT },
    {
      ...packet,
      approvedArtifacts: {
        ...packet.approvedArtifacts,
        launcherCommit: "9".repeat(40),
      },
    },
    {
      ...packet,
      approvedArtifacts: {
        ...packet.approvedArtifacts,
        generatorCommit: "9".repeat(40),
      },
    },
    {
      ...packet,
      approvedArtifacts: {
        ...packet.approvedArtifacts,
        generatorSpecCommit: "9".repeat(40),
      },
    },
    {
      ...packet,
      approvedArtifacts: {
        ...packet.approvedArtifacts,
        bootstrapCommit: PHASE_A_SUBJECT,
        bootstrapBlobId: phaseABootstrap.blobId,
        bootstrapSha256: phaseABootstrap.sha256,
        bootstrapSize: phaseABootstrap.size,
      },
    },
    {
      ...packet,
      approvedArtifacts: {
        ...packet.approvedArtifacts,
        bootstrapBlobId: phaseABootstrap.blobId,
      },
    },
    {
      ...packet,
      approvedArtifacts: {
        ...packet.approvedArtifacts,
        bootstrapContractCommit: PHASE_A_SUBJECT,
      },
    },
    rehashPacket({
      ...packet,
      launcherContract: {
        ...packet.launcherContract,
        approvedLauncher: {
          ...packet.launcherContract.approvedLauncher,
          blobId: "9".repeat(40),
          sha256: "9".repeat(64),
        },
      },
    }),
    {
      ...packet,
      launcherFilePlan: [
        {
          ...packet.launcherFilePlan[0],
          basename: "identity-writer-bootstrap.mjs",
        },
        ...packet.launcherFilePlan.slice(1),
      ],
    },
    {
      ...packet,
      runtimeEnvironment: {
        ...packet.runtimeEnvironment,
        PATH: "/usr/bin:/bin",
      },
    },
    { ...packet, launcherRoot: "/tmp/other-launcher" },
    buildLauncherMaterializationPacket({
      subjectCommit: PHASE_A_SUBJECT,
      phaseASubjectCommit: PHASE_A_SUBJECT,
      phaseBSubjectCommit: PHASE_B_SUBJECT,
      artifactHandoff: artifactHandoff({
        bootstrap: {
          ...gitIdentity(
            PHASE_B_SUBJECT,
            ROOT_MATERIALIZATION_PACKET_PATHS.bootstrap,
          ),
          path: ROOT_MATERIALIZATION_PACKET_PATHS.launcher,
        },
      }),
    }),
    buildLauncherMaterializationPacket({
      subjectCommit: PHASE_A_SUBJECT,
      phaseASubjectCommit: PHASE_A_SUBJECT,
      phaseBSubjectCommit: PHASE_B_SUBJECT,
      artifactHandoff: artifactHandoff({
        generator: {
          ...gitIdentity(
            PHASE_A_SUBJECT,
            ROOT_MATERIALIZATION_PACKET_PATHS.generator,
          ),
          sha256: SHA_C,
        },
      }),
    }),
  ];
  for (const candidate of invalidPackets) {
    assert.equal(
      validateLauncherMaterializationPacket(candidate).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("packet source tool closure rejects ambient paths and seven-role mismatches", () => {
  const packet = validPacket();
  const source = packet.sourceToolClosure;
  const invalidPackets = [
    {
      ...packet,
      sourceToolClosure: [
        { ...source[0], sourceExecutablePath: "node" },
        ...source.slice(1),
      ],
    },
    ...[
      ["sourceExecutablePathSha256", "9".repeat(64)],
      [
        "sourceExecutablePath",
        `${TOOL_ROOT}/bin/env`,
        "sourceExecutablePathSha256",
        pathDigest(`${TOOL_ROOT}/bin/env`),
      ],
      ["sourcePathKind", "SYMLINK"],
      ["sourceSha256", "9".repeat(64)],
      ["role", "NODE"],
    ].map(([key, value, extraKey, extraValue]) => ({
      ...packet,
      sourceToolClosure: [
        {
          ...source[0],
          [key]: value,
          ...(extraKey ? { [extraKey]: extraValue } : {}),
        },
        ...source.slice(1),
      ],
    })),
  ];
  invalidPackets.push(
    { ...packet, sourceToolClosure: source.slice(0, -1) },
    { ...packet, sourceToolClosure: [...source].reverse() },
    { ...packet, sourceToolClosureSha256: SHA_C },
    { ...packet, materializedExecutableClosureSha256: SHA_C },
    {
      ...packet,
      materializedExecutableClosure: [
        {
          ...packet.materializedExecutableClosure[0],
          role: "NODE",
        },
        ...packet.materializedExecutableClosure.slice(1),
      ],
    },
  );
  for (const candidate of invalidPackets) {
    assert.equal(
      validateLauncherMaterializationPacket(candidate).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("packet review and root request are non-circular, exact-key, and substitution-safe", () => {
  const packet = validPacket();
  const packetSha256 =
    validateLauncherMaterializationPacket(
      packet,
    ).launcherMaterializationPacketSha256;
  const review = buildLauncherMaterializationPacketReviewReceipt({
    launcherMaterializationPacketSha256: packetSha256,
    generatorCommit: packet.approvedArtifacts.generatorCommit,
    generatorBlobId: packet.approvedArtifacts.generatorBlobId,
    generatorSha256: packet.approvedArtifacts.generatorSha256,
    generatorSpecCommit: packet.approvedArtifacts.generatorSpecCommit,
    generatorSpecBlobId: packet.approvedArtifacts.generatorSpecBlobId,
    generatorSpecSha256: packet.approvedArtifacts.generatorSpecSha256,
    reportSha256: SHA,
    counterexampleSetSha256: SHA_B,
  });
  assert.equal(
    validateLauncherMaterializationPacketReviewReceipt(review, packet).status,
    "PASS",
  );
  for (const candidate of [
    { ...review, launcherMaterializationPacketSha256: SHA_C },
    { ...review, generatorSha256: SHA_C },
    { ...review, generatorSpecBlobId: "9".repeat(40) },
    { ...review, reportSha256: review.counterexampleSetSha256 },
    { ...review, critical: 1 },
    { ...review, packet },
  ]) {
    assert.equal(
      validateLauncherMaterializationPacketReviewReceipt(candidate, packet)
        .status,
      "INTEGRITY_ERROR",
    );
  }
  const request = buildLauncherRootMaterializationRequest({
    subjectCommit: PHASE_A_SUBJECT,
    launcherMaterializationPacketPath:
      "/tmp/task-0L-root-materialization-packet-v4.json",
    launcherMaterializationPacketSha256: packetSha256,
    launcherMaterializationPacketReviewReceiptPath:
      "/tmp/task-0L-root-materialization-packet-v4-review.json",
    launcherMaterializationPacketReviewReceiptSha256: SHA_B,
    launcherMaterializationPacket: packet,
    launcherRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher",
    toolRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root",
    runtimeRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime",
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
  });
  assert.equal(request.launcherContractSha256, packet.launcherContractSha256);
  assert.equal(request.sourceToolClosureSha256, packet.sourceToolClosureSha256);
  assert.equal(
    request.materializedExecutableClosureSha256,
    packet.materializedExecutableClosureSha256,
  );
  assert.equal(
    validateLauncherRootMaterializationRequest(request, packet).status,
    "PASS",
  );
  assert.notEqual(
    executableRequestReadiness(roundTrip(request), roundTrip(packet)).status,
    "PASS",
  );
  assert.equal(
    validateLauncherRootMaterializationRequest(
      rehashRequest({
        ...request,
        sourceToolClosureSha256: SHA,
        materializedExecutableClosureSha256: SHA_C,
      }),
      packet,
    ).status,
    "INTEGRITY_ERROR",
  );
  for (const candidate of [
    { ...request, scopeSha256: null },
    { ...request, requestId: SHA },
    { ...request, launcherFileCount: 3 },
    { ...request, targetMustBeAbsent: false },
    { ...request, containsCredentialValue: true },
    { ...request, launcherRoot: "/tmp/launcher" },
    { ...request, extra: "field" },
  ]) {
    assert.equal(
      validateLauncherRootMaterializationRequest(candidate, packet).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("ordinary packet writer rejects historical synthetic diagnostics without creating output", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "identity-packet-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const outputPath = path.join(fixtureRoot, "packet-v4.json");
  const packet = validPacket();
  const written = await writeLauncherMaterializationPacketFile({
    outputPath,
    packet,
  });
  assert.notEqual(written.status, "PASS");
  await assert.rejects(readFile(outputPath), { code: "ENOENT" });
  assert.equal(
    (
      await writeLauncherMaterializationPacketFile({
        outputPath,
        packet,
      })
    ).status,
    "HOLD",
  );
  assert.equal(
    (
      await writeLauncherMaterializationPacketFile({
        outputPath: "packet-v4.json",
        packet,
      })
    ).status,
    "INTEGRITY_ERROR",
  );
});
