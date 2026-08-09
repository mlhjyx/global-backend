import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ACTIVE_COPY_RUNTIME_BINDING_PATH,
  ACTIVE_COPY_RUNTIME_BINDING_SHA256,
  accountCopySourceBytes,
  buildCopySourceFingerprint,
  evaluateCopyFixedSourceImpact,
  readAnchoredRepositoryFile,
  readStableRegularHandle,
} from "./copy-fixed-source-impact.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);

function regularStat(overrides = {}) {
  return {
    dev: 1n,
    ino: 2n,
    mode: 0o100644n,
    size: 3n,
    mtimeNs: 4n,
    ctimeNs: 5n,
    isFile: () => true,
    ...overrides,
  };
}

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
    required_followup: "SEPARATE_DISPATCH_AUTHORIZATION",
    stale_scope: "NONE",
    ...overrides,
  };
}

test("Copy impact stays CURRENT only when every bound source byte matches", () => {
  assert.equal(
    ACTIVE_COPY_RUNTIME_BINDING_PATH,
    "docs/evidence/site-builder/m1-g-copy-sonnet-recovery-runtime-binding-v15.json",
  );
  assert.equal(
    ACTIVE_COPY_RUNTIME_BINDING_SHA256,
    "838121ccf9649b05d9c04b05a1cec7ba094439a8a81a177462e5955a17c2ef7c",
  );
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
        eligibility: eligibility({
          current_source_fingerprint: buildCopySourceFingerprint(currentFiles),
        }),
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
      stale_scope: "PRISMA_SCHEMA_EVOLUTION",
      required_followup: "REBASE_FIXED_SOURCE_BEFORE_DISPATCH",
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
            stale_scope: "PRISMA_SCHEMA_EVOLUTION",
            required_followup: "REBASE_FIXED_SOURCE_BEFORE_DISPATCH",
            ...mutation,
          }),
          currentFiles,
        }),
      /COPY_FIXED_SOURCE_SAFETY_BOUNDARY_INVALID/u,
    );
  }
  assert.throws(
    () =>
      evaluateCopyFixedSourceImpact({
        binding: binding(),
        eligibility: eligibility({
          status: "STALE_HOLD",
          current_source_fingerprint: buildCopySourceFingerprint(currentFiles),
          drifted_paths: ["packages/db/prisma/schema.prisma"],
          stale_scope: "PRISMA_SCHEMA_EVOLUTION",
          required_followup: "SEPARATE_DISPATCH_AUTHORIZATION",
        }),
        currentFiles,
      }),
    /COPY_FIXED_SOURCE_FOLLOWUP_INVALID/u,
  );
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
        binding: binding(),
        eligibility: eligibility({
          status: "STALE_HOLD",
          current_source_fingerprint: buildCopySourceFingerprint([
            {
              path: "apps/api/src/model-runtime/types.ts",
              sha256: SHA_C,
            },
            { path: "packages/db/prisma/schema.prisma", sha256: SHA_B },
          ]),
          drifted_paths: ["apps/api/src/model-runtime/types.ts"],
          stale_scope: "PRISMA_SCHEMA_EVOLUTION",
          required_followup: "REBASE_FIXED_SOURCE_BEFORE_DISPATCH",
        }),
        currentFiles: [
          { path: "apps/api/src/model-runtime/types.ts", sha256: SHA_C },
          { path: "packages/db/prisma/schema.prisma", sha256: SHA_B },
        ],
      }),
    /COPY_FIXED_SOURCE_STALE_SCOPE_INVALID/u,
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

test("Copy source reads reject a regular file replaced while the same handle is read", async () => {
  const stats = [regularStat(), regularStat({ ino: 99n })];
  const handle = {
    async stat() {
      return stats.shift();
    },
    async read(buffer, offset, length) {
      Buffer.from("abc").copy(buffer, offset, 0, length);
      return { bytesRead: 3 };
    },
  };

  await assert.rejects(
    readStableRegularHandle(handle, 1024, "bound source"),
    /COPY_FIXED_SOURCE_FILE_CHANGED/u,
  );
});

test("Copy source reads reject growth observed during a bounded read", async () => {
  const stats = [regularStat(), regularStat()];
  const handle = {
    async stat() {
      return stats.shift();
    },
    async read(buffer, offset, length) {
      Buffer.from("abcd").copy(buffer, offset, 0, length);
      return { bytesRead: 4 };
    },
  };

  await assert.rejects(
    readStableRegularHandle(handle, 1024, "bound source"),
    /COPY_FIXED_SOURCE_FILE_CHANGED/u,
  );
});

test("Copy source traversal rejects a symlinked intermediate directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "copy-impact-root-"));
  const outside = await mkdtemp(join(tmpdir(), "copy-impact-outside-"));
  try {
    await mkdir(join(root, "safe"));
    await writeFile(join(outside, "source.ts"), "outside");
    await symlink(outside, join(root, "safe", "linked"));

    await assert.rejects(
      readAnchoredRepositoryFile(root, "safe/linked/source.ts", {
        maxBytes: 1024,
      }),
      /COPY_FIXED_SOURCE_PATH_NOT_REGULAR/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("Copy source aggregate accounting fails before the bounded inventory can grow without limit", () => {
  assert.equal(accountCopySourceBytes(0, 3), 3);
  assert.throws(
    () => accountCopySourceBytes(128 * 1024 * 1024, 1),
    /COPY_FIXED_SOURCE_TOTAL_BYTES_EXCEEDED/u,
  );
  assert.throws(
    () => accountCopySourceBytes(-1, 1),
    /COPY_FIXED_SOURCE_TOTAL_BYTES_INVALID/u,
  );
});
