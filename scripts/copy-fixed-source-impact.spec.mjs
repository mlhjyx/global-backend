import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCopySourceFingerprint,
  evaluateCopyFixedSourceImpact,
} from "./copy-fixed-source-impact.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function binding() {
  return {
    artifactId:
      "site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-10-v15-v1",
    fixedSourceCommit: "f".repeat(40),
    dispatchAuthorization: "NOT_AUTHORIZED",
    sourceBundle: {
      digest: SHA_A,
      files: [
        { path: "apps/api/src/model-runtime/types.ts", sha256: SHA_A },
        { path: "packages/db/prisma/schema.prisma", sha256: SHA_B },
      ],
    },
  };
}

function eligibility(overrides = {}) {
  const currentFiles = [
    { path: "apps/api/src/model-runtime/types.ts", sha256: SHA_A },
    { path: "packages/db/prisma/schema.prisma", sha256: SHA_B },
  ];
  return {
    schema_version: "site-builder-copy-runtime-eligibility/v1",
    active_binding_path:
      "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v15.json",
    active_binding_artifact_id:
      "site-builder-copy-sonnet-recovery-runtime-binding-prep/2026-08-10-v15-v1",
    active_binding_source_bundle_digest: SHA_A,
    status: "CURRENT",
    current_source_fingerprint: buildCopySourceFingerprint(currentFiles),
    drifted_paths: [],
    dispatch_authorization: "NOT_AUTHORIZED",
    pilot_eligibility: "BLOCKED",
    required_followup: "REBASE_FIXED_SOURCE_BEFORE_DISPATCH",
    ...overrides,
  };
}

test("Copy impact stays CURRENT only when every bound source byte matches", () => {
  const result = evaluateCopyFixedSourceImpact({
    binding: binding(),
    eligibility: eligibility(),
    currentFiles: [
      { path: "apps/api/src/model-runtime/types.ts", sha256: SHA_A },
      { path: "packages/db/prisma/schema.prisma", sha256: SHA_B },
    ],
  });

  assert.deepEqual(result, {
    status: "CURRENT",
    driftedPaths: [],
    sourceFingerprint: eligibility().current_source_fingerprint,
  });
});

test("Copy impact rejects source drift without an exact STALE/HOLD receipt", () => {
  const currentFiles = [
    { path: "apps/api/src/model-runtime/types.ts", sha256: SHA_A },
    { path: "packages/db/prisma/schema.prisma", sha256: SHA_C },
  ];

  assert.throws(
    () =>
      evaluateCopyFixedSourceImpact({
        binding: binding(),
        eligibility: eligibility(),
        currentFiles,
      }),
    /COPY_FIXED_SOURCE_STATUS_INVALID/u,
  );
  assert.throws(
    () =>
      evaluateCopyFixedSourceImpact({
        binding: binding(),
        eligibility: eligibility({
          status: "STALE_HOLD",
          current_source_fingerprint: buildCopySourceFingerprint(currentFiles),
          drifted_paths: [],
        }),
        currentFiles,
      }),
    /COPY_FIXED_SOURCE_DRIFT_PATHS_MISMATCH/u,
  );
});

test("Copy impact admits exact STALE/HOLD while keeping dispatch and pilot blocked", () => {
  const currentFiles = [
    { path: "apps/api/src/model-runtime/types.ts", sha256: SHA_A },
    { path: "packages/db/prisma/schema.prisma", sha256: SHA_C },
  ];
  const result = evaluateCopyFixedSourceImpact({
    binding: binding(),
    eligibility: eligibility({
      status: "STALE_HOLD",
      current_source_fingerprint: buildCopySourceFingerprint(currentFiles),
      drifted_paths: ["packages/db/prisma/schema.prisma"],
    }),
    currentFiles,
  });

  assert.deepEqual(result, {
    status: "STALE_HOLD",
    driftedPaths: ["packages/db/prisma/schema.prisma"],
    sourceFingerprint: buildCopySourceFingerprint(currentFiles),
  });

  for (const mutation of [
    { dispatch_authorization: "AUTHORIZED" },
    { pilot_eligibility: "READY" },
    { required_followup: "NONE" },
  ]) {
    assert.throws(
      () =>
        evaluateCopyFixedSourceImpact({
          binding: binding(),
          eligibility: eligibility({
            status: "STALE_HOLD",
            current_source_fingerprint:
              buildCopySourceFingerprint(currentFiles),
            drifted_paths: ["packages/db/prisma/schema.prisma"],
            ...mutation,
          }),
          currentFiles,
        }),
      /COPY_FIXED_SOURCE_SAFETY_BOUNDARY_INVALID/u,
    );
  }
});

test("Copy impact rejects stale fingerprints, binding substitutions, and unsafe paths", () => {
  const currentFiles = [
    { path: "apps/api/src/model-runtime/types.ts", sha256: SHA_A },
    { path: "packages/db/prisma/schema.prisma", sha256: SHA_C },
  ];
  assert.throws(
    () =>
      evaluateCopyFixedSourceImpact({
        binding: binding(),
        eligibility: eligibility({
          status: "STALE_HOLD",
          current_source_fingerprint: SHA_A,
          drifted_paths: ["packages/db/prisma/schema.prisma"],
        }),
        currentFiles,
      }),
    /COPY_FIXED_SOURCE_FINGERPRINT_MISMATCH/u,
  );
  assert.throws(
    () =>
      evaluateCopyFixedSourceImpact({
        binding: binding(),
        eligibility: eligibility({
          active_binding_source_bundle_digest: SHA_C,
        }),
        currentFiles: binding().sourceBundle.files,
      }),
    /COPY_FIXED_SOURCE_BINDING_MISMATCH/u,
  );
  assert.throws(
    () =>
      evaluateCopyFixedSourceImpact({
        binding: {
          ...binding(),
          sourceBundle: {
            ...binding().sourceBundle,
            files: [{ path: "../outside", sha256: SHA_A }],
          },
        },
        eligibility: eligibility(),
        currentFiles: [{ path: "../outside", sha256: SHA_A }],
      }),
    /COPY_FIXED_SOURCE_BINDING_INVALID/u,
  );
});
