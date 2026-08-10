import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";

import {
  COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
  validateCopySonnetRecoveryZeroCallPreflightArtifact,
  type CopySonnetRecoveryZeroCallPreflightArtifact,
} from "./copy-sonnet-recovery-zero-call-preflight-artifact";
import {
  disableCopySonnetRecoveryPurposeTokens,
  provisionAndAttestCopySonnetRecoveryZeroCall,
  type CopySonnetRecoveryZeroCallPreflightInput,
} from "./copy-sonnet-recovery-zero-call-preflight";

interface WriterInput extends CopySonnetRecoveryZeroCallPreflightInput {
  secretOutputPath: string;
}

interface ProvisionedEvidence {
  secret: { tokenId: number; apiKey: string };
  artifact: unknown;
}

interface WriterDeps {
  provision?: (input: CopySonnetRecoveryZeroCallPreflightInput) => Promise<ProvisionedEvidence>;
  cleanup?: (input: CopySonnetRecoveryZeroCallPreflightInput) => Promise<void>;
  validateArtifact?: (value: unknown) => void;
  publishArtifact?: (path: string, artifact: unknown) => Promise<void>;
}

export interface CopySonnetRecoveryZeroCallPreflightSummary {
  outputPath: typeof COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH;
  secretOutputPath: string;
  artifactId: string;
  artifactDigest: string;
  tokenId: number;
  bearerTokenSha256: string;
  expiresAt: string;
  quotaCapPoints: number;
  channelId: number;
  pricingCurrency: string;
  maximumNativeCostMicrounits: number;
  dispatchAuthorization: "NOT_AUTHORIZED";
  dispatchCapable: false;
  observedModelWireCalls: 0;
}

function fail(code: string): never {
  throw new Error(code);
}

function errnoCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function closeIgnoringErrors(handle: FileHandle | undefined): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // The operation result is governed by the durable file/token cleanup below.
  }
}

async function unlinkIgnoringErrors(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Create-only and cleanup callers independently preserve their primary error.
  }
}

async function assertMissing(path: string, code: string): Promise<void> {
  try {
    await lstat(path);
    fail(code);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

function pathInside(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return (
    childRelative === "" ||
    (!childRelative.startsWith(`..${sep}`) && childRelative !== "..")
  );
}

async function validatePaths(input: WriterInput): Promise<{
  repositoryRoot: string;
  secretOutputPath: string;
  secretParentPath: string;
  secretBasename: string;
  artifactOutputPath: string;
}> {
  const repositoryRoot = await realpath(input.repositoryRoot);
  const secretOutputPath = resolve(input.secretOutputPath);
  if (secretOutputPath !== input.secretOutputPath) {
    fail("COPY_SONNET_RECOVERY_SECRET_PATH_INVALID");
  }
  const temporaryRoot = await realpath(tmpdir());
  const secretParentPath = dirname(secretOutputPath);
  const secretBasename = basename(secretOutputPath);
  const canonicalSecretParent = await realpath(secretParentPath).catch(() =>
    fail("COPY_SONNET_RECOVERY_SECRET_PARENT_INVALID"),
  );
  if (
    secretParentPath === temporaryRoot ||
    canonicalSecretParent !== secretParentPath ||
    !pathInside(temporaryRoot, secretParentPath) ||
    secretBasename === ""
  ) {
    fail("COPY_SONNET_RECOVERY_SECRET_PATH_INVALID");
  }
  const artifactOutputPath = resolve(
    repositoryRoot,
    COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
  );
  const artifactParent = await realpath(dirname(artifactOutputPath));
  if (!pathInside(repositoryRoot, artifactParent)) {
    fail("COPY_SONNET_RECOVERY_EVIDENCE_PATH_INVALID");
  }
  await assertMissing(
    artifactOutputPath,
    "COPY_SONNET_RECOVERY_EVIDENCE_EXISTS",
  );
  return {
    repositoryRoot,
    secretOutputPath,
    secretParentPath,
    secretBasename,
    artifactOutputPath,
  };
}

interface SecretReservation {
  parentPath: string;
  originalPath: string;
  anchoredPath: string;
  parentHandle: FileHandle;
  secretHandle: FileHandle;
  parentStat: Awaited<ReturnType<FileHandle["stat"]>>;
  secretStat: Awaited<ReturnType<FileHandle["stat"]>>;
}

function sameObject(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function privateParentIsValid(stat: Awaited<ReturnType<typeof lstat>>): boolean {
  const processUid = process.getuid?.();
  const mode = Number(stat.mode);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    processUid !== undefined &&
    Number(stat.uid) === processUid &&
    (mode & 0o077) === 0 &&
    (mode & 0o300) === 0o300
  );
}

async function reserveSecretPath(paths: {
  secretOutputPath: string;
  secretParentPath: string;
  secretBasename: string;
}): Promise<SecretReservation> {
  let initialParentStat: Awaited<ReturnType<typeof lstat>>;
  try {
    initialParentStat = await lstat(paths.secretParentPath);
  } catch {
    fail("COPY_SONNET_RECOVERY_SECRET_PARENT_INVALID");
  }
  if (!privateParentIsValid(initialParentStat)) {
    fail("COPY_SONNET_RECOVERY_SECRET_PARENT_INVALID");
  }

  let parentHandle: FileHandle;
  try {
    parentHandle = await open(
      paths.secretParentPath,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
  } catch {
    fail("COPY_SONNET_RECOVERY_SECRET_PARENT_INVALID");
  }
  let secretHandle: FileHandle | undefined;
  const anchoredPath = `/proc/self/fd/${parentHandle.fd}/${paths.secretBasename}`;
  try {
    const parentStat = await parentHandle.stat();
    if (
      !privateParentIsValid(parentStat) ||
      !sameObject(initialParentStat, parentStat)
    ) {
      fail("COPY_SONNET_RECOVERY_SECRET_PARENT_INVALID");
    }
    try {
      secretHandle = await open(
        anchoredPath,
        constants.O_CREAT |
          constants.O_EXCL |
          constants.O_WRONLY |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (errnoCode(error) === "EEXIST") {
        fail("COPY_SONNET_RECOVERY_SECRET_PATH_EXISTS");
      }
      throw error;
    }
    await secretHandle.chmod(0o600);
    const secretStat = await secretHandle.stat();
    if (
      !secretStat.isFile() ||
      secretStat.nlink !== 1 ||
      (secretStat.mode & 0o777) !== 0o600
    ) {
      fail("COPY_SONNET_RECOVERY_SECRET_FILE_INVALID");
    }
    return {
      parentPath: paths.secretParentPath,
      originalPath: paths.secretOutputPath,
      anchoredPath,
      parentHandle,
      secretHandle,
      parentStat,
      secretStat,
    };
  } catch (error) {
    await closeIgnoringErrors(secretHandle);
    if (secretHandle) await unlinkIgnoringErrors(anchoredPath);
    await closeIgnoringErrors(parentHandle);
    throw error;
  }
}

async function verifySecretReservation(
  reservation: SecretReservation,
): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>[];
  try {
    stats = await Promise.all([
      reservation.parentHandle.stat(),
      lstat(reservation.parentPath),
      lstat(reservation.anchoredPath),
      lstat(reservation.originalPath),
    ]);
  } catch {
    fail("COPY_SONNET_RECOVERY_SECRET_RESERVATION_DRIFT");
  }
  const [openParentStat, pathParentStat, anchoredSecretStat, pathSecretStat] =
    stats;
  if (
    !privateParentIsValid(openParentStat) ||
    !privateParentIsValid(pathParentStat) ||
    !sameObject(reservation.parentStat, openParentStat) ||
    !sameObject(reservation.parentStat, pathParentStat) ||
    !sameObject(reservation.secretStat, anchoredSecretStat) ||
    !sameObject(reservation.secretStat, pathSecretStat) ||
    !anchoredSecretStat.isFile() ||
    anchoredSecretStat.nlink !== 1 ||
    (Number(anchoredSecretStat.mode) & 0o777) !== 0o600
  ) {
    fail("COPY_SONNET_RECOVERY_SECRET_RESERVATION_DRIFT");
  }
}

async function removeReservedSecret(
  reservation: SecretReservation,
): Promise<void> {
  try {
    const current = await lstat(reservation.anchoredPath);
    if (!sameObject(reservation.secretStat, current)) {
      fail("COPY_SONNET_RECOVERY_SECRET_RESERVATION_DRIFT");
    }
    await unlink(reservation.anchoredPath);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

async function publishArtifactCreateOnly(
  artifactOutputPath: string,
  artifact: unknown,
): Promise<void> {
  const temporaryPath = resolve(
    dirname(artifactOutputPath),
    `.${basename(artifactOutputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o644,
    );
    await handle.chmod(0o644);
    await handle.writeFile(`${JSON.stringify(artifact, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryPath, artifactOutputPath);
    published = true;
    await unlink(temporaryPath);
    const directory = await open(dirname(artifactOutputPath), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await closeIgnoringErrors(handle);
    await unlinkIgnoringErrors(temporaryPath);
    if (published) await unlinkIgnoringErrors(artifactOutputPath);
    throw error;
  }
}

async function defaultCleanup(
  input: CopySonnetRecoveryZeroCallPreflightInput,
): Promise<void> {
  await disableCopySonnetRecoveryPurposeTokens(input, fetch, [], 5_000);
}

function summary(
  secretOutputPath: string,
  artifact: CopySonnetRecoveryZeroCallPreflightArtifact,
): CopySonnetRecoveryZeroCallPreflightSummary {
  return {
    outputPath: COPY_SONNET_RECOVERY_ZERO_CALL_PREFLIGHT_OUTPUT_PATH,
    secretOutputPath,
    artifactId: artifact.artifactId,
    artifactDigest: artifact.artifactDigest,
    tokenId: artifact.credential.tokenId,
    bearerTokenSha256: artifact.credential.bearerTokenSha256,
    expiresAt: artifact.credential.expiresAt,
    quotaCapPoints: artifact.credential.quotaCapPoints,
    channelId: artifact.route.channelId,
    pricingCurrency: artifact.pricing.currency,
    maximumNativeCostMicrounits:
      artifact.pricing.maximumNativeCostMicrounits,
    dispatchAuthorization: artifact.dispatchAuthorization,
    dispatchCapable: artifact.dispatchCapable,
    observedModelWireCalls: artifact.observedModelWireCalls,
  };
}

export async function writeCopySonnetRecoveryZeroCallPreflightEvidence(
  input: WriterInput,
  deps: WriterDeps = {},
): Promise<CopySonnetRecoveryZeroCallPreflightSummary> {
  const paths = await validatePaths(input);
  const reservation = await reserveSecretPath(paths);
  let provisioned: ProvisionedEvidence | undefined;
  let artifactPublished = false;
  try {
    provisioned = await (
      deps.provision ?? provisionAndAttestCopySonnetRecoveryZeroCall
    )({
      ...input,
      repositoryRoot: paths.repositoryRoot,
    });
    await reservation.secretHandle.writeFile(
      `${JSON.stringify({
        schemaVersion:
          "site-builder-copy-sonnet-recovery-secret/2026-08-10-v1",
        purpose: "site_builder_copy_sonnet_recovery",
        tokenId: provisioned.secret.tokenId,
        apiKey: provisioned.secret.apiKey,
        bearerTokenSha256: (
          provisioned.artifact as CopySonnetRecoveryZeroCallPreflightArtifact
        ).credential?.bearerTokenSha256,
        expiresAt: (
          provisioned.artifact as CopySonnetRecoveryZeroCallPreflightArtifact
        ).credential?.expiresAt,
      })}\n`,
      "utf8",
    );
    await reservation.secretHandle.sync();

    const validateArtifact: (value: unknown) => void =
      deps.validateArtifact ??
      validateCopySonnetRecoveryZeroCallPreflightArtifact;
    validateArtifact(provisioned.artifact);
    await verifySecretReservation(reservation);
    await (deps.publishArtifact ?? publishArtifactCreateOnly)(
      paths.artifactOutputPath,
      provisioned.artifact,
    );
    artifactPublished = true;
    await verifySecretReservation(reservation);
    const result = summary(
      paths.secretOutputPath,
      provisioned.artifact as CopySonnetRecoveryZeroCallPreflightArtifact,
    );
    await reservation.secretHandle.close();
    await reservation.parentHandle.close();
    return result;
  } catch (error) {
    let cleanupFailed = false;
    if (provisioned) {
      try {
        await (deps.cleanup ?? defaultCleanup)(input);
      } catch {
        cleanupFailed = true;
      }
    }
    if (artifactPublished) {
      await unlinkIgnoringErrors(paths.artifactOutputPath);
    }
    let secretCleanupFailed = false;
    try {
      await removeReservedSecret(reservation);
    } catch {
      secretCleanupFailed = true;
    }
    await closeIgnoringErrors(reservation.secretHandle);
    await closeIgnoringErrors(reservation.parentHandle);
    if (secretCleanupFailed) {
      fail("COPY_SONNET_RECOVERY_WRITER_SECRET_CLEANUP_FAILED");
    }
    if (cleanupFailed) {
      fail("COPY_SONNET_RECOVERY_WRITER_TOKEN_CLEANUP_FAILED");
    }
    throw error;
  }
}
