import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import type {
  NativeModelEvaluationCostSettlement,
  NativeModelEvaluationCurrency,
} from "./model-evaluation-native-cost-safety";

const LEDGER_ID = /^[a-z0-9][a-z0-9._/-]{0,127}$/;
const EXECUTION_ID = /^[A-Za-z0-9][A-Za-z0-9:._/-]{7,511}$/;
const PICO_UNITS = /^(?:0|[1-9][0-9]*)$/;
const MARKER_FILE = ".site-builder-native-model-evaluation-ledger-id";
const NATIVE_CURRENCIES = Object.freeze(["CNY", "USD"] as const);
const SHA256 = /^[a-f0-9]{64}$/;
const SETTLEMENT_BASIS = /^frozen_openox_native_pricing@.+$/;
const CLAIM_FILE_MAX_BYTES = 1024n * 1024n;
const LEDGER_MARKER = /^[a-f0-9-]{36}$/;

const NATIVE_OBJECT_KEYS = Object.keys;
const NATIVE_OBJECT_HAS_OWN = Object.hasOwn;
const NATIVE_ARRAY_SORT = Array.prototype.sort;
const NATIVE_REFLECT_APPLY = Reflect.apply;
const NATIVE_BIGINT = BigInt;
const NATIVE_BIGINT_TO_STRING = BigInt.prototype.toString;
const NATIVE_NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;

export type NativeModelEvaluationLedgerFreezeReason =
  | "unknown_settlement"
  | "not_incurred_after_dispatch"
  | "settlement_execution_id_mismatch"
  | "settlement_currency_mismatch"
  | "settlement_basis_mismatch"
  | "settlement_exceeds_reservation"
  | "native_budget_exhausted"
  | "ledger_write_failure";

interface NativeReservation {
  readonly currency: NativeModelEvaluationCurrency;
  readonly nativePicoUnits: bigint;
  readonly wireCalls: number;
}

interface NativeAuthorizationState {
  readonly executorClaimId: string;
  readonly settlementBasis: Extract<
    NativeModelEvaluationCostSettlement,
    { state: "settled" }
  >["basis"];
  readonly maximumsByCurrency: Readonly<
    Record<NativeModelEvaluationCurrency, bigint>
  >;
  readonly maxDispatchExecutions: number;
  readonly maxWireCalls: number;
  readonly claimFilePath: string;
  readonly claimFileDevice: bigint;
  readonly claimFileInode: bigint;
  claimFileCtimeNs: bigint;
  claimFileSize: bigint;
  dispatchExecutions: number;
  wireCalls: number;
  frozen: NativeModelEvaluationLedgerFreezeReason | null;
  readonly committed: Record<NativeModelEvaluationCurrency, bigint>;
  readonly reserved: Record<NativeModelEvaluationCurrency, bigint>;
  readonly reservations: Map<string, NativeReservation>;
  readonly seenExecutionIds: Set<string>;
}

export interface NativeModelEvaluationAuthorizationLedger {
  readonly ledgerId: string;
  readonly directorySha256: string;
  claim(input: {
    authorizationId: string;
    executorClaimId: string;
    settlementBasis: Extract<
      NativeModelEvaluationCostSettlement,
      { state: "settled" }
    >["basis"];
    maximumsByCurrency: Record<NativeModelEvaluationCurrency, string>;
    maxDispatchExecutions: number;
    maxWireCalls: number;
  }): boolean;
  reserve(input: {
    authorizationId: string;
    executorClaimId: string;
    executionId: string;
    currency: NativeModelEvaluationCurrency;
    nativePicoUnits: string;
    wireCalls: number;
  }): boolean;
  settle(input: {
    authorizationId: string;
    executorClaimId: string;
    executionId: string;
    settlement: NativeModelEvaluationCostSettlement;
  }): boolean;
  freeze(input: {
    authorizationId: string;
    executorClaimId: string;
    reason: NativeModelEvaluationLedgerFreezeReason;
  }): boolean;
  snapshot(authorizationId: string): Readonly<{
    frozen: boolean;
    freezeReason?: NativeModelEvaluationLedgerFreezeReason;
    maxDispatchExecutions: number;
    maxWireCalls: number;
    dispatchExecutions: number;
    wireCalls: number;
    totalsByCurrency: Readonly<
      Record<
        NativeModelEvaluationCurrency,
        Readonly<{
          capPicoUnits: string;
          committedPicoUnits: string;
          reservedPicoUnits: string;
          remainingPicoUnits: string;
        }>
      >
    >;
  }>;
  inspectAuthorization(authorizationId: string): Readonly<
    | {
        state: "active_process";
        authorizationId: string;
        ledgerId: string;
        ledgerDirectorySha256: string;
        hasInFlightReservations: boolean;
      }
    | {
        state: "not_claimed";
        authorizationId: string;
        ledgerId: string;
        ledgerDirectorySha256: string;
      }
    | {
        state: "claim_record_missing_after_restart";
        authorizationId: string;
        ledgerId: string;
        ledgerDirectorySha256: string;
        authorizationIdSha256: string;
        manualReconciliationRequired: true;
      }
    | {
        state: "non_resumable_after_restart";
        authorizationId: string;
        ledgerId: string;
        ledgerDirectorySha256: string;
        claimFileSha256: string;
        manualReconciliationRequired: true;
      }
  >;
}

function nativeArraySort<T>(values: T[]): T[] {
  return NATIVE_REFLECT_APPLY(NATIVE_ARRAY_SORT, values, []) as T[];
}

function nativeBigIntString(value: bigint): string {
  return NATIVE_REFLECT_APPLY(NATIVE_BIGINT_TO_STRING, value, []) as string;
}

function exactCurrencyRecord(
  value: unknown,
): value is Record<NativeModelEvaluationCurrency, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = nativeArraySort([...NATIVE_OBJECT_KEYS(value)]);
  return (
    keys.length === NATIVE_CURRENCIES.length &&
    keys.every((key, index) => key === NATIVE_CURRENCIES[index]) &&
    NATIVE_CURRENCIES.every((currency) =>
      NATIVE_OBJECT_HAS_OWN(value, currency),
    )
  );
}

function canonicalPicoUnits(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !PICO_UNITS.test(value)) {
    throw new Error(`${label} must be a canonical native pico-unit string`);
  }
  const parsed = NATIVE_BIGINT(value);
  if (parsed <= 0n) throw new Error(`${label} must be positive`);
  return parsed;
}

function assertOwnerOnlyDirectory(
  directory: string,
  allowMarkerCreation: boolean,
): Readonly<{
  directory: string;
  markerPath: string;
  markerDevice: bigint;
  markerInode: bigint;
  markerCtimeNs: bigint;
  markerSize: bigint;
  markerSeed: string;
  claimedAuthorizationDigests: readonly string[];
  sha256: string;
}> {
  if (!isAbsolute(directory)) {
    throw new Error("native evaluation ledger directory must be absolute");
  }
  const absoluteDirectory = resolve(directory);
  const directoryStats = lstatSync(absoluteDirectory, { bigint: true });
  const realDirectory = realpathSync.native(absoluteDirectory);
  if (
    !directoryStats.isDirectory() ||
    directoryStats.isSymbolicLink() ||
    realDirectory !== absoluteDirectory
  ) {
    throw new Error("native evaluation ledger requires a real directory");
  }
  if (
    (directoryStats.mode & 0o077n) !== 0n ||
    directoryStats.uid !== NATIVE_BIGINT(process.getuid?.() ?? -1)
  ) {
    throw new Error("native evaluation ledger directory must be owner-only");
  }
  const markerPath = join(realDirectory, MARKER_FILE);
  let descriptor: number | undefined;
  try {
    if (allowMarkerCreation) {
      try {
        let markerMissing = false;
        try {
          lstatSync(markerPath);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            markerMissing = true;
          } else {
            throw error;
          }
        }
        if (
          markerMissing &&
          readdirSync(realDirectory).some((name) =>
            /^[a-f0-9]{64}\.jsonl$/.test(name),
          )
        ) {
          throw new Error(
            "native evaluation ledger marker is missing after claims exist",
          );
        }
        descriptor = openSync(markerPath, "wx", 0o600);
        writeAllSync(descriptor, `${randomUUID()}\n`);
        fsyncSync(descriptor);
      } catch (error) {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "EEXIST"
        ) {
          throw error;
        }
      } finally {
        if (descriptor !== undefined) {
          closeSync(descriptor);
          descriptor = undefined;
        }
      }
    }
    descriptor = openSync(
      markerPath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    const markerStats = fstatSync(descriptor, { bigint: true });
    const marker = readFileSync(descriptor, "utf8");
    const markerLines = marker.split("\n");
    const markerSeed = markerLines.shift();
    const markerEndsWithNewline = markerLines.pop() === "";
    const claimedAuthorizationDigests = markerLines;
    if (
      !markerStats.isFile() ||
      markerStats.isSymbolicLink() ||
      markerStats.nlink !== 1n ||
      (markerStats.mode & 0o077n) !== 0n ||
      markerStats.uid !== directoryStats.uid ||
      markerStats.size > CLAIM_FILE_MAX_BYTES ||
      !markerEndsWithNewline ||
      !markerSeed ||
      !LEDGER_MARKER.test(markerSeed) ||
      claimedAuthorizationDigests.some((digest) => !SHA256.test(digest))
    ) {
      throw new Error("native evaluation ledger marker is invalid");
    }
    const directoryDescriptor = openSync(realDirectory, fsConstants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
    const identity = [
      realDirectory,
      directoryStats.dev.toString(),
      directoryStats.ino.toString(),
      markerStats.dev.toString(),
      markerStats.ino.toString(),
      marker,
    ].join("\0");
    return Object.freeze({
      directory: realDirectory,
      markerPath,
      markerDevice: markerStats.dev,
      markerInode: markerStats.ino,
      markerCtimeNs: markerStats.ctimeNs,
      markerSize: markerStats.size,
      markerSeed,
      claimedAuthorizationDigests: Object.freeze([
        ...claimedAuthorizationDigests,
      ]),
      sha256: createHash("sha256").update(identity).digest("hex"),
    });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function writeAllSync(descriptor: number, value: string): void {
  const payload = Buffer.from(value, "utf8");
  let offset = 0;
  while (offset < payload.byteLength) {
    const written = writeSync(
      descriptor,
      payload,
      offset,
      payload.byteLength - offset,
    );
    if (!NATIVE_NUMBER_IS_SAFE_INTEGER(written) || written <= 0) {
      throw new Error("native evaluation ledger write was incomplete");
    }
    offset += written;
  }
}

function claimFileName(authorizationId: string): string {
  return `${authorizationIdSha256(authorizationId)}.jsonl`;
}

function authorizationIdSha256(authorizationId: string): string {
  return createHash("sha256").update(authorizationId).digest("hex");
}

function assertAuthorizationId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._/-]{7,127}$/.test(value)
  ) {
    throw new Error("native evaluation authorization id is invalid");
  }
}

function assertExecutorClaimId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9:._/-]{7,511}$/.test(value)
  ) {
    throw new Error("native evaluation executor claim id is invalid");
  }
}

function assertExecutionId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !EXECUTION_ID.test(value)) {
    throw new Error("native evaluation execution id is invalid");
  }
}

function assertCurrency(
  value: unknown,
): asserts value is NativeModelEvaluationCurrency {
  if (value !== "CNY" && value !== "USD") {
    throw new Error("native evaluation currency is invalid");
  }
}

function assertSettlementBasis(
  value: unknown,
): asserts value is Extract<
  NativeModelEvaluationCostSettlement,
  { state: "settled" }
>["basis"] {
  if (typeof value !== "string" || !SETTLEMENT_BASIS.test(value)) {
    throw new Error("native evaluation settlement basis is invalid");
  }
}

export function initializeNativeModelEvaluationAuthorizationLedgerDirectory(
  directory: string,
): Readonly<{ directorySha256: string }> {
  const identity = assertOwnerOnlyDirectory(directory, true);
  return Object.freeze({ directorySha256: identity.sha256 });
}

export function createNativeModelEvaluationAuthorizationLedger(options: {
  ledgerId: string;
  directory: string;
  expectedDirectorySha256: string;
}): NativeModelEvaluationAuthorizationLedger {
  if (!LEDGER_ID.test(options?.ledgerId ?? "")) {
    throw new Error("native evaluation ledger id is invalid");
  }
  let identity = assertOwnerOnlyDirectory(options.directory, true);
  if (
    !SHA256.test(options.expectedDirectorySha256) ||
    options.expectedDirectorySha256 !== identity.sha256
  ) {
    throw new Error("native evaluation ledger directory digest does not match");
  }
  const states = new Map<string, NativeAuthorizationState>();
  const claimedAuthorizationDigests = new Set(
    identity.claimedAuthorizationDigests,
  );

  const assertDirectoryIdentity = () => {
    const current = assertOwnerOnlyDirectory(identity.directory, false);
    if (
      current.sha256 !== identity.sha256 ||
      current.markerPath !== identity.markerPath ||
      current.markerDevice !== identity.markerDevice ||
      current.markerInode !== identity.markerInode ||
      current.markerCtimeNs !== identity.markerCtimeNs ||
      current.markerSize !== identity.markerSize
    ) {
      throw new Error("native evaluation ledger directory identity changed");
    }
  };

  const append = (state: NativeAuthorizationState, event: unknown): void => {
    assertDirectoryIdentity();
    const descriptor = openSync(
      state.claimFilePath,
      fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    );
    try {
      const before = fstatSync(descriptor, { bigint: true });
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        (before.mode & 0o077n) !== 0n ||
        before.dev !== state.claimFileDevice ||
        before.ino !== state.claimFileInode ||
        before.ctimeNs !== state.claimFileCtimeNs ||
        before.size !== state.claimFileSize ||
        before.size > CLAIM_FILE_MAX_BYTES
      ) {
        throw new Error("native evaluation ledger claim file identity changed");
      }
      const payload = `${JSON.stringify(event)}\n`;
      writeAllSync(descriptor, payload);
      fsyncSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.nlink !== 1n ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !==
          before.size + NATIVE_BIGINT(Buffer.byteLength(payload, "utf8"))
      ) {
        throw new Error(
          "native evaluation ledger claim file changed during append",
        );
      }
      state.claimFileCtimeNs = after.ctimeNs;
      state.claimFileSize = after.size;
    } finally {
      closeSync(descriptor);
    }
  };

  const appendAuthorizationClaimDigest = (authorizationId: string): void => {
    const digest = authorizationIdSha256(authorizationId);
    if (claimedAuthorizationDigests.has(digest)) return;
    assertDirectoryIdentity();
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        identity.markerPath,
        fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
      );
      const before = fstatSync(descriptor, { bigint: true });
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1n ||
        (before.mode & 0o077n) !== 0n ||
        before.dev !== identity.markerDevice ||
        before.ino !== identity.markerInode ||
        before.ctimeNs !== identity.markerCtimeNs ||
        before.size !== identity.markerSize
      ) {
        throw new Error("native evaluation ledger marker identity changed");
      }
      const payload = `${digest}\n`;
      writeAllSync(descriptor, payload);
      fsyncSync(descriptor);
      const after = fstatSync(descriptor, { bigint: true });
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.nlink !== 1n ||
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !==
          before.size + NATIVE_BIGINT(Buffer.byteLength(payload, "utf8"))
      ) {
        throw new Error(
          "native evaluation ledger marker changed during append",
        );
      }
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    identity = assertOwnerOnlyDirectory(identity.directory, false);
    if (!identity.claimedAuthorizationDigests.includes(digest)) {
      throw new Error("native evaluation ledger claim marker did not persist");
    }
    claimedAuthorizationDigests.add(digest);
  };

  const freeze = (
    authorizationId: string,
    state: NativeAuthorizationState,
    reason: NativeModelEvaluationLedgerFreezeReason,
  ): boolean => {
    if (state.frozen) return false;
    try {
      append(state, { event: "frozen", authorizationId, reason });
      state.frozen = reason;
    } catch (error) {
      state.frozen = "ledger_write_failure";
      throw error;
    }
    return true;
  };

  const appendOrFreeze = (
    state: NativeAuthorizationState,
    event: unknown,
  ): void => {
    try {
      append(state, event);
    } catch (error) {
      state.frozen = "ledger_write_failure";
      throw error;
    }
  };

  const ledger: NativeModelEvaluationAuthorizationLedger = {
    ledgerId: options.ledgerId,
    directorySha256: identity.sha256,
    claim(input) {
      assertAuthorizationId(input?.authorizationId);
      assertExecutorClaimId(input?.executorClaimId);
      assertSettlementBasis(input?.settlementBasis);
      if (
        !exactCurrencyRecord(input?.maximumsByCurrency) ||
        !NATIVE_NUMBER_IS_SAFE_INTEGER(input?.maxDispatchExecutions) ||
        input.maxDispatchExecutions <= 0 ||
        !NATIVE_NUMBER_IS_SAFE_INTEGER(input?.maxWireCalls) ||
        input.maxWireCalls <= 0
      ) {
        throw new Error("native evaluation authorization claim is invalid");
      }
      const maximumsByCurrency = Object.freeze({
        CNY: canonicalPicoUnits(input.maximumsByCurrency.CNY, "CNY cap"),
        USD: canonicalPicoUnits(input.maximumsByCurrency.USD, "USD cap"),
      });
      const authorizationDigest = authorizationIdSha256(input.authorizationId);
      if (
        states.has(input.authorizationId) ||
        claimedAuthorizationDigests.has(authorizationDigest)
      ) {
        return false;
      }
      assertDirectoryIdentity();
      // Claiming the authorization in the append-only marker happens before
      // creating the per-authorization file. A crash or a later file deletion
      // can therefore deny a retry, but can never reissue spend authority.
      appendAuthorizationClaimDigest(input.authorizationId);
      const claimFilePath = join(
        identity.directory,
        claimFileName(input.authorizationId),
      );
      let descriptor: number | undefined;
      try {
        try {
          descriptor = openSync(claimFilePath, "wx", 0o600);
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "EEXIST"
          ) {
            return false;
          }
          throw error;
        }
        const claim = {
          event: "authorization_claimed",
          authorizationId: input.authorizationId,
          executorClaimId: input.executorClaimId,
          settlementBasis: input.settlementBasis,
          maximumsByCurrency: {
            CNY: nativeBigIntString(maximumsByCurrency.CNY),
            USD: nativeBigIntString(maximumsByCurrency.USD),
          },
          maxDispatchExecutions: input.maxDispatchExecutions,
          maxWireCalls: input.maxWireCalls,
        };
        writeAllSync(descriptor, `${JSON.stringify(claim)}\n`);
        fsyncSync(descriptor);
        const stats = fstatSync(descriptor, { bigint: true });
        if (
          !stats.isFile() ||
          stats.isSymbolicLink() ||
          stats.nlink !== 1n ||
          (stats.mode & 0o077n) !== 0n
        ) {
          throw new Error("native evaluation ledger claim file is invalid");
        }
        const directoryDescriptor = openSync(
          identity.directory,
          fsConstants.O_RDONLY,
        );
        try {
          fsyncSync(directoryDescriptor);
        } finally {
          closeSync(directoryDescriptor);
        }
        states.set(input.authorizationId, {
          executorClaimId: input.executorClaimId,
          settlementBasis: input.settlementBasis,
          maximumsByCurrency,
          maxDispatchExecutions: input.maxDispatchExecutions,
          maxWireCalls: input.maxWireCalls,
          claimFilePath,
          claimFileDevice: stats.dev,
          claimFileInode: stats.ino,
          claimFileCtimeNs: stats.ctimeNs,
          claimFileSize: stats.size,
          dispatchExecutions: 0,
          wireCalls: 0,
          frozen: null,
          committed: { CNY: 0n, USD: 0n },
          reserved: { CNY: 0n, USD: 0n },
          reservations: new Map(),
          seenExecutionIds: new Set(),
        });
        return true;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    },
    reserve(input) {
      assertAuthorizationId(input?.authorizationId);
      assertExecutorClaimId(input?.executorClaimId);
      assertExecutionId(input?.executionId);
      assertCurrency(input?.currency);
      const nativePicoUnits = canonicalPicoUnits(
        input?.nativePicoUnits,
        "native reservation amount",
      );
      if (
        !NATIVE_NUMBER_IS_SAFE_INTEGER(input?.wireCalls) ||
        input.wireCalls <= 0
      ) {
        throw new Error("native evaluation reservation wire calls are invalid");
      }
      const state = states.get(input.authorizationId);
      if (!state || state.executorClaimId !== input.executorClaimId)
        return false;
      if (state.frozen)
        throw new Error("native evaluation authorization is frozen");
      if (
        state.seenExecutionIds.has(input.executionId) ||
        state.dispatchExecutions + 1 > state.maxDispatchExecutions ||
        state.wireCalls + input.wireCalls > state.maxWireCalls
      ) {
        return false;
      }
      const available =
        state.maximumsByCurrency[input.currency] -
        state.committed[input.currency] -
        state.reserved[input.currency];
      if (nativePicoUnits > available) {
        freeze(input.authorizationId, state, "native_budget_exhausted");
        return false;
      }
      appendOrFreeze(state, {
        event: "reserved",
        authorizationId: input.authorizationId,
        executionId: input.executionId,
        currency: input.currency,
        nativePicoUnits: nativeBigIntString(nativePicoUnits),
        wireCalls: input.wireCalls,
      });
      state.dispatchExecutions += 1;
      state.wireCalls += input.wireCalls;
      state.reserved[input.currency] += nativePicoUnits;
      state.seenExecutionIds.add(input.executionId);
      state.reservations.set(
        input.executionId,
        Object.freeze({
          currency: input.currency,
          nativePicoUnits,
          wireCalls: input.wireCalls,
        }),
      );
      return true;
    },
    settle(input) {
      assertAuthorizationId(input?.authorizationId);
      assertExecutorClaimId(input?.executorClaimId);
      assertExecutionId(input?.executionId);
      const state = states.get(input.authorizationId);
      if (!state || state.executorClaimId !== input.executorClaimId)
        return false;
      if (state.frozen) return false;
      const reservation = state.reservations.get(input.executionId);
      if (!reservation) return false;
      const settlement = input.settlement;
      if (!settlement || settlement.state !== "settled") {
        freeze(
          input.authorizationId,
          state,
          settlement?.state === "not_incurred"
            ? "not_incurred_after_dispatch"
            : "unknown_settlement",
        );
        return false;
      }
      if (settlement.executionId !== input.executionId) {
        freeze(
          input.authorizationId,
          state,
          "settlement_execution_id_mismatch",
        );
        return false;
      }
      if (settlement.currency !== reservation.currency) {
        freeze(input.authorizationId, state, "settlement_currency_mismatch");
        return false;
      }
      if (settlement.basis !== state.settlementBasis) {
        freeze(input.authorizationId, state, "settlement_basis_mismatch");
        return false;
      }
      let settledPicoUnits: bigint;
      try {
        settledPicoUnits = canonicalPicoUnits(
          settlement.nativePicoUnits,
          "native settlement amount",
        );
      } catch {
        freeze(input.authorizationId, state, "settlement_exceeds_reservation");
        return false;
      }
      if (settledPicoUnits > reservation.nativePicoUnits) {
        freeze(input.authorizationId, state, "settlement_exceeds_reservation");
        return false;
      }
      appendOrFreeze(state, {
        event: "settled",
        authorizationId: input.authorizationId,
        executionId: input.executionId,
        currency: settlement.currency,
        nativePicoUnits: nativeBigIntString(settledPicoUnits),
        basis: settlement.basis,
      });
      state.reserved[reservation.currency] -= reservation.nativePicoUnits;
      state.committed[reservation.currency] += settledPicoUnits;
      state.reservations.delete(input.executionId);
      return true;
    },
    freeze(input) {
      assertAuthorizationId(input?.authorizationId);
      assertExecutorClaimId(input?.executorClaimId);
      const state = states.get(input.authorizationId);
      if (!state || state.executorClaimId !== input.executorClaimId)
        return false;
      if (
        input.reason !== "unknown_settlement" &&
        input.reason !== "not_incurred_after_dispatch" &&
        input.reason !== "settlement_execution_id_mismatch" &&
        input.reason !== "settlement_currency_mismatch" &&
        input.reason !== "settlement_basis_mismatch" &&
        input.reason !== "settlement_exceeds_reservation" &&
        input.reason !== "native_budget_exhausted" &&
        input.reason !== "ledger_write_failure"
      ) {
        throw new Error("native evaluation freeze reason is invalid");
      }
      return freeze(input.authorizationId, state, input.reason);
    },
    snapshot(authorizationId) {
      assertAuthorizationId(authorizationId);
      const state = states.get(authorizationId);
      if (!state)
        throw new Error("native evaluation authorization is not claimed");
      const totalsByCurrency = Object.freeze({
        CNY: Object.freeze({
          capPicoUnits: nativeBigIntString(state.maximumsByCurrency.CNY),
          committedPicoUnits: nativeBigIntString(state.committed.CNY),
          reservedPicoUnits: nativeBigIntString(state.reserved.CNY),
          remainingPicoUnits: nativeBigIntString(
            state.maximumsByCurrency.CNY -
              state.committed.CNY -
              state.reserved.CNY,
          ),
        }),
        USD: Object.freeze({
          capPicoUnits: nativeBigIntString(state.maximumsByCurrency.USD),
          committedPicoUnits: nativeBigIntString(state.committed.USD),
          reservedPicoUnits: nativeBigIntString(state.reserved.USD),
          remainingPicoUnits: nativeBigIntString(
            state.maximumsByCurrency.USD -
              state.committed.USD -
              state.reserved.USD,
          ),
        }),
      });
      return Object.freeze({
        frozen: state.frozen !== null,
        ...(state.frozen ? { freezeReason: state.frozen } : {}),
        maxDispatchExecutions: state.maxDispatchExecutions,
        maxWireCalls: state.maxWireCalls,
        dispatchExecutions: state.dispatchExecutions,
        wireCalls: state.wireCalls,
        totalsByCurrency,
      });
    },
    inspectAuthorization(authorizationId) {
      assertAuthorizationId(authorizationId);
      assertDirectoryIdentity();
      const state = states.get(authorizationId);
      if (state) {
        return Object.freeze({
          state: "active_process" as const,
          authorizationId,
          ledgerId: options.ledgerId,
          ledgerDirectorySha256: identity.sha256,
          hasInFlightReservations: state.reservations.size > 0,
        });
      }
      const claimFilePath = join(
        identity.directory,
        claimFileName(authorizationId),
      );
      const authorizationDigest = authorizationIdSha256(authorizationId);
      let descriptor: number | undefined;
      try {
        try {
          descriptor = openSync(
            claimFilePath,
            fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
          );
        } catch (error) {
          if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            if (claimedAuthorizationDigests.has(authorizationDigest)) {
              return Object.freeze({
                state: "claim_record_missing_after_restart" as const,
                authorizationId,
                ledgerId: options.ledgerId,
                ledgerDirectorySha256: identity.sha256,
                authorizationIdSha256: authorizationDigest,
                manualReconciliationRequired: true as const,
              });
            }
            return Object.freeze({
              state: "not_claimed" as const,
              authorizationId,
              ledgerId: options.ledgerId,
              ledgerDirectorySha256: identity.sha256,
            });
          }
          throw error;
        }
        const before = fstatSync(descriptor, { bigint: true });
        const claimContents = readFileSync(descriptor, "utf8");
        const after = fstatSync(descriptor, { bigint: true });
        if (
          !before.isFile() ||
          before.isSymbolicLink() ||
          before.nlink !== 1n ||
          (before.mode & 0o077n) !== 0n ||
          before.uid !== NATIVE_BIGINT(process.getuid?.() ?? -1) ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.ctimeNs !== after.ctimeNs ||
          before.size !== after.size ||
          before.size > CLAIM_FILE_MAX_BYTES ||
          claimContents.length === 0
        ) {
          throw new Error("native evaluation ledger claim file is invalid");
        }
        return Object.freeze({
          state: "non_resumable_after_restart" as const,
          authorizationId,
          ledgerId: options.ledgerId,
          ledgerDirectorySha256: identity.sha256,
          claimFileSha256: createHash("sha256")
            .update(claimContents, "utf8")
            .digest("hex"),
          manualReconciliationRequired: true as const,
        });
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    },
  };
  return Object.freeze(ledger);
}
