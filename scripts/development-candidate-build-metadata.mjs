// Build-time metadata only. Owner approval is checked by the protected CI
// driver before this file is supplied; the signed external OCI statement is
// checked again by deployment admission. This file alone grants no trust.
import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readCandidateInput } from "./development-candidate-input.mjs";

export function installCandidateBuildMetadata({
  source,
  output,
  buildSha,
  candidateMode,
}) {
  const fail = () => {
    throw new Error("CANDIDATE_BUILD_METADATA_INVALID");
  };
  if (!["", "1"].includes(candidateMode) || existsSync(output)) fail();
  if (candidateMode === "") {
    if (existsSync(source)) fail();
    return;
  }
  const marker = JSON.parse(readCandidateInput(source, 16_384, "CANDIDATE_BUILD_METADATA_INVALID").toString("utf8"));
  const fields = [
    "schemaVersion",
    "candidateCommit",
    "trustedWorkflowCommit",
    "authorizationSha256",
    "instanceManifestSha256",
    "instanceId",
    "workspaceIds",
    "validUntil",
  ];
  if (
    !marker ||
    Object.keys(marker).sort().join(",") !== fields.sort().join(",") ||
    marker.schemaVersion !== "development-candidate-marker/v1" ||
    marker.candidateCommit !== buildSha ||
    !/^[0-9a-f]{40}$/u.test(buildSha) ||
    !/^[0-9a-f]{40}$/u.test(marker.trustedWorkflowCommit) ||
    !/^[0-9a-f]{64}$/u.test(marker.authorizationSha256) ||
    !/^[0-9a-f]{64}$/u.test(marker.instanceManifestSha256) ||
    typeof marker.instanceId !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/u.test(marker.instanceId) ||
    !Array.isArray(marker.workspaceIds) ||
    marker.workspaceIds.length !== 2 ||
    new Set(marker.workspaceIds).size !== 2 ||
    !marker.workspaceIds.every((id) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
        id,
      ),
    ) ||
    !Number.isFinite(Date.parse(marker.validUntil)) ||
    Date.parse(marker.validUntil) <= Date.now()
  )
    fail();
  writeFileSync(output, JSON.stringify(marker) + "\n", {
    flag: "wx",
    mode: 0o644,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  if (process.argv.length !== 6)
    throw new Error("CANDIDATE_BUILD_METADATA_ARGUMENTS_INVALID");
  installCandidateBuildMetadata({
    source: process.argv[2],
    output: process.argv[3],
    buildSha: process.argv[4],
    candidateMode: process.argv[5],
  });
}
