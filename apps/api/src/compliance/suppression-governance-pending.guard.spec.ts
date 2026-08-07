import { GUARDS_METADATA } from "@nestjs/common/constants";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { DiscoveryController } from "../discovery/discovery.controller";
import { SuppressionGovernancePendingGuard } from "./suppression-governance-pending.guard";

const GOVERNANCE_METHODS = [
  "addSuppression",
  "listSuppressions",
  "removeSuppression",
  "requestSuppressionRelease",
] as const;

describe("suppression governance pending-integration admission", () => {
  it("fails closed with a fixed 503 before any governance handler can run", () => {
    const guard = new SuppressionGovernancePendingGuard();

    let thrown: unknown;
    try {
      guard.canActivate();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(503);
    expect((thrown as HttpException).getResponse()).toEqual({
      error: {
        code: "SUPPRESSION_GOVERNANCE_AUTHZ_PENDING",
        message:
          "suppression governance is unavailable until server-side scope enforcement is integrated",
      },
    });
  });

  it.each(GOVERNANCE_METHODS)(
    "binds the fail-closed guard to the %s HTTP surface",
    (methodName) => {
      const method = DiscoveryController.prototype[methodName];
      const guards = Reflect.getMetadata(GUARDS_METADATA, method) as
        unknown[] | undefined;

      expect(guards).toContain(SuppressionGovernancePendingGuard);
    },
  );
});
