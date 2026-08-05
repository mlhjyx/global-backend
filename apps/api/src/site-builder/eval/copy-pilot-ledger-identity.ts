import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { canonicalDigest } from "../../model-runtime/context-engine";

const SCHEMA_VERSION = "copy-pilot-ledger-marker/2026-08-05-v1" as const;
const SHA256 = /^[0-9a-f]{64}$/u;

interface PreparedEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "prepared";
  markerId: string;
  ledgerPath: string;
  authorizationClaimPath: string;
  campaignId: string;
  digest: string;
}

interface ClaimedEvent {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "claimed";
  preparedDigest: string;
  authorizationDigest: string;
  ledgerDevice: string;
  ledgerInode: string;
  claimDevice: string;
  claimInode: string;
  digest: string;
}

interface MarkerState {
  markerPath: string;
  markerDevice: string;
  markerInode: string;
  markerBirthtimeMs: string;
  prepared: PreparedEvent;
  claimed?: ClaimedEvent;
}

export interface CopyPilotLedgerIdentity {
  readonly __opaque?: never;
}

export interface CopyPilotPreparedLedgerIdentity {
  handle: CopyPilotLedgerIdentity;
  markerPath: string;
  ledgerIdentityDigest: string;
}

const IDENTITIES = new WeakMap<object, MarkerState>();

function fail(code: string): never {
  throw new Error(code);
}

function eventDigest<T extends { digest: string }>(event: T): string {
  const { digest: _digest, ...material } = event;
  return canonicalDigest(material);
}

async function normalizedPaths(input: {
  ledgerPath: string;
  authorizationClaimPath: string;
  markerPath: string;
  campaignId: string;
}) {
  if (!input.campaignId.trim()) fail("COPY_PILOT_LEDGER_IDENTITY_INVALID");
  const [ledgerParent, claimParent, markerParent] = await Promise.all([
    realpath(dirname(resolve(input.ledgerPath))),
    realpath(dirname(resolve(input.authorizationClaimPath))),
    realpath(dirname(resolve(input.markerPath))),
  ]).catch(() => fail("COPY_PILOT_LEDGER_PARENT_INVALID"));
  const paths = {
    ledgerPath: resolve(ledgerParent, basename(input.ledgerPath)),
    authorizationClaimPath: resolve(
      claimParent,
      basename(input.authorizationClaimPath),
    ),
    markerPath: resolve(markerParent, basename(input.markerPath)),
    campaignId: input.campaignId,
  };
  if (new Set(Object.values(paths).slice(0, 3)).size !== 3) {
    fail("COPY_PILOT_LEDGER_IDENTITY_INVALID");
  }
  return paths;
}

async function fileIdentity(path: string): Promise<{
  device: string;
  inode: string;
}> {
  const status = await lstat(path).catch(() =>
    fail("COPY_PILOT_LEDGER_IDENTITY_DRIFT"),
  );
  if (
    !status.isFile() ||
    status.isSymbolicLink() ||
    (status.mode & 0o077) !== 0
  ) {
    fail("COPY_PILOT_LEDGER_IDENTITY_DRIFT");
  }
  return { device: String(status.dev), inode: String(status.ino) };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fileIdentity(path);
    return true;
  } catch (error) {
    if ((error as Error).message === "COPY_PILOT_LEDGER_IDENTITY_DRIFT") {
      try {
        await lstat(path);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT")
          return false;
      }
    }
    throw error;
  }
}

async function readMarker(markerPath: string): Promise<MarkerState> {
  let handle;
  try {
    handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return fail("COPY_PILOT_LEDGER_MARKER_INVALID");
  }
  try {
    const status = await handle.stat();
    if (
      !status.isFile() ||
      (status.mode & 0o077) !== 0 ||
      status.size > 16_384
    ) {
      fail("COPY_PILOT_LEDGER_MARKER_INVALID");
    }
    const lines = (await handle.readFile("utf8")).split("\n").filter(Boolean);
    if (lines.length < 1 || lines.length > 2) {
      fail("COPY_PILOT_LEDGER_MARKER_INVALID");
    }
    let events: unknown[];
    try {
      events = lines.map((line) => JSON.parse(line));
    } catch {
      return fail("COPY_PILOT_LEDGER_MARKER_INVALID");
    }
    const prepared = events[0] as PreparedEvent;
    const claimed = events[1] as ClaimedEvent | undefined;
    if (
      prepared.schemaVersion !== SCHEMA_VERSION ||
      prepared.kind !== "prepared" ||
      !SHA256.test(prepared.markerId) ||
      !SHA256.test(prepared.digest) ||
      eventDigest(prepared) !== prepared.digest ||
      (claimed != null &&
        (claimed.schemaVersion !== SCHEMA_VERSION ||
          claimed.kind !== "claimed" ||
          claimed.preparedDigest !== prepared.digest ||
          !SHA256.test(claimed.authorizationDigest) ||
          !SHA256.test(claimed.digest) ||
          eventDigest(claimed) !== claimed.digest))
    ) {
      fail("COPY_PILOT_LEDGER_MARKER_INVALID");
    }
    return {
      markerPath,
      markerDevice: String(status.dev),
      markerInode: String(status.ino),
      markerBirthtimeMs: String(status.birthtimeMs),
      prepared,
      ...(claimed == null ? {} : { claimed }),
    };
  } finally {
    await handle.close();
  }
}

function handleFor(state: MarkerState): CopyPilotLedgerIdentity {
  const handle = Object.freeze({}) as CopyPilotLedgerIdentity;
  IDENTITIES.set(handle, state);
  return handle;
}

function ledgerIdentityDigest(state: MarkerState): string {
  return canonicalDigest({
    schemaVersion: "copy-pilot-ledger-file-identity/2026-08-05-v1",
    preparedDigest: state.prepared.digest,
    markerDevice: state.markerDevice,
    markerInode: state.markerInode,
    markerBirthtimeMs: state.markerBirthtimeMs,
  });
}

export async function prepareCopyPilotLedgerIdentity(input: {
  ledgerPath: string;
  authorizationClaimPath: string;
  markerPath: string;
  campaignId: string;
}): Promise<CopyPilotPreparedLedgerIdentity> {
  const paths = await normalizedPaths(input);
  if (
    (await fileExists(paths.ledgerPath)) ||
    (await fileExists(paths.authorizationClaimPath))
  ) {
    fail("COPY_PILOT_LEDGER_FILES_ALREADY_EXIST");
  }
  const material = {
    schemaVersion: SCHEMA_VERSION,
    kind: "prepared" as const,
    markerId: randomBytes(32).toString("hex"),
    ledgerPath: paths.ledgerPath,
    authorizationClaimPath: paths.authorizationClaimPath,
    campaignId: paths.campaignId,
  };
  const prepared = Object.freeze({
    ...material,
    digest: canonicalDigest(material),
  });
  let marker;
  try {
    marker = await open(
      paths.markerPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return fail("COPY_PILOT_LEDGER_MARKER_ALREADY_EXISTS");
  }
  try {
    await marker.writeFile(`${JSON.stringify(prepared)}\n`, "utf8");
    await marker.sync();
  } finally {
    await marker.close();
  }
  const state = await readMarker(paths.markerPath);
  return Object.freeze({
    handle: handleFor(state),
    markerPath: paths.markerPath,
    ledgerIdentityDigest: ledgerIdentityDigest(state),
  });
}

export async function loadCopyPilotLedgerIdentity(input: {
  ledgerPath: string;
  authorizationClaimPath: string;
  markerPath: string;
  campaignId: string;
}): Promise<CopyPilotPreparedLedgerIdentity> {
  const paths = await normalizedPaths(input);
  const state = await readMarker(paths.markerPath);
  if (
    state.prepared.ledgerPath !== paths.ledgerPath ||
    state.prepared.authorizationClaimPath !== paths.authorizationClaimPath ||
    state.prepared.campaignId !== paths.campaignId
  ) {
    fail("COPY_PILOT_LEDGER_IDENTITY_MISMATCH");
  }
  const ledgerExists = await fileExists(paths.ledgerPath);
  const claimExists = await fileExists(paths.authorizationClaimPath);
  if (
    ledgerExists !== claimExists ||
    (state.claimed != null && !ledgerExists)
  ) {
    fail("COPY_PILOT_LEDGER_IDENTITY_DRIFT");
  }
  if (state.claimed != null) {
    const [ledger, claim] = await Promise.all([
      fileIdentity(paths.ledgerPath),
      fileIdentity(paths.authorizationClaimPath),
    ]);
    if (
      ledger.device !== state.claimed.ledgerDevice ||
      ledger.inode !== state.claimed.ledgerInode ||
      claim.device !== state.claimed.claimDevice ||
      claim.inode !== state.claimed.claimInode
    ) {
      fail("COPY_PILOT_LEDGER_IDENTITY_DRIFT");
    }
  }
  return Object.freeze({
    handle: handleFor(state),
    markerPath: paths.markerPath,
    ledgerIdentityDigest: ledgerIdentityDigest(state),
  });
}

export async function markCopyPilotLedgerIdentityClaimed(
  identity: CopyPilotLedgerIdentity,
  input: { authorizationDigest: string },
): Promise<void> {
  const expected = IDENTITIES.get(identity);
  if (!expected) fail("COPY_PILOT_LEDGER_IDENTITY_UNTRUSTED");
  if (!SHA256.test(input.authorizationDigest)) {
    fail("COPY_PILOT_LEDGER_AUTHORIZATION_DIGEST_INVALID");
  }
  const lockPath = `${expected.markerPath}.lock`;
  let lock;
  try {
    lock = await open(
      lockPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
  } catch {
    return fail("COPY_PILOT_LEDGER_IDENTITY_BUSY");
  }
  try {
    await lock.writeFile(`${process.pid}\n`, "utf8");
    await lock.sync();
    const state = await readMarker(expected.markerPath);
    if (
      state.markerDevice !== expected.markerDevice ||
      state.markerInode !== expected.markerInode ||
      state.markerBirthtimeMs !== expected.markerBirthtimeMs ||
      canonicalDigest(state.prepared) !== canonicalDigest(expected.prepared)
    ) {
      fail("COPY_PILOT_LEDGER_IDENTITY_DRIFT");
    }
    if (state.claimed != null) {
      if (state.claimed.authorizationDigest !== input.authorizationDigest) {
        fail("COPY_PILOT_LEDGER_AUTHORIZATION_MISMATCH");
      }
      IDENTITIES.set(identity, state);
      return assertCopyPilotLedgerIdentityCurrent(identity);
    }
    const [ledger, claim] = await Promise.all([
      fileIdentity(state.prepared.ledgerPath),
      fileIdentity(state.prepared.authorizationClaimPath),
    ]);
    const material = {
      schemaVersion: SCHEMA_VERSION,
      kind: "claimed" as const,
      preparedDigest: state.prepared.digest,
      authorizationDigest: input.authorizationDigest,
      ledgerDevice: ledger.device,
      ledgerInode: ledger.inode,
      claimDevice: claim.device,
      claimInode: claim.inode,
    };
    const claimed = Object.freeze({
      ...material,
      digest: canonicalDigest(material),
    });
    let marker;
    try {
      marker = await open(
        state.markerPath,
        constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
      );
    } catch {
      return fail("COPY_PILOT_LEDGER_MARKER_INVALID");
    }
    try {
      const status = await marker.stat();
      if (
        String(status.dev) !== state.markerDevice ||
        String(status.ino) !== state.markerInode
      ) {
        fail("COPY_PILOT_LEDGER_IDENTITY_DRIFT");
      }
      await marker.writeFile(`${JSON.stringify(claimed)}\n`, "utf8");
      await marker.sync();
    } finally {
      await marker.close();
    }
    IDENTITIES.set(identity, { ...state, claimed });
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function assertCopyPilotLedgerIdentityCurrent(
  identity: CopyPilotLedgerIdentity,
): Promise<void> {
  const expected = IDENTITIES.get(identity);
  if (!expected) fail("COPY_PILOT_LEDGER_IDENTITY_UNTRUSTED");
  const observed = await readMarker(expected.markerPath).catch(() =>
    fail("COPY_PILOT_LEDGER_IDENTITY_DRIFT"),
  );
  if (
    observed.markerDevice !== expected.markerDevice ||
    observed.markerInode !== expected.markerInode ||
    observed.markerBirthtimeMs !== expected.markerBirthtimeMs ||
    canonicalDigest(observed.prepared) !== canonicalDigest(expected.prepared) ||
    canonicalDigest(observed.claimed ?? null) !==
      canonicalDigest(expected.claimed ?? null)
  ) {
    fail("COPY_PILOT_LEDGER_IDENTITY_DRIFT");
  }
  if (expected.claimed != null) {
    const [ledger, claim] = await Promise.all([
      fileIdentity(expected.prepared.ledgerPath),
      fileIdentity(expected.prepared.authorizationClaimPath),
    ]);
    if (
      ledger.device !== expected.claimed.ledgerDevice ||
      ledger.inode !== expected.claimed.ledgerInode ||
      claim.device !== expected.claimed.claimDevice ||
      claim.inode !== expected.claimed.claimInode
    ) {
      fail("COPY_PILOT_LEDGER_IDENTITY_DRIFT");
    }
  }
}
