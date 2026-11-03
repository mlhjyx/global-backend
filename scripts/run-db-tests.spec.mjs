import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  GROUPS,
  listTestFiles,
  loadManifest,
  rewriteDatabaseUrl,
  selectFiles,
  validateManifest,
} from "./run-db-tests.mjs";

describe("db test CI manifest", () => {
  it("classifies every packages/db/test spec exactly once", () => {
    const errors = validateManifest(loadManifest(), listTestFiles());
    assert.deepEqual(errors, []);
  });

  it("rejects unclassified files", () => {
    const errors = validateManifest(
      { service: ["a.spec.mjs"], isolated: [], static: [] },
      ["a.spec.mjs", "b.spec.mjs"],
    );
    assert.match(errors.join("\n"), /b\.spec\.mjs.*not classified/);
  });

  it("rejects duplicates, unknown groups and missing files", () => {
    const errors = validateManifest(
      { service: ["a.spec.mjs", "a.spec.mjs", "ghost.spec.mjs"], isolated: [], static: [], legacy: [] },
      ["a.spec.mjs"],
    );
    const text = errors.join("\n");
    assert.match(text, /listed twice/);
    assert.match(text, /ghost\.spec\.mjs.*missing/);
    assert.match(text, /unknown group 'legacy'/);
  });

  it("distributes files round-robin across shards", () => {
    const manifest = { service: [], isolated: ["a", "b", "c", "d", "e"], static: [] };
    assert.deepEqual(selectFiles(manifest, "isolated", 1, 2), ["a", "c", "e"]);
    assert.deepEqual(selectFiles(manifest, "isolated", 2, 2), ["b", "d"]);
    assert.deepEqual(selectFiles(manifest, "isolated", 1, 1), ["a", "b", "c", "d", "e"]);
  });

  it("rewrites the database name while preserving credentials and parameters", () => {
    assert.equal(
      rewriteDatabaseUrl(
        "postgresql://app_user:app_pw@127.0.0.1:5432/global_test?schema=public",
        "svc_1",
      ),
      "postgresql://app_user:app_pw@127.0.0.1:5432/svc_1?schema=public",
    );
  });

  it("rejects invalid groups and shards", () => {
    const manifest = { service: ["a"], isolated: [], static: [] };
    assert.throws(() => selectFiles(manifest, "legacy"), /unknown group/);
    assert.throws(() => selectFiles(manifest, "service", 0, 2), /invalid shard/);
    assert.throws(() => selectFiles(manifest, "service", 3, 2), /invalid shard/);
    assert.deepEqual(GROUPS, ["service", "isolated", "manual", "static"]);
  });
});
