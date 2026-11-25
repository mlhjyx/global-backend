import { describe, expect, it, vi } from "vitest";
import { InMemoryBudgetStoreAdapter } from "@global/test-support";
import { ToolBroker } from "../tools/tool-broker";
import { ToolRegistry } from "../tools/tool-registry";
import { RateLimiter } from "../tools/rate-limiter";
import { registerSearchProviderTools } from "../tools/search-provider-tools";
import {
  SearxngCooldownTracker,
  classifySearxngCooldownReason,
  executeWithSearxngFallback,
  invokeSearxngWithBrokerFallback,
  isSearxngFallbackEnabled,
} from "./searxng-fallback";

describe("searxng-fallback (opt-in 403/429 cooldown -> governed Serper/Exa)", () => {
  it("defaults SEARXNG_FALLBACK_ENABLED to OFF and only enables on explicit on/true/1", () => {
    expect(isSearxngFallbackEnabled({})).toBe(false);
    expect(isSearxngFallbackEnabled({ SEARXNG_FALLBACK_ENABLED: "" })).toBe(false);
    expect(isSearxngFallbackEnabled({ SEARXNG_FALLBACK_ENABLED: "off" })).toBe(false);
    expect(isSearxngFallbackEnabled({ SEARXNG_FALLBACK_ENABLED: "on" })).toBe(true);
    expect(isSearxngFallbackEnabled({ SEARXNG_FALLBACK_ENABLED: "true" })).toBe(true);
    expect(isSearxngFallbackEnabled({ SEARXNG_FALLBACK_ENABLED: "1" })).toBe(true);
  });

  it("classifies 403/429/5xx/suspended errors for cooldown", () => {
    expect(classifySearxngCooldownReason(new Error("searxng 403: Forbidden"))).toBe(
      "searxng_http_403",
    );
    expect(classifySearxngCooldownReason(new Error("searxng 429: Too Many Requests"))).toBe(
      "searxng_http_429",
    );
    expect(classifySearxngCooldownReason(new Error("searxng 503: Bad Gateway"))).toBe(
      "searxng_http_5xx",
    );
    expect(classifySearxngCooldownReason(new Error("engine suspended: unusual traffic"))).toBe(
      "searxng_upstream_blocked",
    );
    expect(classifySearxngCooldownReason(new Error("invalid json syntax"))).toBeNull();
  });

  it("never falls back to paid APIs by default or in platform scope, even when API keys exist", async () => {
    const serper = vi.fn();
    await expect(
      executeWithSearxngFallback(
        async () => {
          throw new Error("searxng 429: Too Many Requests");
        },
        { q: "solar" },
        {
          env: { SERPER_API_KEY: "test-serper" }, // SEARXNG_FALLBACK_ENABLED unset => OFF
          cooldownState: new SearxngCooldownTracker(),
          serper,
        },
      ),
    ).rejects.toThrow("searxng 429");
    expect(serper).not.toHaveBeenCalled();

    await expect(
      executeWithSearxngFallback(
        async () => {
          throw new Error("searxng 403: Forbidden");
        },
        { q: "solar" },
        {
          env: { SEARXNG_FALLBACK_ENABLED: "on", SERPER_API_KEY: "test-serper" },
          workspaceId: "platform",
          cooldownState: new SearxngCooldownTracker(),
          serper,
        },
      ),
    ).rejects.toThrow("searxng 403");
    expect(serper).not.toHaveBeenCalled();
  });

  it("trips cooldown on SearXNG 429 when explicitly enabled, reports truthful costCents=1, and bypasses SearXNG during cooldown", async () => {
    let clock = 1_000_000;
    const tracker = new SearxngCooldownTracker();
    const beforeRequest = vi.fn(async () => undefined);
    const primary = vi
      .fn()
      .mockRejectedValueOnce(new Error("searxng 429: Too Many Requests"))
      .mockResolvedValueOnce([{ url: "https://fresh.de/", title: "Fresh" }]);
    const serper = vi.fn(async () => ({
      hits: [{ url: "https://solar-wholesale.de/", title: "Solar Wholesale GmbH" }],
      billed: true,
    }));
    const env = {
      SEARXNG_FALLBACK_ENABLED: "on",
      SERPER_API_KEY: "test-serper",
      SEARXNG_COOLDOWN_MS: "60000",
    };

    const first = await executeWithSearxngFallback(
      primary,
      { q: "Photovoltaik Großhandel Deutschland", language: "de" },
      { env, now: () => clock, cooldownState: tracker, beforeRequest, serper },
    );

    expect(first).toEqual({
      results: [
        {
          url: "https://solar-wholesale.de/",
          title: "Solar Wholesale GmbH",
          engine: "serper_fallback",
        },
      ],
      provider: "serper",
      fallbackUsed: true,
      billed: true,
      costCents: 1,
      cooldownActive: true,
      reason: "searxng_http_429",
    });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(serper).toHaveBeenCalledTimes(1);

    clock += 10_000;
    const second = await executeWithSearxngFallback(
      primary,
      { q: "Wechselrichter Händler", language: "de" },
      { env, now: () => clock, cooldownState: tracker, beforeRequest, serper },
    );
    expect(second.provider).toBe("serper");
    expect(second.costCents).toBe(1);
    expect(primary).toHaveBeenCalledTimes(1);

    clock += 60_000;
    const third = await executeWithSearxngFallback(
      primary,
      { q: "PV Speicher", language: "de" },
      { env, now: () => clock, cooldownState: tracker, beforeRequest, serper },
    );
    expect(third.provider).toBe("searxng");
    expect(third.costCents).toBe(0);
    expect(primary).toHaveBeenCalledTimes(2);
  });

  it("respects data_provider DISABLED gate and falls through to Exa", async () => {
    const serper = vi.fn();
    const exa = vi.fn(async () => ({
      hits: [{ url: "https://pv-epc.it/", title: "PV EPC S.r.l." }],
      billed: true,
    }));

    const out = await executeWithSearxngFallback(
      async () => {
        throw new Error("searxng 403: Forbidden");
      },
      { q: "fotovoltaico EPC Italia", language: "it" },
      {
        env: {
          SEARXNG_FALLBACK_ENABLED: "on",
          SERPER_API_KEY: "test-serper",
          EXA_API_KEY: "test-exa",
        },
        isProviderEnabled: (key) => key !== "serper",
        cooldownState: new SearxngCooldownTracker(),
        serper,
        exa,
      },
    );

    expect(serper).not.toHaveBeenCalled();
    expect(out.provider).toBe("exa");
    expect(out.costCents).toBe(1);
    expect(out.results[0]).toEqual({
      url: "https://pv-epc.it/",
      title: "PV EPC S.r.l.",
      engine: "exa_fallback",
    });
  });

  it("routes cooldown fallback through real ToolBroker serper.search / exa.search with accurate budget settlement and platform isolation", async () => {
    vi.stubEnv("SEARXNG_FALLBACK_ENABLED", "on");
    vi.stubEnv("SERPER_API_KEY", "test-serper-key");
    vi.stubEnv("EXA_API_KEY", "test-exa-key");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          organic: [{ link: "https://solar-hub.de/", title: "Solar Hub GmbH" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const budgetStore = new InMemoryBudgetStoreAdapter();
    budgetStore.ledger.open("run-1", 100);
    budgetStore.ledger.open("run-platform", 100);
    const registry = new ToolRegistry();
    registry.register({
      id: "searxng.search",
      version: "1.0.0",
      category: "search",
      sourceClass: "public_intelligence",
      cost: { unit: "request", estimatedCents: 0, external: false },
      rateLimit: { rps: 10, concurrency: 5 },
      compliance: {
        sourcePolicy: "none",
        respectsRobots: false,
        personalData: false,
        allowedPurpose: ["discovery"],
        reversible: true,
        authRequired: false,
        risk: "low",
      },
      capabilities: { produces: ["domain"], accepts: ["keywords"] },
      idempotencyKey: (i: { q: string }) => `searxng.search:${i.q}`,
      durableResultStrategy: { kind: "typed_projection", schema: "searxng-search/v1" },
      healthCheck: async () => ({ healthy: true }),
      execute: async () => {
        throw new Error("searxng 429: Too Many Requests");
      },
    });
    registerSearchProviderTools(registry);

    const broker = new ToolBroker({
      registry,
      budgetStore: budgetStore as never,
      limiter: new RateLimiter(),
      traceRecorder: () => undefined,
      now: () => 1_000_000,
    });
    const tracker = new SearxngCooldownTracker();

    try {
      // Platform scope must NEVER invoke paid serper/exa even when SearXNG returns 429 or is already in cooldown.
      const platformBroker = {
        invoke: vi.fn(async (toolId: string) => {
          if (toolId === "searxng.search") {
            throw new Error("searxng 429: Too Many Requests");
          }
          throw new Error(`unexpected paid fallback tool: ${toolId}`);
        }),
      };
      await expect(
        invokeSearxngWithBrokerFallback(
          platformBroker as never,
          { q: "platform check" },
          { workspaceId: "platform", runId: "run-platform", purpose: "discovery" },
          { cooldownState: tracker },
        ),
      ).rejects.toThrow("searxng 429");
      expect(platformBroker.invoke).toHaveBeenCalledTimes(1);
      expect(platformBroker.invoke).toHaveBeenCalledWith(
        "searxng.search",
        expect.anything(),
        expect.anything(),
      );
      expect(fetchSpy).not.toHaveBeenCalled();

      // Workspace scope routes through real ToolBroker serper.search and settles 1c cleanly.
      const res = await invokeSearxngWithBrokerFallback(
        broker,
        { q: "Photovoltaik Großhandel", language: "de" },
        { workspaceId: "ws-1", runId: "run-1", purpose: "discovery" },
        { cooldownState: tracker },
      );
      expect(res.provider).toBe("serper");
      expect(res.fallbackUsed).toBe(true);
      expect(res.billed).toBe(true);
      expect(res.costCents).toBe(1);
      expect(res.results).toEqual([
        {
          url: "https://solar-hub.de/",
          title: "Solar Hub GmbH",
          engine: "serper_fallback",
        },
      ]);
      expect(budgetStore.ledger.remainingCents("run-1")).toBe(99);
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });
});
