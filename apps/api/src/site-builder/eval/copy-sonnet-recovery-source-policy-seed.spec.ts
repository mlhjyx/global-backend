import { describe, expect, it, vi } from "vitest";

import {
  COPY_SONNET_RECOVERY_SOURCE_POLICY,
  ensureCopySonnetRecoverySourcePolicy,
  validateCopySonnetRecoverySourcePolicySeedRole,
} from "./copy-sonnet-recovery-source-policy-seed";

function currentRow(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    ...COPY_SONNET_RECOVERY_SOURCE_POLICY,
    createdAt: new Date("2026-08-10T00:00:00.000Z"),
    updatedAt: new Date("2026-08-10T00:00:00.000Z"),
    ...overrides,
  };
}

describe("Copy Sonnet recovery OpenOx source-policy seed", () => {
  it("defines the exact public-pricing-only policy", () => {
    expect(COPY_SONNET_RECOVERY_SOURCE_POLICY).toEqual({
      domain: "openox.tech",
      sourceType: "model_gateway_pricing",
      accessMode: "api",
      allowedPaths: ["/api/public/pricing-catalog"],
      disallowedPaths: null,
      robotsStatus: "UNREVIEWED",
      termsStatus: "UNREVIEWED",
      personalData: false,
      allowedPurpose: ["site_builder_copy_sonnet_recovery"],
      crawlDelayMs: 2_000,
      retentionDays: 1,
      reviewStatus: "APPROVED",
      owner: "site_builder",
      notes:
        "OpenOx public pricing catalog only; zero-model-call Copy Sonnet recovery preflight. Terms remain unreviewed; approval is limited to the authorized pricing read.",
    });
    expect(Object.isFrozen(COPY_SONNET_RECOVERY_SOURCE_POLICY)).toBe(true);
    expect(
      Object.isFrozen(COPY_SONNET_RECOVERY_SOURCE_POLICY.allowedPaths),
    ).toBe(true);
    expect(
      Object.isFrozen(COPY_SONNET_RECOVERY_SOURCE_POLICY.allowedPurpose),
    ).toBe(true);
  });

  it("creates the exact row without an update mutation", async () => {
    const upsert = vi.fn().mockResolvedValue(currentRow());

    await expect(
      ensureCopySonnetRecoverySourcePolicy({ sourcePolicy: { upsert } }),
    ).resolves.toEqual({ status: "CURRENT", domain: "openox.tech" });

    expect(upsert).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledWith({
      where: { domain: "openox.tech" },
      update: {},
      create: COPY_SONNET_RECOVERY_SOURCE_POLICY,
    });
  });

  it("is idempotent when the existing row is an exact match", async () => {
    const upsert = vi.fn().mockResolvedValue(currentRow());
    const db = { sourcePolicy: { upsert } };

    await ensureCopySonnetRecoverySourcePolicy(db);
    await ensureCopySonnetRecoverySourcePolicy(db);

    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["reviewStatus", "SUSPENDED"],
    ["allowedPurpose", ["site_builder_copy_sonnet_recovery", "discovery"]],
    ["allowedPaths", null],
    ["termsStatus", "REVIEWED_OK"],
    ["personalData", true],
  ])("rejects existing %s drift without overwriting it", async (field, value) => {
    const upsert = vi.fn().mockResolvedValue(currentRow({ [field]: value }));

    await expect(
      ensureCopySonnetRecoverySourcePolicy({ sourcePolicy: { upsert } }),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_SOURCE_POLICY_DRIFT");

    expect(upsert.mock.calls[0]?.[0]?.update).toEqual({});
  });

  it("requires SELECT and INSERT privileges before seeding", () => {
    expect(() =>
      validateCopySonnetRecoverySourcePolicySeedRole({
        currentUser: "global",
        canSelect: true,
        canInsert: true,
      }),
    ).not.toThrow();

    expect(() =>
      validateCopySonnetRecoverySourcePolicySeedRole({
        currentUser: "app_user",
        canSelect: true,
        canInsert: false,
      }),
    ).toThrow("COPY_SONNET_RECOVERY_SOURCE_POLICY_SEED_ROLE_INVALID");
  });
});
