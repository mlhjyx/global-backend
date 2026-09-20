import { describe, expect, it, vi } from "vitest";
import { assertPlatformAuthorityReady } from "./platform-authority-readiness-gate";

describe("platform authority worker admission", () => {
  it("fails closed when an enabled purpose has no issuable authority", async () => {
    const query = vi.fn(async () => [
      { purpose: "platform.acquisition", state: "MISSING" },
      { purpose: "platform.intent_watch", state: "MISSING" },
      { purpose: "platform.sanctions", state: "MISSING" },
    ]);
    await expect(
      assertPlatformAuthorityReady(query),
    ).rejects.toThrow("PLATFORM_BUDGET_AUTHORITY_NOT_READY");
  });

  it("rejects fabricated purpose-only issuance rows without the four schedule identities", async () => {
    const query = vi.fn(async () => [
      { purpose: "platform.acquisition", state: "ISSUABLE" },
      { purpose: "platform.intent_watch", state: "ISSUABLE" },
      { purpose: "platform.sanctions", state: "ISSUABLE" },
    ]);
    await expect(
      assertPlatformAuthorityReady(query),
    ).rejects.toThrow("PLATFORM_BUDGET_AUTHORITY_NOT_READY");
  });
});
