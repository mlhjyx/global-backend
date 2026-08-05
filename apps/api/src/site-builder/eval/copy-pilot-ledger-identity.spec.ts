import {
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertCopyPilotLedgerIdentityCurrent,
  loadCopyPilotLedgerIdentity,
  markCopyPilotLedgerIdentityClaimed,
  prepareCopyPilotLedgerIdentity,
} from "./copy-pilot-ledger-identity";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function paths() {
  const directory = await mkdtemp(join(tmpdir(), "copy-ledger-identity-"));
  directories.push(directory);
  return {
    ledgerPath: join(directory, "ledger.jsonl"),
    authorizationClaimPath: join(directory, "authorization.claim.json"),
    markerPath: join(directory, "ledger.marker.jsonl"),
    campaignId: "copy-real-capability-marker-test",
  };
}

describe("Copy pilot durable ledger identity", () => {
  it("prepares a random marker before authorization and reloads the same identity", async () => {
    const target = await paths();
    const prepared = await prepareCopyPilotLedgerIdentity(target);
    const loaded = await loadCopyPilotLedgerIdentity(target);

    expect(prepared.ledgerIdentityDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(loaded.ledgerIdentityDigest).toBe(prepared.ledgerIdentityDigest);
    await expect(prepareCopyPilotLedgerIdentity(target)).rejects.toThrow(
      "COPY_PILOT_LEDGER_MARKER_ALREADY_EXISTS",
    );
  });

  it("changes the authorization identity after a same-byte marker replacement", async () => {
    const target = await paths();
    const prepared = await prepareCopyPilotLedgerIdentity(target);
    const replacementPath = `${target.markerPath}.replacement`;
    await writeFile(replacementPath, await readFile(target.markerPath), {
      mode: 0o600,
    });
    await rename(replacementPath, target.markerPath);

    const replaced = await loadCopyPilotLedgerIdentity(target);
    expect(replaced.ledgerIdentityDigest).not.toBe(
      prepared.ledgerIdentityDigest,
    );
  });

  it("binds claimed ledger and claim inodes and rejects later deletion", async () => {
    const target = await paths();
    const prepared = await prepareCopyPilotLedgerIdentity(target);
    await Promise.all([
      writeFile(target.ledgerPath, "ledger\n", { mode: 0o600 }),
      writeFile(target.authorizationClaimPath, "claim\n", { mode: 0o600 }),
    ]);
    await markCopyPilotLedgerIdentityClaimed(prepared.handle, {
      authorizationDigest: "a".repeat(64),
    });
    await expect(
      assertCopyPilotLedgerIdentityCurrent(prepared.handle),
    ).resolves.toBeUndefined();

    await unlink(target.authorizationClaimPath);
    await expect(
      assertCopyPilotLedgerIdentityCurrent(prepared.handle),
    ).rejects.toThrow("COPY_PILOT_LEDGER_IDENTITY_DRIFT");
  });

  it("reconciles a stale pre-claim handle without appending a duplicate claim", async () => {
    const target = await paths();
    const prepared = await prepareCopyPilotLedgerIdentity(target);
    const stale = await loadCopyPilotLedgerIdentity(target);
    await Promise.all([
      writeFile(target.ledgerPath, "ledger\n", { mode: 0o600 }),
      writeFile(target.authorizationClaimPath, "claim\n", { mode: 0o600 }),
    ]);

    await markCopyPilotLedgerIdentityClaimed(prepared.handle, {
      authorizationDigest: "b".repeat(64),
    });
    await expect(
      markCopyPilotLedgerIdentityClaimed(stale.handle, {
        authorizationDigest: "b".repeat(64),
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertCopyPilotLedgerIdentityCurrent(stale.handle),
    ).resolves.toBeUndefined();
  });
});
