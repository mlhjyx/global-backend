import { describe, expect, it, vi } from "vitest";
import {
  SearxngCooldownTracker,
  classifySearxngCooldownReason,
  executeWithSearxngFallback,
} from "./searxng-fallback";

describe("searxng-fallback (403/429 cooldown -> Serper/Exa)", () => {
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

  it("trips cooldown on SearXNG 429, serves via Serper, and bypasses SearXNG during cooldown", async () => {
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

    const first = await executeWithSearxngFallback(
      primary,
      { q: "Photovoltaik Großhandel Deutschland", language: "de" },
      {
        env: { SERPER_API_KEY: "test-serper", SEARXNG_COOLDOWN_MS: "60000" },
        now: () => clock,
        cooldownState: tracker,
        beforeRequest,
        serper,
      },
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
      cooldownActive: true,
      reason: "searxng_http_429",
    });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(serper).toHaveBeenCalledTimes(1);

    // Second call inside cooldown skips primary SearXNG entirely.
    clock += 10_000;
    const second = await executeWithSearxngFallback(
      primary,
      { q: "Wechselrichter Händler", language: "de" },
      {
        env: { SERPER_API_KEY: "test-serper", SEARXNG_COOLDOWN_MS: "60000" },
        now: () => clock,
        cooldownState: tracker,
        beforeRequest,
        serper,
      },
    );
    expect(second.provider).toBe("serper");
    expect(second.fallbackUsed).toBe(true);
    expect(primary).toHaveBeenCalledTimes(1);
    expect(serper).toHaveBeenCalledTimes(2);

    // After cooldown expires, primary SearXNG is tried again.
    clock += 60_000;
    const third = await executeWithSearxngFallback(
      primary,
      { q: "PV Speicher", language: "de" },
      {
        env: { SERPER_API_KEY: "test-serper", SEARXNG_COOLDOWN_MS: "60000" },
        now: () => clock,
        cooldownState: tracker,
        beforeRequest,
        serper,
      },
    );
    expect(third.provider).toBe("searxng");
    expect(third.fallbackUsed).toBe(false);
    expect(primary).toHaveBeenCalledTimes(2);
  });

  it("falls through from Serper failure to Exa on SearXNG 403", async () => {
    const tracker = new SearxngCooldownTracker();
    const serper = vi.fn().mockRejectedValue(new Error("SERPER_SEARCH_RATE_LIMITED"));
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
        env: { SERPER_API_KEY: "test-serper", EXA_API_KEY: "test-exa" },
        cooldownState: tracker,
        serper,
        exa,
      },
    );

    expect(out.provider).toBe("exa");
    expect(out.fallbackUsed).toBe(true);
    expect(out.results[0]).toEqual({
      url: "https://pv-epc.it/",
      title: "PV EPC S.r.l.",
      engine: "exa_fallback",
    });
  });

  it("rethrows the original SearXNG error when no fallback API keys exist or fallback is disabled", async () => {
    const tracker = new SearxngCooldownTracker();
    await expect(
      executeWithSearxngFallback(
        async () => {
          throw new Error("searxng 429: Too Many Requests");
        },
        { q: "solar" },
        { env: {}, cooldownState: tracker },
      ),
    ).rejects.toThrow("searxng 429");

    await expect(
      executeWithSearxngFallback(
        async () => {
          throw new Error("searxng 403: Forbidden");
        },
        { q: "solar" },
        {
          env: { SERPER_API_KEY: "key", SEARXNG_FALLBACK_ENABLED: "off" },
          cooldownState: new SearxngCooldownTracker(),
        },
      ),
    ).rejects.toThrow("searxng 403");
  });
});
