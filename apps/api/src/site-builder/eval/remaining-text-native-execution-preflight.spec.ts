import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertRemainingTextNativeDispatch,
  createRemainingTextNativeExecutionAttestation,
  isTrustedRemainingTextNativeExecutionAttestation,
  remainingTextNativePicoUnitsForUsage,
  remainingTextNativeSettlementRouteSnapshotSha256,
  type RemainingTextNativeExecutionPreflightInput,
} from "./remaining-text-native-execution-preflight";
import type { RemainingTextNativeFeeCardTaskId } from "./remaining-text-native-fee-card";

const cases = [
  ["site_builder.copy", "copy", 13, 26, "2177043000000", "584347680000"],
  [
    "site_builder.assemble",
    "assemble",
    48,
    96,
    "8346384000000",
    "9064923840000",
  ],
  [
    "site_builder.assembly_fix",
    "assembly-fix",
    48,
    96,
    "8374896000000",
    "9100848960000",
  ],
  [
    "site_builder.qa_summarize",
    "qa-summarize",
    12,
    24,
    "490362400000",
    "501207840000",
  ],
  [
    "site_builder.seo_review",
    "seo-review",
    12,
    24,
    "503069600000",
    "515763360000",
  ],
] as const;

interface TestFeeCardEvidence {
  card: {
    fixedSourceCommitSha: string;
    manifestSha256: string;
    cardSha256: string;
    suite: {
      suiteId: string;
      sourceBundleContractId: string;
      sourceBundleSha256: string;
    };
    entries: Array<Record<string, unknown>>;
  };
}

function evidence(slug: string): unknown {
  return JSON.parse(
    readFileSync(
      join(
        __dirname,
        `../../../../../docs/evidence/site-builder/m1-g-${slug}-native-fee-card-v3-2026-08-04.json`,
      ),
      "utf8",
    ),
  );
}

function input(
  taskId: RemainingTextNativeFeeCardTaskId,
  slug: string,
  executions: number,
  wires: number,
  cny: string,
  usd: string,
): RemainingTextNativeExecutionPreflightInput {
  const bearerToken = `limited-${taskId}-token`;
  const card = evidence(slug) as TestFeeCardEvidence;
  const routes = card.card.entries.map((entry: Record<string, unknown>) => ({
    alias: entry.alias as string,
    protocol: entry.protocol as "openai-responses" | "anthropic-messages",
    channelId: entry.alias === "claude-sonnet-5" ? 13 : 11,
  }));
  const purposeGroup = `remaining-text-eval:${taskId}` as const;
  const routeSnapshotSha256 = remainingTextNativeSettlementRouteSnapshotSha256({
    purposeGroup,
    tokenLogPath: "/api/log/token",
    routes,
  });
  return {
    taskId,
    authorization: {
      authorizationId: `${taskId.replaceAll("_", "-")}-authorization`,
      ledgerId: `${taskId.replaceAll("_", "-")}-ledger`,
      ledgerDirectorySha256: "a".repeat(64),
      approvedAt: "2026-08-04T00:00:00.000Z",
      approvedMaximumsByCurrency: { CNY: cny, USD: usd },
      approvedDispatchExecutions: executions,
      approvedWireCalls: wires,
      approvedSettlementRoutesSha256: routeSnapshotSha256,
      preparedExecutionCommitSha: "b".repeat(40),
      preparedFixedSourceCommitSha: card.card.fixedSourceCommitSha,
      preparedManifestSha256: card.card.manifestSha256,
      preparedFeeCardSha256: card.card.cardSha256,
      preparedSuiteId: card.card.suite.suiteId,
      preparedSourceBundleContractId: card.card.suite.sourceBundleContractId,
      preparedSourceBundleSha256: card.card.suite.sourceBundleSha256,
    },
    credential: {
      attestationId: `${taskId.replaceAll("_", "-")}-credential`,
      observedAt: "2026-08-04T00:00:00.000Z",
      snapshotSha256: "c".repeat(64),
      bearerTokenSha256: createHash("sha256").update(bearerToken).digest("hex"),
      gatewayOrigin: "http://127.0.0.1:3001",
      purpose: "site_builder_model_evaluation",
      purposeGroup,
      quotaMode: "limited",
      scopeExact: true,
      allowedDispatches: card.card.entries.map(
        (entry: Record<string, unknown>) => ({
          mode: "target" as const,
          alias: entry.alias as string,
          protocol: entry.protocol as "openai-responses" | "anthropic-messages",
          currency: entry.currency as "CNY" | "USD",
        }),
      ),
      gatewaySettlement: {
        purposeGroup,
        tokenLogPath: "/api/log/token",
        routeSnapshotSha256,
        routes,
      },
    },
    feeCardEvidence: card,
  };
}

describe("remaining text native execution preflight", () => {
  it.each(cases)(
    "brands the exact committed public-price evidence for %s",
    (taskId, slug, executions, wires, cny, usd) => {
      const attestation = createRemainingTextNativeExecutionAttestation(
        input(taskId, slug, executions, wires, cny, usd),
      );

      expect(
        isTrustedRemainingTextNativeExecutionAttestation(attestation),
      ).toBe(true);
      expect(attestation.taskId).toBe(taskId);
      expect(attestation.limits.maxDispatchExecutions).toBe(executions);
      expect(attestation.limits.maxWireCalls).toBe(wires);
      expect(attestation.limits.maximumsByCurrency).toEqual({
        CNY: cny,
        USD: usd,
      });
      expect(Object.isFrozen(attestation)).toBe(true);
    },
  );

  it("rejects modified evidence, cross-task evidence, and expanded credential scope", () => {
    const valid = input(...cases[0]);
    const modified = structuredClone(valid);
    const modifiedEvidence = modified.feeCardEvidence as {
      card: { entries: Array<{ executionCount: number }> };
    };
    modifiedEvidence.card.entries[0]!.executionCount += 1;
    expect(() =>
      createRemainingTextNativeExecutionAttestation(modified),
    ).toThrow("remaining text fee-card evidence is invalid");

    const crossTask = input(...cases[0]);
    crossTask.feeCardEvidence = evidence("assemble");
    expect(() =>
      createRemainingTextNativeExecutionAttestation(crossTask),
    ).toThrow("remaining text fee-card evidence is invalid");

    const expanded = input(...cases[0]);
    expanded.credential.allowedDispatches.push({
      mode: "target",
      alias: "gpt-5.4-mini",
      protocol: "openai-responses",
      currency: "CNY",
    });
    expect(() =>
      createRemainingTextNativeExecutionAttestation(expanded),
    ).toThrow("remaining text native execution preflight is invalid");
  });

  it("rejects any authorization amount or execution capacity above the committed card", () => {
    const amount = input(...cases[0]);
    amount.authorization.approvedMaximumsByCurrency.CNY = "2177043000001";
    expect(() => createRemainingTextNativeExecutionAttestation(amount)).toThrow(
      "remaining text native execution preflight is invalid",
    );

    const capacity = input(...cases[0]);
    capacity.authorization.approvedWireCalls = 27;
    expect(() =>
      createRemainingTextNativeExecutionAttestation(capacity),
    ).toThrow("remaining text native execution preflight is invalid");

    const source = input(...cases[0]);
    source.authorization.preparedManifestSha256 = "d".repeat(64);
    expect(() => createRemainingTextNativeExecutionAttestation(source)).toThrow(
      "remaining text native execution preflight is invalid",
    );

    const card = input(...cases[0]);
    card.authorization.preparedFeeCardSha256 = "e".repeat(64);
    expect(() => createRemainingTextNativeExecutionAttestation(card)).toThrow(
      "remaining text native execution preflight is invalid",
    );
  });

  it("rejects settlement-route drift and resists runtime intrinsic monkeypatches", () => {
    const route = input(...cases[0]);
    route.credential.gatewaySettlement.routes[0]!.channelId = 99;
    route.credential.gatewaySettlement.routeSnapshotSha256 =
      remainingTextNativeSettlementRouteSnapshotSha256(
        route.credential.gatewaySettlement,
      );
    expect(() => createRemainingTextNativeExecutionAttestation(route)).toThrow(
      "remaining text native execution preflight is invalid",
    );

    const attestation = createRemainingTextNativeExecutionAttestation(
      input(...cases[0]),
    );
    const forged = Object.freeze(structuredClone(attestation));
    const invalid = input(...cases[0]);
    invalid.authorization.approvedWireCalls = 999;
    const valid = input(...cases[0]);
    const originalHas = WeakSet.prototype.has;
    const originalIsFrozen = Object.isFrozen;
    const originalValues = Object.values;
    const originalKeys = Object.keys;
    const originalMap = Array.prototype.map;
    const originalSort = Array.prototype.sort;
    const originalEvery = Array.prototype.every;
    const originalSome = Array.prototype.some;
    const originalFind = Array.prototype.find;
    const originalRegExpTest = RegExp.prototype.test;
    const originalSafeInteger = Number.isSafeInteger;
    const originalDateParse = Date.parse;
    const originalStructuredClone = globalThis.structuredClone;
    let invalidRejected = false;
    let forgedTrusted: boolean;
    let existingTrusted: boolean;
    let validCreated: boolean;
    try {
      WeakSet.prototype.has = (() => true) as typeof WeakSet.prototype.has;
      Object.isFrozen = (() => true) as typeof Object.isFrozen;
      Object.values = (() => []) as typeof Object.values;
      Object.keys = (() => []) as typeof Object.keys;
      Array.prototype.map = (() => []) as typeof Array.prototype.map;
      Array.prototype.sort = (() => []) as typeof Array.prototype.sort;
      Array.prototype.every = (() => true) as typeof Array.prototype.every;
      Array.prototype.some = (() => true) as typeof Array.prototype.some;
      Array.prototype.find = (() => undefined) as typeof Array.prototype.find;
      RegExp.prototype.test = (() => true) as typeof RegExp.prototype.test;
      Number.isSafeInteger = (() => true) as typeof Number.isSafeInteger;
      Date.parse = (() => 0) as typeof Date.parse;
      globalThis.structuredClone = (() => forged) as typeof structuredClone;
      try {
        createRemainingTextNativeExecutionAttestation(invalid);
      } catch {
        invalidRejected = true;
      }
      forgedTrusted = isTrustedRemainingTextNativeExecutionAttestation(forged);
      existingTrusted =
        isTrustedRemainingTextNativeExecutionAttestation(attestation);
      validCreated = isTrustedRemainingTextNativeExecutionAttestation(
        createRemainingTextNativeExecutionAttestation(valid),
      );
    } finally {
      WeakSet.prototype.has = originalHas;
      Object.isFrozen = originalIsFrozen;
      Object.values = originalValues;
      Object.keys = originalKeys;
      Array.prototype.map = originalMap;
      Array.prototype.sort = originalSort;
      Array.prototype.every = originalEvery;
      Array.prototype.some = originalSome;
      Array.prototype.find = originalFind;
      RegExp.prototype.test = originalRegExpTest;
      Number.isSafeInteger = originalSafeInteger;
      Date.parse = originalDateParse;
      globalThis.structuredClone = originalStructuredClone;
    }
    expect(invalidRejected).toBe(true);
    expect(forgedTrusted).toBe(false);
    expect(existingTrusted).toBe(true);
    expect(validCreated).toBe(true);
  });

  it("admits and prices only the exact task-bound alias, protocol, and wire envelope", () => {
    const attestation = createRemainingTextNativeExecutionAttestation(
      input(...cases[0]),
    );
    expect(() =>
      assertRemainingTextNativeDispatch(attestation, {
        alias: "gpt-5.5",
        protocol: "openai-responses",
        wireAttempt: "initial",
        maxOutputTokens: 4000,
      }),
    ).not.toThrow();
    expect(
      remainingTextNativePicoUnitsForUsage(attestation, {
        executionId: "remaining-text-native-execution-0001",
        alias: "gpt-5.5",
        protocol: "openai-responses",
        wireAttempt: "initial",
        inputTokens: 100,
        outputTokens: 200,
      }),
    ).toEqual({
      state: "settled",
      executionId: "remaining-text-native-execution-0001",
      currency: "CNY",
      nativePicoUnits: "6500000000",
      basis: "frozen_openox_native_pricing@2026-08-03T23:33:42.483Z",
    });

    expect(() =>
      assertRemainingTextNativeDispatch(attestation, {
        alias: "gpt-5.4-mini",
        protocol: "openai-responses",
        wireAttempt: "initial",
        maxOutputTokens: 4000,
      }),
    ).toThrow("remaining text native dispatch is not authorized");
    expect(() =>
      assertRemainingTextNativeDispatch(attestation, {
        alias: "gpt-5.5",
        protocol: "openai-responses",
        wireAttempt: "initial",
        maxOutputTokens: 4001,
      }),
    ).toThrow("remaining text native dispatch exceeds the attested envelope");
  });
});
