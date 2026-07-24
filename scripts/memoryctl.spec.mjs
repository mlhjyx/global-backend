import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupGraph, createCandidate, promoteCandidate, restoreGraph, verifyGraph, MemoryCtlError } from "./memoryctl-lib.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memoryctl-"));
  const graphPath = join(root, "knowledge-graph.jsonl");
  await writeFile(graphPath, `${JSON.stringify({ type: "entity", name: "project:test", entityType: "project", observations: ["seed"] })}\n`, { mode: 0o600 });
  return { root, graphPath, backupDir: join(root, "backups") };
}

function candidate(id, kind = "user_decision") {
  return {
    schemaVersion: "memoryctl-candidate/v1",
    id,
    project: "/global/backend",
    status: "inbox",
    kind,
    authority: kind === "user_decision" ? "approved_reference" : "derived",
    entity: { name: `decision:${id}`, entityType: "decision" },
    observations: ["A concise approved decision receipt."],
    source: { kind, reference: "task:example" },
    validAsOf: "2026-07-25T00:00:00.000Z",
    reviewAfter: "2027-07-25T00:00:00.000Z",
    owner: "OWN-PRODUCT",
    approval: kind === "user_decision" ? {
      kind: "user_explicit",
      reference: "task:example#user-message",
      approvedBy: "product-owner",
      approvedAt: "2026-07-25T00:00:00.000Z",
      statementHash: "a".repeat(64),
    } : undefined,
  };
}

test("candidate stays separate and promotion writes a compatible fact receipt", async () => {
  const paths = await fixture();
  const value = candidate("decision-0001");
  const created = await createCandidate(value, paths);
  const before = await verifyGraph(paths);
  const result = await promoteCandidate(created.candidatePath, { ...paths, expectedCandidateHash: created.candidateHash, expectedGraphHash: before.graphHash });
  assert.equal(result.changed, true);
  const graph = await readFile(paths.graphPath, "utf8");
  assert.match(graph, /memory_fact_v1:decision-0001/);
  assert.equal((await verifyGraph(paths)).journalPresent, false);
});

test("repeated promotions keep all independent facts", async () => {
  const paths = await fixture();
  const prepared = await Promise.all(Array.from({ length: 8 }, (_, index) => createCandidate(candidate(`decision-${String(index + 10).padStart(4, "0")}`), paths)));
  for (const item of prepared) {
    const current = await verifyGraph(paths);
    await promoteCandidate(item.candidatePath, { ...paths, expectedCandidateHash: item.candidateHash, expectedGraphHash: current.graphHash, lockTimeoutMs: 2_000 });
  }
  const result = await verifyGraph(paths);
  assert.equal(result.entityCount, 17);
  assert.equal(result.relationCount, 8);
});

test("secret and personal data candidates fail closed without revealing content", async () => {
  const paths = await fixture();
  const value = candidate("decision-9999");
  value.observations = [`contains ${"sk-" + "A".repeat(24)}`];
  await assert.rejects(() => createCandidate(value, paths), (error) => error instanceof MemoryCtlError && error.code === "SENSITIVE_CONTENT" && !error.message.includes("sk-"));
});

test("promotion rejects a changed graph and leaves it untouched", async () => {
  const paths = await fixture();
  const created = await createCandidate(candidate("decision-0002"), paths);
  const before = await verifyGraph(paths);
  await writeFile(paths.graphPath, `${JSON.stringify({ type: "entity", name: "project:test", entityType: "project", observations: ["changed"] })}\n`);
  await assert.rejects(() => promoteCandidate(created.candidatePath, { ...paths, expectedCandidateHash: created.candidateHash, expectedGraphHash: before.graphHash }), /memory graph changed/);
  assert.equal(await readFile(paths.graphPath, "utf8"), `${JSON.stringify({ type: "entity", name: "project:test", entityType: "project", observations: ["changed"] })}\n`);
});

test("verify detects graph drift after a controlled promotion", async () => {
  const paths = await fixture();
  const created = await createCandidate(candidate("decision-0003"), paths);
  const before = await verifyGraph(paths);
  await promoteCandidate(created.candidatePath, { ...paths, expectedCandidateHash: created.candidateHash, expectedGraphHash: before.graphHash });
  assert.equal((await verifyGraph(paths)).untrackedDrift, false);
  await writeFile(paths.graphPath, `${JSON.stringify({ type: "entity", name: "project:test", entityType: "project", observations: ["outside"] })}\n`);
  assert.equal((await verifyGraph(paths)).untrackedDrift, true);
});

test("restore requires the current hash and preserves a preimage backup", async () => {
  const paths = await fixture();
  const saved = await backupGraph(paths);
  await writeFile(paths.graphPath, `${JSON.stringify({ type: "entity", name: "project:test", entityType: "project", observations: ["new"] })}\n`);
  const changed = await verifyGraph(paths);
  const result = await restoreGraph(saved.backupPath, { ...paths, expectedGraphHash: changed.graphHash });
  assert.equal(result.graphHash, saved.graphHash);
  assert.match(await readFile(paths.graphPath, "utf8"), /seed/);
});

test("merged PR promotion requires a live mechanical verifier", async () => {
  const paths = await fixture();
  const value = candidate("merged-pr-0001", "merged_pr");
  value.source = {
    kind: "merged_pr",
    reference: "PR #1",
    repository: "mlhjyx/global-backend",
    prNumber: 1,
    baseRef: "main",
    mergeSha: "b".repeat(40),
  };
  value.sourceCommit = "b".repeat(40);
  const created = await createCandidate(value, paths);
  const before = await verifyGraph(paths);
  await assert.rejects(() => promoteCandidate(created.candidatePath, {
    ...paths,
    expectedCandidateHash: created.candidateHash,
    expectedGraphHash: before.graphHash,
    verifyMergedPr: async () => { throw new Error("not merged"); },
  }), /not merged/);
  const result = await promoteCandidate(created.candidatePath, {
    ...paths,
    expectedCandidateHash: created.candidateHash,
    expectedGraphHash: before.graphHash,
    verifyMergedPr: async () => {},
  });
  assert.equal(result.changed, true);
});

test("verify rejects group-readable managed memory files", async () => {
  const paths = await fixture();
  await chmod(paths.graphPath, 0o644);
  await assert.rejects(() => verifyGraph(paths), (error) => error instanceof MemoryCtlError && error.code === "INSECURE_PERMISSIONS");
});
