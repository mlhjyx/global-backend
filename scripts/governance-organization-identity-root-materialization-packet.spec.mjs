import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
} from "./governance-organization-identity-launcher.mjs";

import {
  buildLauncherMaterializationPacket,
  buildLauncherMaterializationPacketReviewReceipt,
  buildLauncherRootMaterializationRequest,
  validateLauncherMaterializationPacket,
  validateLauncherMaterializationPacketReviewReceipt,
  validateLauncherRootMaterializationRequest,
  writeLauncherMaterializationPacketFile,
} from "./governance-organization-identity-root-materialization-packet.mjs";

const SUBJECT = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();

function roundTrip(value) {
  return JSON.parse(canonicalJsonBytes(value));
}

function validPacket(overrides = {}) {
  return buildLauncherMaterializationPacket({
    subjectCommit: SUBJECT,
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
  assert.equal(packet.approvedArtifacts.planCommit, APPROVED_PLAN.commit);
  assert.equal(packet.approvedArtifacts.planBlobId, APPROVED_PLAN.blobId);
  assert.equal(packet.approvedArtifacts.planSha256, APPROVED_PLAN.sha256);
  assert.equal(
    validateLauncherMaterializationPacket({
      ...packet,
      schemaVersion: "organization-identity-launcher-materialization-packet/v3",
    }).status,
    "INTEGRITY_ERROR",
  );
});

test("packet rejects subject, source identity, root, and duplicated subtree drift", () => {
  const packet = validPacket();
  const invalidPackets = [
    { ...packet, subjectCommit: "9".repeat(40) },
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
        bootstrapCommit: "9".repeat(40),
      },
    },
    {
      ...packet,
      approvedArtifacts: {
        ...packet.approvedArtifacts,
        bootstrapContractCommit: "9".repeat(40),
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
    subjectCommit: SUBJECT,
    launcherMaterializationPacketPath:
      "/tmp/task-0L-root-materialization-packet-v4.json",
    launcherMaterializationPacketSha256: packetSha256,
    launcherMaterializationPacketReviewReceiptPath:
      "/tmp/task-0L-root-materialization-packet-v4-review.json",
    launcherMaterializationPacketReviewReceiptSha256: SHA_B,
    launcherContractSha256: SHA_C,
    sourceToolClosureSha256: SHA,
    materializedExecutableClosureSha256: SHA_B,
    launcherRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/launcher",
    toolRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/tool-root",
    runtimeRoot:
      "/global/backups/backend-root-reconciliation-20260826/successors/identity-writer-b0-v2/runtime",
    requestRoot: REQUEST_ROOT,
    outputRoot: OUTPUT_ROOT,
  });
  assert.equal(
    validateLauncherRootMaterializationRequest(request).status,
    "PASS",
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
      validateLauncherRootMaterializationRequest(candidate).status,
      "INTEGRITY_ERROR",
    );
  }
});

test("packet output writer is canonical and create-exclusive", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "identity-packet-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const outputPath = path.join(fixtureRoot, "packet-v4.json");
  const packet = validPacket();
  const written = await writeLauncherMaterializationPacketFile({
    outputPath,
    packet,
  });
  assert.equal(written.status, "PASS");
  assert.deepEqual(
    JSON.parse(await readFile(outputPath, "utf8")),
    roundTrip(packet),
  );
  assert.equal(
    (
      await writeLauncherMaterializationPacketFile({
        outputPath,
        packet,
      })
    ).status,
    "INTEGRITY_ERROR",
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
