import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { LEAD_QUALITY_LABEL_OPERATOR_AUTH_CONTRACT } from "./lead-quality-label.auth-contract";

describe("lead-quality-label operator authorization integration contract", () => {
  it("freezes exact least-privilege scope sets for all three network operations", () => {
    expect(LEAD_QUALITY_LABEL_OPERATOR_AUTH_CONTRACT).toEqual({
      runtimeBinding: "INTEGRATED_SCOPE_GUARD",
      operations: {
        pullLeadQualified: {
          method: "GET",
          path: "/api/v1/events",
          scopes: ["acquisition:read", "personal-data:read"],
        },
        appendLabel: {
          method: "POST",
          path: "/api/v1/lead-quality-labels",
          scopes: ["acquisition:label:write"],
        },
        acknowledgeEvent: {
          method: "POST",
          path: "/api/v1/events/ack",
          scopes: ["acquisition:event:ack"],
        },
      },
    });
    expect(Object.isFrozen(LEAD_QUALITY_LABEL_OPERATOR_AUTH_CONTRACT)).toBe(
      true,
    );
    for (const operation of Object.values(
      LEAD_QUALITY_LABEL_OPERATOR_AUTH_CONTRACT.operations,
    )) {
      expect(Object.isFrozen(operation)).toBe(true);
      expect(Object.isFrozen(operation.scopes)).toBe(true);
      expect(operation.scopes.length).toBeGreaterThan(0);
      expect(operation.scopes.every((scope) => !scope.includes("*"))).toBe(
        true,
      );
    }
  });

  it("records the completed runtime authorization binding", () => {
    expect(LEAD_QUALITY_LABEL_OPERATOR_AUTH_CONTRACT.runtimeBinding).toBe(
      "INTEGRATED_SCOPE_GUARD",
    );
  });

  it("binds all three operator endpoints to exact scope decorators", () => {
    const labelController = readFileSync(
      resolve(
        process.cwd(),
        "src/lead-quality-labels/lead-quality-label.controller.ts",
      ),
      "utf8",
    );
    const eventsController = readFileSync(
      resolve(process.cwd(), "src/events/events.controller.ts"),
      "utf8",
    );
    expect(labelController).toContain("@RequireScopes(...LABEL_SCOPES.create)");
    expect(eventsController).toContain("@RequireScopes(...EVENT_SCOPES.list)");
    expect(eventsController).toContain("@RequireScopes(...EVENT_SCOPES.ack)");
    expect(labelController).not.toContain(
      "AcquisitionAuthorizationIntegrationPendingGuard",
    );
    expect(eventsController).not.toContain(
      "AcquisitionAuthorizationIntegrationPendingGuard",
    );
  });
});
