import { describe, expect, it, vi } from "vitest";

import {
  assertCopySonnetRecoverySourcePolicyDatabaseRole,
  runAfterCopySonnetRecoverySourcePolicyRoleCheck,
} from "./copy-sonnet-recovery-preflight-database-role";

describe("Copy Sonnet recovery source-policy database role", () => {
  it.each([
    [[], "missing role"],
    [
      [{ currentUser: "postgres", isSuper: false, bypassRls: false }],
      "wrong role",
    ],
    [
      [{ currentUser: "app_user", isSuper: true, bypassRls: false }],
      "superuser",
    ],
    [
      [{ currentUser: "app_user", isSuper: false, bypassRls: true }],
      "BYPASSRLS",
    ],
  ])("fails closed for %s before any downstream work", async (roles) => {
    const downstream = vi.fn();

    await expect(
      runAfterCopySonnetRecoverySourcePolicyRoleCheck(
        async () => roles,
        downstream,
      ),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_APP_DATABASE_ROLE_INVALID");
    expect(downstream).not.toHaveBeenCalled();
  });

  it("accepts only the non-superuser, non-BYPASSRLS app_user role", async () => {
    await expect(
      assertCopySonnetRecoverySourcePolicyDatabaseRole(async () => [
        { currentUser: "app_user", isSuper: false, bypassRls: false },
      ]),
    ).resolves.toBeUndefined();
  });

  it("runs downstream work only after the exact role check passes", async () => {
    const downstream = vi.fn(async () => "checked");

    await expect(
      runAfterCopySonnetRecoverySourcePolicyRoleCheck(
        async () => [
          { currentUser: "app_user", isSuper: false, bypassRls: false },
        ],
        downstream,
      ),
    ).resolves.toBe("checked");
    expect(downstream).toHaveBeenCalledOnce();
  });
});
