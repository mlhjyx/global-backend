import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { BudgetLedger } from "../../tools/budget";
import { RateLimiter } from "../../tools/rate-limiter";
import { ToolBroker, ToolPolicyDenied } from "../../tools/tool-broker";
import { ToolRegistry } from "../../tools/tool-registry";
import {
  COPY_SONNET_RECOVERY_OPENOX_PRICING_TOOL_ID,
  createCopySonnetRecoveryOpenOxPricingTool,
} from "./copy-sonnet-recovery-openox-pricing-tool";

const CATALOG = {
  success: true,
  data: {
    models: [
      {
        model_id: "claude-sonnet-5",
        product_line: "claude",
        input_rate: "2",
        output_rate: "10",
        cache_read_rate: "0.2",
        cache_write_rate: "2.5",
        status: "enabled",
        updated_at: "2026-08-10T05:30:00.000Z",
      },
    ],
    groups: [
      {
        name: "special",
        product_line: "claude",
        rate_multiplier: "1",
      },
    ],
  },
};

function broker(fetchImpl: typeof fetch, registered = true) {
  const registry = new ToolRegistry();
  registry.register(createCopySonnetRecoveryOpenOxPricingTool({ fetch: fetchImpl }));
  return new ToolBroker({
    registry,
    budget: new BudgetLedger(),
    limiter: new RateLimiter(),
    sourcePolicyReader: async (domain) =>
      registered && domain === "openox.tech"
        ? {
            suspended: false,
            allowedPurpose: ["site_builder_copy_sonnet_recovery"],
          }
        : null,
    traceRecorder: () => undefined,
  });
}

describe("Copy Sonnet recovery OpenOx pricing ToolBroker boundary", () => {
  it("reads the exact catalog with manual redirects and a bounded content digest", async () => {
    const bytes = JSON.stringify(CATALOG);
    const fetchMock = vi.fn(async () =>
      new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(bytes)),
        },
      }),
    );
    const result = await broker(fetchMock as typeof fetch).invoke(
      COPY_SONNET_RECOVERY_OPENOX_PRICING_TOOL_ID,
      {},
      {
        workspaceId: "site-builder-copy-sonnet-recovery-v16",
        purpose: "site_builder_copy_sonnet_recovery",
      },
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://openox.tech/api/public/pricing-catalog",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(result.data).toEqual({
      catalog: CATALOG,
      responseSha256: createHash("sha256").update(bytes).digest("hex"),
    });
  });

  it.each([
    [307, "https://attacker.example/collect"],
    [308, "https://openox.tech/redirected-catalog"],
  ])("rejects %i redirects without following or forwarding the request", async (status, location) => {
    const fetchMock = vi.fn(async () =>
      new Response(null, {
        status,
        headers: { location },
      }),
    );

    await expect(
      broker(fetchMock as typeof fetch).invoke(
        COPY_SONNET_RECOVERY_OPENOX_PRICING_TOOL_ID,
        {},
        {
          workspaceId: "site-builder-copy-sonnet-recovery-v16",
          purpose: "site_builder_copy_sonnet_recovery",
        },
      ),
    ).rejects.toThrow("COPY_SONNET_RECOVERY_OPENOX_RESPONSE_INVALID");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fails closed before egress when the required OpenOx source policy is unregistered", async () => {
    const fetchMock = vi.fn();
    await expect(
      broker(fetchMock as typeof fetch, false).invoke(
        COPY_SONNET_RECOVERY_OPENOX_PRICING_TOOL_ID,
        {},
        {
          workspaceId: "site-builder-copy-sonnet-recovery-v16",
          purpose: "site_builder_copy_sonnet_recovery",
        },
      ),
    ).rejects.toBeInstanceOf(ToolPolicyDenied);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
