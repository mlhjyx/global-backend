import { describe, expect, it } from "vitest";
import {
  OrganizationIdentityResolutionPlanError,
  planOrganizationIdentityResolution,
} from "./organization-identity-resolution-plan";

const RAW_RECORD_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const COMPANY_B = "33333333-3333-4333-8333-333333333333";
const COMPANY_ROOT = "44444444-4444-4444-8444-444444444444";

function identifier(
  overrides: Partial<Record<string, string>> = {},
): Record<string, string> {
  const value = overrides.normalizedValue ?? "DE1234";
  const scheme = overrides.scheme ?? "registry-id";
  const jurisdiction = overrides.jurisdiction ?? "DE";
  return {
    providerKey: "registry",
    scheme,
    jurisdiction,
    normalizedValue: value,
    validatorVersion: "registry-id-v1",
    normalizerVersion: "organization-identity-authority/v1",
    key: `${scheme}:${jurisdiction}:${value}`,
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    raw: {
      rawRecordId: RAW_RECORD_ID,
      providerKey: "registry",
      payloadHash: "a".repeat(64),
      ingestVersion: "raw-source/v1",
    },
    resolverVersion: "organization-identity-resolver/v1",
    blocker: {
      blockerKey: "d:acme.example",
      matchRule: "domain_exact",
      legacyCandidateCompanyId: null,
    },
    authorityIdentifiers: [identifier()],
    existingBindings: [],
    rootMappings: [],
    ...overrides,
  };
}

function plan(overrides: Record<string, unknown> = {}) {
  return planOrganizationIdentityResolution(input(overrides));
}

function resolutionError() {
  return expect.objectContaining({
    name: "OrganizationIdentityResolutionPlanError",
  }) as OrganizationIdentityResolutionPlanError;
}

describe("deterministic organization identity resolution plan", () => {
  it("creates an immutable identity_v2 plan when authority identifiers are unbound", () => {
    const result = plan();

    expect(result).toMatchObject({
      kind: "create_new",
      matchRule: "identity_v2",
      identifiers: [identifier()],
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.identifiers)).toBe(true);
    expect(Object.isFrozen(result.identifiers[0])).toBe(true);
    expect(() =>
      (result.identifiers as unknown as string[]).push("mutate"),
    ).toThrow();
  });

  it("retains the legacy domain rule when no authority identifier exists", () => {
    const result = plan({ authorityIdentifiers: [] });

    expect(result).toMatchObject({
      kind: "create_new",
      matchRule: "domain_exact",
      identifiers: [],
    });
    expect("derivedMatchRule" in result).toBe(false);
  });

  it("binds a single root and preserves the exact persisted match rule", () => {
    const result = plan({
      existingBindings: [
        { identifierKey: identifier().key, companyId: COMPANY_A },
      ],
      rootMappings: [
        { sourceCompanyId: COMPANY_A, rootCompanyId: COMPANY_ROOT },
      ],
    });

    expect(result).toMatchObject({
      kind: "bind_existing",
      companyId: COMPANY_ROOT,
      matchRule: "domain_exact",
    });
  });

  it("uses identity_v2 for a legacy candidate upgrade when authority identifiers exist", () => {
    const result = plan({
      blocker: {
        blockerKey: "n:acme:de",
        matchRule: "name_country",
        legacyCandidateCompanyId: COMPANY_A,
      },
    });

    expect(result).toMatchObject({
      kind: "lazy_upgrade",
      companyId: COMPANY_A,
      matchRule: "identity_v2",
    });
  });

  it("uses the legacy fallback rule for upgrade without authority identifiers", () => {
    const result = plan({
      authorityIdentifiers: [],
      blocker: {
        blockerKey: "d:acme.example",
        matchRule: "domain_exact",
        legacyCandidateCompanyId: COMPANY_A,
      },
    });

    expect(result).toMatchObject({
      kind: "lazy_upgrade",
      companyId: COMPANY_A,
      matchRule: "domain_exact",
    });
  });

  it("turns split identifier roots into a stable conflict", () => {
    const second = identifier({ normalizedValue: "DE9999" });
    const result = plan({
      authorityIdentifiers: [second, identifier()],
      existingBindings: [
        { identifierKey: second.key, companyId: COMPANY_B },
        { identifierKey: identifier().key, companyId: COMPANY_A },
      ],
    });

    expect(result).toMatchObject({
      kind: "conflict",
      matchRule: "identity_conflict",
      conflictType: "identifier_split",
      companyIds: [COMPANY_A, COMPANY_B],
      identifierKeys: [identifier().key, second.key],
    });
    expect(result.conflictFingerprint).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("does not silently merge a bound root with the legacy blocker candidate", () => {
    const result = plan({
      blocker: {
        blockerKey: "n:acme:de",
        matchRule: "name_country",
        legacyCandidateCompanyId: COMPANY_B,
      },
      existingBindings: [
        { identifierKey: identifier().key, companyId: COMPANY_A },
      ],
    });

    expect(result).toMatchObject({
      kind: "conflict",
      matchRule: "identity_conflict",
      conflictType: "blocking_key_disagreement",
      companyIds: [COMPANY_A, COMPANY_B],
    });
  });

  it("is order-independent, dedupes identical facts, and never mutates caller input", () => {
    const first = identifier();
    const second = identifier({ normalizedValue: "DE9999" });
    const facts = input({
      authorityIdentifiers: [second, first, { ...first }],
      existingBindings: [
        { identifierKey: second.key, companyId: COMPANY_B },
        { identifierKey: first.key, companyId: COMPANY_A },
        { identifierKey: first.key, companyId: COMPANY_A },
      ],
      rootMappings: [
        { sourceCompanyId: COMPANY_A, rootCompanyId: COMPANY_ROOT },
      ],
    });
    const before = JSON.stringify(facts);
    const reversed = input({
      authorityIdentifiers: [{ ...first }, second],
      existingBindings: [
        { identifierKey: first.key, companyId: COMPANY_A },
        { identifierKey: second.key, companyId: COMPANY_B },
      ],
      rootMappings: [
        { sourceCompanyId: COMPANY_A, rootCompanyId: COMPANY_ROOT },
      ],
    });

    expect(planOrganizationIdentityResolution(facts)).toEqual(
      planOrganizationIdentityResolution(reversed),
    );
    expect(JSON.stringify(facts)).toBe(before);
  });

  it("includes semantic input facts in inputHash but excludes reingest fields from conflictFingerprint", () => {
    const conflict = {
      existingBindings: [
        { identifierKey: identifier().key, companyId: COMPANY_A },
      ],
      blocker: {
        blockerKey: "n:acme:de",
        matchRule: "name_country",
        legacyCandidateCompanyId: COMPANY_B,
      },
    };
    const original = plan(conflict);
    const changedPayload = plan({
      ...conflict,
      raw: {
        rawRecordId: "55555555-5555-4555-8555-555555555555",
        providerKey: "registry",
        payloadHash: "b".repeat(64),
        ingestVersion: "raw-source/v2",
      },
    });
    const changedBlocker = plan({
      ...conflict,
      blocker: {
        blockerKey: "n:other:de",
        matchRule: "name_country",
        legacyCandidateCompanyId: COMPANY_B,
      },
    });

    expect(changedPayload.inputHash).not.toBe(original.inputHash);
    expect(changedPayload.conflictFingerprint).toBe(
      original.conflictFingerprint,
    );
    expect(changedBlocker.conflictFingerprint).not.toBe(
      original.conflictFingerprint,
    );
  });

  it("rejects contradictory facts, alias chains, malformed tokens, and unsafe containers without echoing them", () => {
    expect(() =>
      plan({
        existingBindings: [
          { identifierKey: identifier().key, companyId: COMPANY_A },
          { identifierKey: identifier().key, companyId: COMPANY_B },
        ],
      }),
    ).toThrow(resolutionError());
    expect(() =>
      plan({
        rootMappings: [
          { sourceCompanyId: COMPANY_A, rootCompanyId: COMPANY_B },
          { sourceCompanyId: COMPANY_B, rootCompanyId: COMPANY_ROOT },
        ],
      }),
    ).toThrow(resolutionError());
    expect(() => plan({ resolverVersion: "bad/value" })).toThrow(
      resolutionError(),
    );
    expect(() =>
      plan({ raw: { ...input().raw, payloadHash: "UPPERCASE" } }),
    ).toThrow(resolutionError());
  });

  it("rejects accessors and Proxy inputs without executing getters or traps", () => {
    let getterCalls = 0;
    const hostile = input();
    Object.defineProperty(hostile.raw, "payloadHash", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "a".repeat(64);
      },
    });
    const proxy = new Proxy(input(), {
      get() {
        throw new Error("trap must not run");
      },
    });

    expect(() => planOrganizationIdentityResolution(hostile)).toThrow(
      resolutionError(),
    );
    expect(getterCalls).toBe(0);
    expect(() => planOrganizationIdentityResolution(proxy)).toThrow(
      resolutionError(),
    );
  });
});
