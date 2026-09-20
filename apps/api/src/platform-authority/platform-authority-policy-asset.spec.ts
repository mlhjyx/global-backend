import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES,
  PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256,
  PLATFORM_AUTHORITY_POLICY_PROVENANCE,
  loadVerifiedPlatformAuthorityPolicyAsset,
  verifyPlatformAuthorityPolicyAsset,
} from "./platform-authority-policy-asset";

const EXPECTED_ROW_IDS = [
  "platform.acquisition/acq-sweep",
  "platform.acquisition/patents-cache-refresh",
  "platform.intent_watch/intent-sweep",
  "platform.sanctions/sanctions-refresh",
] as const;

function sourceArtifactBytes(): Buffer {
  return readFileSync(
    resolve(__dirname, "platform-authority-policy-matrix-v2.json"),
  );
}

function expectDeepFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe("GrowthOS-owned current platform authority policy successor", () => {
  it("loads the byte-exact reviewed-v2 artifact as the unique current policy", () => {
    const bytes = sourceArtifactBytes();
    const loaded = loadVerifiedPlatformAuthorityPolicyAsset();

    expect(bytes.byteLength).toBe(PLATFORM_AUTHORITY_POLICY_ARTIFACT_BYTES);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256,
    );
    expect(loaded).toMatchObject({
      byteLength: 15_583,
      sha256:
        "f9e9591731772f974b087307b5d0365c58c86b501232804c77a20fd3592db01b",
      policy: {
        schema_version: "platform-authority-policy-matrix/v2",
        artifact_id:
          "platform-authority-policy-matrix/2026-09-04-reviewed-v2",
        matrix_revision: "reviewed-v2",
        policy_revision_contract: {
          mode: "RECOMPUTE_ACTUAL_RUN_WITH_SUCCESSOR_IDENTITY",
          sample_values_authoritative: false,
        },
      },
    });
    expect(loaded.policy.rows.map((row) => row.row_id)).toEqual(
      EXPECTED_ROW_IDS,
    );
    expect(loaded.policy.rows.map((row) => row.desired_mode)).toEqual([
      "ENABLED",
      "INTENTIONALLY_DISABLED_NO_EGRESS",
      "ENABLED",
      "ENABLED",
    ]);
    expect(loaded.policy.rows.every((row) => row.default_issuance_state === "DENIED")).toBe(
      true,
    );
    expectDeepFrozen(loaded);
  });

  it("pins the exact GrowthOS source commit, tree, patch blob, patch bytes and materialization inputs", () => {
    expect(PLATFORM_AUTHORITY_POLICY_PROVENANCE).toEqual({
      schema_version: "growthos-platform-authority-policy-provenance/v2",
      artifact: {
        materialized_path:
          "ops/policy/platform-authority-policy-matrix-v2.json",
        byte_length: 15_583,
        sha256:
          "f9e9591731772f974b087307b5d0365c58c86b501232804c77a20fd3592db01b",
      },
      growthos_authority: {
        reviewed_head_commit:
          "17e68953ff2e26ac8433db5aa49689e5f9283659",
        reviewed_head_tree: "46832215fc8189b4c2c71dc56b653d2eac401d7c",
        artifact_commit: "cb572a149d44ab402d5cfcdaaa0aeb21c053ad9e",
        artifact_commit_tree: "953a4345900b8aeabc64ee582e02a86873d1be52",
        patch_path:
          "patches/0057-platform-authority-policy-successor.patch",
        patch_blob_sha1: "ba5ffc2642cca2d95167c22574d76be425f5d1b4",
        patch_sha256:
          "2a6943a17bc6c31d76b9266b98834fb0dd5e2cf2abf67f5f74d0ea358bf37fd9",
        artifact_commit_patch_stack_sha256:
          "a660488367c5197f84469c39524ae322cdb50973493ba9c3066e8346156143ce",
        source_archive_sha256:
          "5906e7a287843c7bafd8d7bb20aa930d1ae97eb6cf2946110d27ecc3a5dfc75a",
      },
    });
  });

  it.each([
    ["artifact byte", (value: Record<string, unknown>) => {
      value.matrix_revision = "candidate-v1";
    }],
    ["row order", (value: Record<string, unknown>) => {
      const rows = value.rows as unknown[];
      value.rows = [rows[1], rows[0], ...rows.slice(2)];
    }],
    ["desired mode", (value: Record<string, unknown>) => {
      const rows = value.rows as Array<Record<string, unknown>>;
      rows[1]!.desired_mode = "ENABLED";
    }],
  ])("rejects %s drift", (_label, mutate) => {
    const artifact = JSON.parse(sourceArtifactBytes().toString("utf8")) as Record<
      string,
      unknown
    >;
    mutate(artifact);

    expect(() =>
      verifyPlatformAuthorityPolicyAsset({
        artifact,
        provenance: PLATFORM_AUTHORITY_POLICY_PROVENANCE,
      }),
    ).toThrow("PLATFORM_AUTHORITY_POLICY_DRIFT");
  });

  it("rejects provenance drift without reading a GrowthOS checkout at runtime", () => {
    const provenance = structuredClone(
      PLATFORM_AUTHORITY_POLICY_PROVENANCE,
    ) as unknown as {
      growthos_authority: { patch_sha256: string };
    };
    provenance.growthos_authority.patch_sha256 = "0".repeat(64);

    expect(() =>
      verifyPlatformAuthorityPolicyAsset({
        artifact: JSON.parse(sourceArtifactBytes().toString("utf8")),
        provenance,
      }),
    ).toThrow("PLATFORM_AUTHORITY_POLICY_DRIFT");

    const previous = process.env.GROWTHOS_AUTHORITY_ROOT;
    process.env.GROWTHOS_AUTHORITY_ROOT = "/must-not-be-read";
    try {
      expect(loadVerifiedPlatformAuthorityPolicyAsset().sha256).toBe(
        PLATFORM_AUTHORITY_POLICY_ARTIFACT_SHA256,
      );
    } finally {
      if (previous === undefined) delete process.env.GROWTHOS_AUTHORITY_ROOT;
      else process.env.GROWTHOS_AUTHORITY_ROOT = previous;
    }
  });
});
