import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCrawl4aiFetchTool,
  MAX_CRAWL4AI_FETCH_ARTIFACT_BYTES,
} from "./builtin-tools";
import {
  MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES,
  sanctionsDownloadTool,
} from "./source-tools";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("artifact-producing Tool current-result boundaries", () => {
  it("keeps crawl4ai.fetch output within its approved UTF-8 artifact byte cap", async () => {
    const tool = createCrawl4aiFetchTool({
      isAllowedByRobots: async () => true,
      crawlUrl: async () => ({
        url: "https://acme.example/",
        text: "中".repeat(100_000),
      }),
    });

    const result = await tool.execute(
      { url: "https://acme.example/", maxChars: 100_000 },
      { workspaceId: "workspace" },
    );

    expect(Buffer.byteLength(result.data.text, "utf8")).toBe(
      MAX_CRAWL4AI_FETCH_ARTIFACT_BYTES,
    );
  });

  it("does not let a negative crawl4ai.fetch maxChars bypass the approved output cap", async () => {
    const tool = createCrawl4aiFetchTool({
      isAllowedByRobots: async () => true,
      crawlUrl: async () => ({
        url: "https://acme.example/",
        text: "x".repeat(MAX_CRAWL4AI_FETCH_ARTIFACT_BYTES + 1),
      }),
    });

    const result = await tool.execute(
      { url: "https://acme.example/", maxChars: -1 },
      { workspaceId: "workspace" },
    );

    expect(result.data.text).toHaveLength(40_000);
    expect(Buffer.byteLength(result.data.text, "utf8")).toBeLessThanOrEqual(
      MAX_CRAWL4AI_FETCH_ARTIFACT_BYTES,
    );
  });

  it("rejects a sanctions response whose canonical media type is not XML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"entities":[]}', {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    await expect(
      sanctionsDownloadTool.execute(
        { url: "https://sanctions.example/list" },
        { workspaceId: "workspace" },
      ),
    ).rejects.toThrow("SANCTIONS_DOWNLOAD_MEDIA_TYPE_INVALID");
  });

  it("rejects an over-cap sanctions response before reading its body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("body must not be consumed"));
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(body, {
            status: 200,
            headers: {
              "content-type": "application/xml; charset=utf-8",
              "content-length": String(
                MAX_SANCTIONS_DOWNLOAD_ARTIFACT_BYTES + 1,
              ),
            },
          }),
      ),
    );

    await expect(
      sanctionsDownloadTool.execute(
        { url: "https://sanctions.example/list" },
        { workspaceId: "workspace" },
      ),
    ).rejects.toThrow("SANCTIONS_DOWNLOAD_TOO_LARGE");
  });
});
