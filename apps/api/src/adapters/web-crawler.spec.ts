import { afterEach, describe, expect, it, vi } from "vitest";
import {
  crawlHtml,
  crawlUrl,
  MAX_CRAWL4AI_RENDER_ARTIFACT_BYTES,
} from "./web-crawler";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Crawl4AI adapter 的 API 侧入口闸", () => {
  it.each([
    "http://127.0.0.1:3000/admin",
    "http://169.254.169.254/latest/meta-data/",
    "http://10.0.0.1/internal",
    "file:///etc/passwd",
  ])("crawlUrl 在请求本地 crawler 前拒绝 %s", async (url) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(crawlUrl(url)).rejects.toMatchObject({
      name: "EgressBlockedError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("crawlHtml 同样在本地 crawler 前拒绝 metadata", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      crawlHtml("http://169.254.169.254/latest/meta-data/"),
    ).rejects.toMatchObject({
      name: "EgressBlockedError",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["crawlUrl", crawlUrl],
    ["crawlHtml", crawlHtml],
  ] as const)(
    "%s 在公网目标解析后、Crawl4AI dispatch 前重新授权",
    async (_name, crawl) => {
      const fetchMock = vi.fn();
      const authorizeExternalAction = vi
        .fn<() => Promise<void>>()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error("suppression_action_gate"));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        crawl(
          "https://company.example/path",
          authorizeExternalAction,
          vi.fn(async (raw: string) => ({
            url: new URL(raw),
            ip: "203.0.113.10",
            family: 4 as const,
            addresses: [{ address: "203.0.113.10", family: 4 as const }],
          })),
        ),
      ).rejects.toThrow(/suppression_action_gate/);

      expect(authorizeExternalAction).toHaveBeenCalledTimes(2);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );
});

describe("Crawl4AI artifact-result boundaries", () => {
  it.each([crawlUrl, crawlHtml])('keeps authorization and resolution before around, and body completion inside around', async crawl => {
    const events: string[] = [];
    const response = new Response(JSON.stringify({ markdown: 'ok', results: [{ html: 'ok' }] }), { status: 200 });
    vi.stubGlobal('fetch', vi.fn(async () => { events.push('fetch'); return response; }));
    await crawl('https://company.example/', async () => { events.push('auth'); }, async raw => {
      events.push('dns'); return { url: new URL(raw), ip: '203.0.113.10', family: 4, addresses: [{ address: '203.0.113.10', family: 4 }] };
    }, async () => { events.push('counter'); }, async <T>(execute: () => Promise<T>): Promise<T> => {
      events.push('around'); const result = await execute(); expect(response.bodyUsed).toBe(true); events.push('complete'); return result;
    });
    expect(events).toEqual(['auth', 'dns', 'auth', 'counter', 'around', 'fetch', 'complete']);
  });
  it("bounds and fences a successful markdown response", async () => {
    const beforePhysicalWire = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({ markdown: "bounded markdown", success: true }),
        { status: 200 },
      )),
    );

    await expect(crawlUrl(
      "https://company.example/",
      undefined,
      vi.fn(async (raw: string) => ({
        url: new URL(raw),
        ip: "203.0.113.10",
        family: 4 as const,
        addresses: [{ address: "203.0.113.10", family: 4 as const }],
      })),
      beforePhysicalWire,
    )).resolves.toEqual({
      url: "https://company.example/",
      text: "bounded markdown",
    });
    expect(beforePhysicalWire).toHaveBeenCalledOnce();
  });

  it("rejects an oversized raw markdown response before JSON parsing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", {
        status: 200,
        headers: { "content-length": "5000001" },
      })),
    );

    await expect(crawlUrl(
      "https://company.example/",
      undefined,
      vi.fn(async (raw: string) => ({
        url: new URL(raw),
        ip: "203.0.113.10",
        family: 4 as const,
        addresses: [{ address: "203.0.113.10", family: 4 as const }],
      })),
    )).rejects.toThrow("CRAWL4AI_RESPONSE_TOO_LARGE");
  });

  it("fences the physical Crawl4AI request exactly once", async () => {
    const beforePhysicalWire = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({
        results: [{ html: "<main>ok</main>", response_headers: {} }],
      }), { status: 200 })),
    );

    await crawlHtml(
      "https://company.example/",
      undefined,
      vi.fn(async (raw: string) => ({
        url: new URL(raw),
        ip: "203.0.113.10",
        family: 4 as const,
        addresses: [{ address: "203.0.113.10", family: 4 as const }],
      })),
      beforePhysicalWire,
    );

    expect(beforePhysicalWire).toHaveBeenCalledOnce();
  });

  it("rejects an oversized raw Crawl4AI response before parsing JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(
        JSON.stringify({ results: [{ html: "ok" }] }),
        { status: 200, headers: { "content-length": "5000001" } },
      )),
    );

    await expect(crawlHtml(
      "https://company.example/",
      undefined,
      vi.fn(async (raw: string) => ({
        url: new URL(raw),
        ip: "203.0.113.10",
        family: 4 as const,
        addresses: [{ address: "203.0.113.10", family: 4 as const }],
      })),
    )).rejects.toThrow("CRAWL4AI_RESPONSE_TOO_LARGE");
  });

  it("rejects multiple Crawl4AI results instead of silently selecting one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({
        results: [{ html: "first" }, { html: "second" }],
      }), { status: 200 })),
    );

    await expect(crawlHtml(
      "https://company.example/",
      undefined,
      vi.fn(async (raw: string) => ({
        url: new URL(raw),
        ip: "203.0.113.10",
        family: 4 as const,
        addresses: [{ address: "203.0.113.10", family: 4 as const }],
      })),
    )).rejects.toThrow("CRAWL4AI_RESPONSE_ITEM_BOUND_EXCEEDED");
  });

  it("rejects rendered HTML over the approved artifact byte cap instead of truncating it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [
                { html: "x".repeat(MAX_CRAWL4AI_RENDER_ARTIFACT_BYTES + 1) },
              ],
            }),
            { status: 200 },
          ),
      ),
    );

    await expect(
      crawlHtml(
        "https://company.example/",
        undefined,
        vi.fn(async (raw: string) => ({
          url: new URL(raw),
          ip: "203.0.113.10",
          family: 4 as const,
          addresses: [{ address: "203.0.113.10", family: 4 as const }],
        })),
      ),
    ).rejects.toThrow("CRAWL4AI_RENDER_RESULT_TOO_LARGE");
  });
});
