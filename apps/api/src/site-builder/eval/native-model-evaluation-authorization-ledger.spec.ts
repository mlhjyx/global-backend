import { createHash } from "node:crypto";
import {
  mkdtempSync,
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createNativeModelEvaluationAuthorizationLedger } from "./native-model-evaluation-authorization-ledger";

const temporaryDirectories: string[] = [];

function createLedgerDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "site-builder-native-ledger-"));
  chmodSync(directory, 0o700);
  temporaryDirectories.push(directory);
  return directory;
}

function claimInput(authorizationId = "design-spec-native-authorization-001") {
  return {
    authorizationId,
    executorClaimId: "design-spec-native-executor-claim-001",
    settlementBasis: "frozen_openox_native_pricing@2026-08-03T00:00:00.000Z",
    maximumsByCurrency: { CNY: "100", USD: "200" },
    maxDispatchExecutions: 73,
    maxWireCalls: 146,
  } as const;
}

function claimFilePath(directory: string, authorizationId: string): string {
  return join(
    directory,
    `${createHash("sha256").update(authorizationId, "utf8").digest("hex")}.jsonl`,
  );
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("native model evaluation authorization ledger", () => {
  it("claims exactly once and durably reserves then settles native CNY without FX", () => {
    const directory = createLedgerDirectory();
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger-001",
      directory,
    });

    expect(ledger.claim(claimInput())).toBe(true);
    expect(ledger.claim(claimInput())).toBe(false);
    expect(
      ledger.reserve({
        authorizationId: "design-spec-native-authorization-001",
        executorClaimId: "design-spec-native-executor-claim-001",
        executionId: "design-spec-native-execution-cny-001",
        currency: "CNY",
        nativePicoUnits: "9",
        wireCalls: 1,
      }),
    ).toBe(true);
    expect(
      ledger.settle({
        authorizationId: "design-spec-native-authorization-001",
        executorClaimId: "design-spec-native-executor-claim-001",
        executionId: "design-spec-native-execution-cny-001",
        settlement: {
          state: "settled",
          executionId: "design-spec-native-execution-cny-001",
          currency: "CNY",
          nativePicoUnits: "3",
          basis: "frozen_openox_native_pricing@2026-08-03T00:00:00.000Z",
        },
      }),
    ).toBe(true);
    expect(
      ledger.reserve({
        authorizationId: "design-spec-native-authorization-001",
        executorClaimId: "design-spec-native-executor-claim-001",
        executionId: "design-spec-native-execution-cny-001",
        currency: "CNY",
        nativePicoUnits: "1",
        wireCalls: 1,
      }),
    ).toBe(false);
    expect(ledger.snapshot("design-spec-native-authorization-001")).toEqual({
      frozen: false,
      maxDispatchExecutions: 73,
      maxWireCalls: 146,
      dispatchExecutions: 1,
      wireCalls: 1,
      totalsByCurrency: {
        CNY: {
          capPicoUnits: "100",
          committedPicoUnits: "3",
          reservedPicoUnits: "0",
          remainingPicoUnits: "97",
        },
        USD: {
          capPicoUnits: "200",
          committedPicoUnits: "0",
          reservedPicoUnits: "0",
          remainingPicoUnits: "200",
        },
      },
    });

    const claimFile = claimFilePath(
      directory,
      "design-spec-native-authorization-001",
    );
    expect(lstatSync(claimFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(claimFile, "utf8")).toContain('"event":"settled"');
  });

  it("keeps an unknown settlement reservation and durably freezes the authorization", () => {
    const directory = createLedgerDirectory();
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger-002",
      directory,
    });
    expect(ledger.claim(claimInput())).toBe(true);
    expect(
      ledger.reserve({
        authorizationId: "design-spec-native-authorization-001",
        executorClaimId: "design-spec-native-executor-claim-001",
        executionId: "design-spec-native-execution-usd-001",
        currency: "USD",
        nativePicoUnits: "11",
        wireCalls: 1,
      }),
    ).toBe(true);

    expect(
      ledger.settle({
        authorizationId: "design-spec-native-authorization-001",
        executorClaimId: "design-spec-native-executor-claim-001",
        executionId: "design-spec-native-execution-usd-001",
        settlement: { state: "unknown", reason: "provider_ack_unknown" },
      }),
    ).toBe(false);
    expect(
      ledger.snapshot("design-spec-native-authorization-001"),
    ).toMatchObject({
      frozen: true,
      freezeReason: "unknown_settlement",
      totalsByCurrency: {
        USD: { reservedPicoUnits: "11", committedPicoUnits: "0" },
      },
    });
    expect(() =>
      ledger.reserve({
        authorizationId: "design-spec-native-authorization-001",
        executorClaimId: "design-spec-native-executor-claim-001",
        executionId: "design-spec-native-execution-usd-002",
        currency: "USD",
        nativePicoUnits: "1",
        wireCalls: 1,
      }),
    ).toThrow("frozen");
  });

  it("rejects cross-currency settlement, preserving the original reservation and freezing", () => {
    const directory = createLedgerDirectory();
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger-003",
      directory,
    });
    expect(ledger.claim(claimInput())).toBe(true);
    ledger.reserve({
      authorizationId: "design-spec-native-authorization-001",
      executorClaimId: "design-spec-native-executor-claim-001",
      executionId: "design-spec-native-execution-currency-001",
      currency: "CNY",
      nativePicoUnits: "10",
      wireCalls: 1,
    });

    expect(
      ledger.settle({
        authorizationId: "design-spec-native-authorization-001",
        executorClaimId: "design-spec-native-executor-claim-001",
        executionId: "design-spec-native-execution-currency-001",
        settlement: {
          state: "settled",
          executionId: "design-spec-native-execution-currency-001",
          currency: "USD",
          nativePicoUnits: "1",
          basis: "frozen_openox_native_pricing@2026-08-03",
        },
      }),
    ).toBe(false);
    expect(
      ledger.snapshot("design-spec-native-authorization-001"),
    ).toMatchObject({
      frozen: true,
      freezeReason: "settlement_currency_mismatch",
      totalsByCurrency: { CNY: { reservedPicoUnits: "10" } },
    });
  });

  it("freezes when a settlement does not use the authorization's frozen price basis", () => {
    const directory = createLedgerDirectory();
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger-009",
      directory,
    });
    expect(ledger.claim(claimInput())).toBe(true);
    expect(
      ledger.reserve({
        authorizationId: "design-spec-native-authorization-001",
        executorClaimId: "design-spec-native-executor-claim-001",
        executionId: "design-spec-native-execution-basis-001",
        currency: "CNY",
        nativePicoUnits: "10",
        wireCalls: 1,
      }),
    ).toBe(true);

    expect(
      ledger.settle({
        authorizationId: "design-spec-native-authorization-001",
        executorClaimId: "design-spec-native-executor-claim-001",
        executionId: "design-spec-native-execution-basis-001",
        settlement: {
          state: "settled",
          executionId: "design-spec-native-execution-basis-001",
          currency: "CNY",
          nativePicoUnits: "3",
          basis: "frozen_openox_native_pricing@2026-08-03T00:00:01.000Z",
        },
      }),
    ).toBe(false);
    expect(
      ledger.snapshot("design-spec-native-authorization-001"),
    ).toMatchObject({
      frozen: true,
      freezeReason: "settlement_basis_mismatch",
    });
  });

  it("does not reissue an authorization after a new ledger instance opens its durable directory", () => {
    const directory = createLedgerDirectory();
    const first = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger-004",
      directory,
    });
    expect(first.claim(claimInput())).toBe(true);
    const reopened = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger-004",
      directory,
    });
    expect(reopened.claim(claimInput())).toBe(false);
    expect(
      reopened.inspectAuthorization("design-spec-native-authorization-001"),
    ).toMatchObject({
      state: "non_resumable_after_restart",
      authorizationId: "design-spec-native-authorization-001",
      ledgerId: "design-spec-native-ledger-004",
      manualReconciliationRequired: true,
      claimFileSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("validates claim inputs before creating a durable claim file", () => {
    const directory = createLedgerDirectory();
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger-008",
      directory,
    });
    const authorizationId = "design-spec-native-authorization-008";

    expect(() =>
      ledger.claim({
        ...claimInput(authorizationId),
        maximumsByCurrency: { CNY: "01", USD: "200" },
      }),
    ).toThrow("canonical");
    expect(() =>
      lstatSync(claimFilePath(directory, authorizationId)),
    ).toThrow();
    expect(ledger.claim(claimInput(authorizationId))).toBe(true);
  });

  it("does not recreate a deleted ledger marker while verifying the directory", () => {
    const directory = createLedgerDirectory();
    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger-012",
      directory,
    });
    expect(ledger.claim(claimInput())).toBe(true);

    const markerPath = join(
      directory,
      ".site-builder-native-model-evaluation-ledger-id",
    );
    rmSync(markerPath);
    expect(() =>
      ledger.inspectAuthorization("design-spec-native-authorization-001"),
    ).toThrow();
    expect(() => lstatSync(markerPath)).toThrow();
  });

  it("requires a real owner-only directory and canonical native amounts", () => {
    const parent = createLedgerDirectory();
    const unsafeDirectory = join(parent, "unsafe");
    mkdirSync(unsafeDirectory, { mode: 0o755 });
    chmodSync(unsafeDirectory, 0o755);
    expect(() =>
      createNativeModelEvaluationAuthorizationLedger({
        ledgerId: "design-spec-native-ledger-005",
        directory: unsafeDirectory,
      }),
    ).toThrow("owner-only");

    const realDirectory = createLedgerDirectory();
    const symbolicDirectory = join(parent, "symbolic");
    symlinkSync(realDirectory, symbolicDirectory);
    expect(() =>
      createNativeModelEvaluationAuthorizationLedger({
        ledgerId: "design-spec-native-ledger-006",
        directory: symbolicDirectory,
      }),
    ).toThrow("real directory");

    const ledger = createNativeModelEvaluationAuthorizationLedger({
      ledgerId: "design-spec-native-ledger-007",
      directory: realDirectory,
    });
    expect(ledger.claim(claimInput())).toBe(true);
    expect(() =>
      ledger.reserve({
        authorizationId: "design-spec-native-authorization-001",
        executorClaimId: "design-spec-native-executor-claim-001",
        executionId: "design-spec-native-execution-invalid-001",
        currency: "CNY",
        nativePicoUnits: "01",
        wireCalls: 1,
      }),
    ).toThrow("canonical");

    const expectedDirectorySha256 = ledger.directorySha256;
    expect(() =>
      createNativeModelEvaluationAuthorizationLedger({
        ledgerId: "design-spec-native-ledger-010",
        directory: realDirectory,
        expectedDirectorySha256: "0".repeat(64),
      }),
    ).toThrow("directory digest");
    expect(
      createNativeModelEvaluationAuthorizationLedger({
        ledgerId: "design-spec-native-ledger-011",
        directory: realDirectory,
        expectedDirectorySha256,
      }).directorySha256,
    ).toBe(expectedDirectorySha256);
  });
});
