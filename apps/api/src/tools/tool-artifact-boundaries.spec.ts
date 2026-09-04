import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EgressBlockedError,
  requestPublicHttp,
  type PublicHttpResponse,
} from "../adapters/guarded-http";
import {
  createCrawl4aiFetchTool,
  MAX_CRAWL4AI_FETCH_ARTIFACT_BYTES,
} from "./builtin-tools";
import {
  sanctionsDownloadTool,
} from "./source-tools";

vi.mock("../adapters/guarded-http", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../adapters/guarded-http")>();
  return { ...actual, requestPublicHttp: vi.fn() };
});

const mockedRequestPublicHttp = vi.mocked(requestPublicHttp);

function publicResponse(input: Partial<PublicHttpResponse>): PublicHttpResponse {
  return {
    status: 200,
    ok: true,
    headers: {},
    body: Buffer.alloc(0),
    text: "",
    finalUrl: "https://sanctions.example/list",
    ...input,
  };
}

afterEach(() => {
  mockedRequestPublicHttp.mockReset();
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
    mockedRequestPublicHttp.mockResolvedValueOnce(publicResponse({
      headers: { "content-type": "application/json" },
      body: Buffer.from('{"entities":[]}'),
    }));

    await expect(
      sanctionsDownloadTool.execute(
        { url: "https://sanctions.example/list" },
        { workspaceId: "workspace" },
      ),
    ).rejects.toThrow("SANCTIONS_DOWNLOAD_MEDIA_TYPE_INVALID");
  });

  it("rejects an over-cap sanctions response before reading its body", async () => {
    mockedRequestPublicHttp.mockRejectedValueOnce(
      new EgressBlockedError("response_too_large"),
    );

    await expect(
      sanctionsDownloadTool.execute(
        { url: "https://sanctions.example/list" },
        { workspaceId: "workspace" },
      ),
    ).rejects.toThrow("SANCTIONS_DOWNLOAD_TOO_LARGE");
  });
});
