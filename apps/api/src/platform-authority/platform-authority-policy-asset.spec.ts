import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_AUTHORITY_POLICY_PROVENANCE,
  loadVerifiedPlatformAuthorityPolicyAsset,
  verifyPlatformAuthorityPolicyAsset,
} from "./platform-authority-policy-asset";

const EXPECTED_ARTIFACT_SHA256 =
  "248a416e72a8c2590a5c6c8adb941f4105c6ac3e722bc85ced3a77f404784fa1";
const EXPECTED_ROW_IDS = [
  "platform.acquisition/acq-sweep",
  "platform.acquisition/patents-cache-refresh",
  "platform.intent_watch/intent-sweep",
  "platform.sanctions/sanctions-refresh",
] as const;

function importedArtifactBytes(): Buffer {
  return readFileSync(
    resolve(__dirname, "platform-authority-policy-matrix-v1.json"),
  );
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("GrowthOS-owned platform authority policy asset", () => {
  it("loads the exact four-row candidate-deny asset and bounded source provenance", () => {
    const loaded = loadVerifiedPlatformAuthorityPolicyAsset();

    expect(loaded.byteLength).toBe(3121);
    expect(loaded.sha256).toBe(EXPECTED_ARTIFACT_SHA256);
    expect(loaded.policy.rows.map((row) => row.row_id)).toEqual(
      EXPECTED_ROW_IDS,
    );
    expect(loaded.policy.rows.map((row) => row.candidate.mode)).toEqual(
      Array(4).fill("candidate_deny"),
    );
    expect(
      loaded.policy.rows.map((row) => row.temporal_observation.status),
    ).toEqual(Array(4).fill("UNKNOWN"));
    expect(loaded.policy.rows[1]?.candidate.reason).toBe("disabled_no_egress");
    expect(loaded.provenance).toEqual({
      schema_version: "growthos-platform-authority-policy-provenance/v1",
      artifact: {
        path: "ops/policy/platform-authority-policy-matrix-v1.json",
        sha256: EXPECTED_ARTIFACT_SHA256,
      },
      authority: {
        commit_sha: "290c6f9f6a41c7c39dfe071683252982536937d8",
        tree_sha: "3d04b799ed8f87fa5d9b71ff003f2cd2eb822289",
        patch_blob_sha: "40dc2fe631470827fdf9ea5ddc9d6fdbcaf144d2",
      },
      source: {
        archive_sha256:
          "5906e7a287843c7bafd8d7bb20aa930d1ae97eb6cf2946110d27ecc3a5dfc75a",
        patch_stack_sha256:
          "ced29b101ad1ff88b875f41a726fc988160eccc6d36526034be271f77f500fff",
      },
    });
    expectDeepFrozen(loaded);
  });

  it.each([
    ["authority commit", ["authority", "commit_sha"], "0".repeat(40)],
    ["authority tree", ["authority", "tree_sha"], "0".repeat(40)],
    ["patch blob", ["authority", "patch_blob_sha"], "0".repeat(40)],
    ["source archive", ["source", "archive_sha256"], "0".repeat(64)],
    ["patch stack", ["source", "patch_stack_sha256"], "0".repeat(64)],
    ["artifact path", ["artifact", "path"], "other.json"],
    ["artifact digest", ["artifact", "sha256"], "0".repeat(64)],
  ] as const)("rejects %s provenance drift", (_label, path, replacement) => {
    const provenance = structuredClone(
      PLATFORM_AUTHORITY_POLICY_PROVENANCE,
    ) as Record<string, Record<string, string>>;
    provenance[path[0]]![path[1]!] = replacement;

    expect(() =>
      verifyPlatformAuthorityPolicyAsset({
        artifactBytes: importedArtifactBytes(),
        provenance,
      }),
    ).toThrow("PLATFORM_AUTHORITY_POLICY_DRIFT");
  });

  it.each([
    [
      "one artifact byte",
      (source: string) => source.replace("candidate-v1", "candidate-w1"),
    ],
    [
      "candidate state",
      (source: string) =>
        source.replace('"mode":"candidate_deny"', '"mode":"enabled_exact"'),
    ],
    [
      "Temporal observation",
      (source: string) =>
        source.replace('"status":"UNKNOWN"', '"status":"VERIFIED"'),
    ],
    [
      "row order",
      (source: string) => {
        const parsed = JSON.parse(source) as { rows: unknown[] };
        parsed.rows = [parsed.rows[1], parsed.rows[0], ...parsed.rows.slice(2)];
        return `${JSON.stringify(parsed)}\n`;
      },
    ],
  ])("rejects %s mutation", (_label, mutate) => {
    const mutated = Buffer.from(mutate(importedArtifactBytes().toString("utf8")));

    expect(() =>
      verifyPlatformAuthorityPolicyAsset({
        artifactBytes: mutated,
        provenance: PLATFORM_AUTHORITY_POLICY_PROVENANCE,
      }),
    ).toThrow("PLATFORM_AUTHORITY_POLICY_DRIFT");
  });

  it("does not consult cwd or a GrowthOS authority path at runtime", () => {
    const before = process.cwd();
    const prior = process.env.GROWTHOS_AUTHORITY_ROOT;
    process.env.GROWTHOS_AUTHORITY_ROOT = "/path-that-must-never-be-read";
    process.chdir("/tmp");
    try {
      expect(loadVerifiedPlatformAuthorityPolicyAsset().sha256).toBe(
        EXPECTED_ARTIFACT_SHA256,
      );
    } finally {
      process.chdir(before);
      if (prior === undefined) delete process.env.GROWTHOS_AUTHORITY_ROOT;
      else process.env.GROWTHOS_AUTHORITY_ROOT = prior;
    }
  });
});
