import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMIT,
  OUTPUT_ROOT,
  REQUEST_ROOT,
  SHA,
  SHA_B,
  SHA_C,
} from "./governance-organization-identity-test-fixtures.mjs";
import { APPROVED_PLAN } from "./governance-organization-identity-launcher.mjs";

import {
  buildLauncherMaterializationPacket,
  buildLauncherMaterializationPacketReviewReceipt,
  buildLauncherRootMaterializationRequest,
  validateLauncherMaterializationPacket,
  validateLauncherMaterializationPacketReviewReceipt,
  validateLauncherRootMaterializationRequest,
} from "./governance-organization-identity-root-materialization-packet.mjs";

test("packet current schemas reject historical versions and bind the current plan tuple", () => {
  const packet = buildLauncherMaterializationPacket({
    subjectCommit: COMMIT,
    outputPath: "/tmp/task-0L-root-materialization-packet-v4.json",
  });
  assert.equal(validateLauncherMaterializationPacket(packet).status, "PASS");
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

test("packet review and root request are non-circular and exact-key", () => {
  const packet = buildLauncherMaterializationPacket({
    subjectCommit: COMMIT,
    outputPath: "/tmp/task-0L-root-materialization-packet-v4.json",
  });
  const packetSha256 = SHA;
  const review = buildLauncherMaterializationPacketReviewReceipt({
    launcherMaterializationPacketSha256: packetSha256,
    generatorCommit: COMMIT,
    generatorBlobId: "1".repeat(40),
    generatorSha256: SHA_B,
    generatorSpecCommit: COMMIT,
    generatorSpecBlobId: "2".repeat(40),
    generatorSpecSha256: SHA_C,
    reportSha256: SHA,
    counterexampleSetSha256: SHA_B,
  });
  assert.equal(
    validateLauncherMaterializationPacketReviewReceipt(review).status,
    "PASS",
  );
  const request = buildLauncherRootMaterializationRequest({
    subjectCommit: COMMIT,
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
  assert.equal(
    validateLauncherRootMaterializationRequest({
      ...request,
      scopeSha256: null,
    }).status,
    "INTEGRITY_ERROR",
  );
});
