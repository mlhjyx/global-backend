import assert from "node:assert/strict";
import { mkdtempSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { CandidateBudgetLedger } from "./development-candidate-budget.mjs";

const NOW = Date.parse("2026-11-15T14:00:00.000Z");
const CONFIG = Object.freeze({
  campaignId: "pump-ab-20261115",
  expiresAt: "2026-11-16T14:00:00.000Z",
  capMicrousd: 5_000_000,
  arms: {
    A: {
      workspaceId: "10000000-0000-4000-8000-000000000001",
      capMicrousd: 2_500_000,
    },
    B: {
      workspaceId: "10000000-0000-4000-8000-000000000002",
      capMicrousd: 2_500_000,
    },
  },
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "candidate-budget-"));
  const path = join(directory, "budget.sqlite");
  return {
    directory,
    path,
    open: () => new CandidateBudgetLedger(path, CONFIG, { now: () => NOW }),
  };
}
const request = (index, overrides = {}) => ({
  requestKey: index.toString(16).padStart(64, "0"),
  arm: "A",
  workspaceId: CONFIG.arms.A.workspaceId,
  purpose: "icp.design",
  quoteSha256: "a".repeat(64),
  capMicrousd: 1_000_000,
  ...overrides,
});
const binding = (index, overrides = {}) => ({
  workspaceId: CONFIG.arms.A.workspaceId,
  purpose: "icp.design",
  requestSha256: index.toString(16).padStart(64, "0"),
  capMicrousd: 1_000_000,
  accountKey: "profile:one",
  grantSha256: "e".repeat(64),
  ...overrides,
});
function child(path, index, arm) {
  const worker = fileURLToPath(new URL("./fixtures/development-candidate-budget-worker.mjs", import.meta.url));
  const input = request(index, {
    arm,
    workspaceId: CONFIG.arms[arm].workspaceId,
    capMicrousd: 750_000,
  });
  return new Promise((resolve, reject) => {
    const process = spawn(
      globalThis.process.execPath,
      [worker, path, JSON.stringify(CONFIG), String(NOW), JSON.stringify(input)],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    process.stdout.on("data", (chunk) => {
      out += chunk;
    });
    process.stderr.on("data", (chunk) => {
      err += chunk;
    });
    process.on("error", reject);
    process.on("close", (exit) =>
      exit === 0 ? resolve(out) : reject(new Error(err)),
    );
  });
}

test("durably allocates whole Grant caps before issuance; unused/UNKNOWN slices never return to balance", () => {
  const f = fixture();
  let ledger = f.open();
  const allocated = ledger.allocate(request(1));
  assert.equal(allocated.state, "ALLOCATED");
  ledger.beginIssuance(allocated.id);
  ledger.markUnknown(allocated.id);
  ledger.close();
  ledger = f.open();
  assert.equal(ledger.status().arms.A.allocatedMicrousd, 1_000_000);
  assert.equal(ledger.allocate(request(1)).state, "UNKNOWN");
  assert.throws(() => ledger.beginIssuance(allocated.id), {
    code: "CANDIDATE_GRANT_ALREADY_DISPATCHED",
  });
  assert.throws(() => ledger.allocate(request(2, { capMicrousd: 1_500_001 })), {
    code: "CANDIDATE_BUDGET_EXCEEDED",
  });
  ledger.close();
});

test("exact duplicate allocation and binding are idempotent; conflicting reuse fails closed", () => {
  const f = fixture();
  const ledger = f.open();
  const first = ledger.allocate(request(1));
  assert.equal(ledger.allocate(request(1)).id, first.id);
  for (const patch of [
    { capMicrousd: 2 },
    { quoteSha256: "b".repeat(64) },
    { purpose: "discovery.run" },
  ]) {
    assert.throws(() => ledger.allocate(request(1, patch)), {
      code: "CANDIDATE_ALLOCATION_CONFLICT",
    });
  }
  ledger.beginIssuance(first.id);
  const verified = binding(1, {
    accountKey: "discovery.run:account:1",
    grantSha256: "c".repeat(64),
  });
  assert.equal(ledger.bind(first.id, verified).state, "BOUND");
  assert.equal(ledger.bind(first.id, verified).state, "BOUND");
  assert.throws(
    () => ledger.bind(first.id, { ...verified, accountKey: "other" }),
    { code: "CANDIDATE_ALLOCATION_CONFLICT" },
  );
  assert.equal(ledger.status().allocatedMicrousd, 1_000_000);
  ledger.close();
});

test("crash after issuance intent cannot cause another issuer request on reopen", () => {
  const f = fixture();
  let ledger = f.open();
  const first = ledger.allocate(request(1));
  ledger.beginIssuance(first.id);
  ledger.close();
  ledger = f.open();
  assert.equal(ledger.allocate(request(1)).state, "ISSUING");
  assert.throws(() => ledger.beginIssuance(first.id), {
    code: "CANDIDATE_GRANT_ALREADY_DISPATCHED",
  });
  ledger.bind(
    first.id,
    binding(1, { accountKey: "profile:restored", grantSha256: "d".repeat(64) }),
  );
  assert.equal(ledger.status().allocatedMicrousd, 1_000_000);
  ledger.close();
});

test("never binds an account or Grant to two allocated operations", () => {
  const f = fixture();
  const ledger = f.open();
  const a = ledger.allocate(request(1));
  const b = ledger.allocate(request(2));
  ledger.beginIssuance(a.id);
  ledger.beginIssuance(b.id);
  ledger.bind(a.id, binding(1));
  assert.throws(
    () =>
      ledger.bind(
        b.id,
        binding(2, { accountKey: "profile:one", grantSha256: "f".repeat(64) }),
      ),
    { code: "CANDIDATE_BINDING_REUSED" },
  );
  assert.throws(
    () =>
      ledger.bind(
        b.id,
        binding(2, { accountKey: "profile:two", grantSha256: "e".repeat(64) }),
      ),
    { code: "CANDIDATE_BINDING_REUSED" },
  );
  ledger.close();
});

test("independent process races stay within both arm caps and the campaign cap", async () => {
  const f = fixture();
  const initial = f.open();
  initial.close();
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      child(f.path, i + 1, i % 2 ? "A" : "B"),
    ),
  );
  assert.equal(results.filter((item) => item === "allocated").length, 6);
  const ledger = f.open();
  const status = ledger.status();
  assert.equal(status.allocatedMicrousd, 4_500_000);
  assert.equal(status.arms.A.allocatedMicrousd, 2_250_000);
  assert.equal(status.arms.B.allocatedMicrousd, 2_250_000);
  ledger.close();
});

test("workspace, cap, unknown purpose and malformed amounts fail before allocation", () => {
  const f = fixture();
  const ledger = f.open();
  for (const patch of [
    { workspaceId: CONFIG.arms.B.workspaceId },
    { arm: "C" },
    { purpose: "credential.rotate" },
    { capMicrousd: 0 },
    { capMicrousd: -1 },
    { capMicrousd: 0.1 },
    { capMicrousd: Number.NaN },
    { requestKey: "Bearer private-value" },
    { quoteSha256: "invalid" },
  ])
    assert.throws(() => ledger.allocate(request(1, patch)), {
      code: "CANDIDATE_ALLOCATION_INVALID",
    });
  assert.equal(ledger.status().allocatedMicrousd, 0);
  ledger.close();
});

test("campaign configuration is immutable and cannot exceed the confirmed five dollars", () => {
  const f = fixture();
  const ledger = f.open();
  ledger.close();
  assert.throws(
    () =>
      new CandidateBudgetLedger(f.path, { ...CONFIG, campaignId: "another" }),
    { code: "CANDIDATE_CAMPAIGN_CONFLICT" },
  );
  assert.throws(
    () =>
      new CandidateBudgetLedger(f.path, { ...CONFIG, capMicrousd: 5_000_001 }),
    { code: "CANDIDATE_CAMPAIGN_INVALID" },
  );
  assert.throws(
    () =>
      new CandidateBudgetLedger(f.path, {
        ...CONFIG,
        arms: { ...CONFIG.arms, B: CONFIG.arms.A },
      }),
    { code: "CANDIDATE_CAMPAIGN_INVALID" },
  );
});

test("expiry blocks new allocations and issuance without erasing allocated exposure", () => {
  const f = fixture();
  let ledger = f.open();
  const first = ledger.allocate(request(1));
  ledger.close();
  ledger = new CandidateBudgetLedger(f.path, CONFIG, {
    now: () => Date.parse(CONFIG.expiresAt),
  });
  assert.throws(() => ledger.allocate(request(2)), {
    code: "CANDIDATE_CAMPAIGN_EXPIRED",
  });
  assert.throws(() => ledger.beginIssuance(first.id), {
    code: "CANDIDATE_CAMPAIGN_EXPIRED",
  });
  assert.equal(ledger.status().allocatedMicrousd, 1_000_000);
  ledger.close();
});

test("requires a private regular ledger and parent directory, never follows symlinks", () => {
  const f = fixture();
  const ledger = f.open();
  ledger.close();
  const link = join(f.directory, "linked.sqlite");
  symlinkSync(f.path, link);
  assert.throws(() => new CandidateBudgetLedger(link, CONFIG), {
    code: "CANDIDATE_LEDGER_PATH_INVALID",
  });
  chmodSync(f.path, 0o644);
  assert.throws(() => new CandidateBudgetLedger(f.path, CONFIG), {
    code: "CANDIDATE_LEDGER_PATH_INVALID",
  });
  const other = fixture();
  chmodSync(other.directory, 0o755);
  assert.throws(() => other.open(), { code: "CANDIDATE_LEDGER_PATH_INVALID" });
  assert.equal(existsSync(other.path), false);
});

test("a verified Grant cannot exceed its slice, change workspace/purpose/request, or disappear from the exported cap proof", () => {
  const f = fixture();
  const ledger = f.open();
  const a = ledger.allocate(request(1));
  ledger.beginIssuance(a.id);
  for (const patch of [
    { workspaceId: CONFIG.arms.B.workspaceId },
    { purpose: "discovery.run" },
    { requestSha256: "f".repeat(64) },
    { capMicrousd: 1_000_001 },
  ]) {
    assert.throws(() => ledger.bind(a.id, binding(1, patch)), {
      code: "CANDIDATE_GRANT_SCOPE_MISMATCH",
    });
  }
  ledger.bind(a.id, binding(1));
  ledger.allocate(request(2));
  const snapshot = ledger.exportAllocations("c".repeat(64));
  assert.equal(snapshot.allocations.length, 2);
  assert.equal(
    snapshot.allocations.reduce((sum, item) => sum + item.capMicrousd, 0),
    2_000_000,
  );
  assert.equal(
    snapshot.allocations.find((item) => item.id === a.id).grantSha256,
    "e".repeat(64),
  );
  assert.equal(
    snapshot.allocations.filter((item) => item.state === "ALLOCATED").length,
    1,
  );
  ledger.close();
});
