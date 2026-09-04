import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestPublicHttp,
  type PublicHttpResponse,
} from "../adapters/guarded-http";
import {
  mapYourShowFetchTool,
  sanctionsDownloadTool,
} from "./source-tools";

vi.mock("../adapters/guarded-http", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../adapters/guarded-http")>();
  return { ...actual, requestPublicHttp: vi.fn() };
});

const request = vi.mocked(requestPublicHttp);
const authorizeExternalAction = vi.fn(async () => true);
const beforePhysicalWire = vi.fn(async () => undefined);
const context = {
  workspaceId: "platform",
  purpose: "discovery",
  authorizeExternalAction,
  beforePhysicalWire,
};

function response(input: Partial<PublicHttpResponse>): PublicHttpResponse {
  return {
    status: 200,
    ok: true,
    headers: {},
    body: Buffer.alloc(0),
    text: "",
    finalUrl: "https://example.test/final",
    ...input,
  };
}

beforeEach(() => {
  request.mockReset();
  authorizeExternalAction.mockClear();
  beforePhysicalWire.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("raw fetch bypassed the guarded physical-wire path");
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("Platform source physical-wire contracts", () => {
  it("bounds MapYourShow before JSON parsing and forbids redirects", async () => {
    request.mockResolvedValueOnce(response({
      body: Buffer.from('{"DATA":{"results":{"exhibitor":{"hit":[]}}}}'),
      text: '{"DATA":{"results":{"exhibitor":{"hit":[]}}}}',
    }));

    await expect(mapYourShowFetchTool.execute(
      { host: "show.mapyourshow.com", limit: 10_000 },
      context,
    )).resolves.toMatchObject({ data: { hits: [] } });

    expect(request).toHaveBeenCalledWith(
      expect.stringContaining("perpage=10000"),
      expect.objectContaining({ maxBytes: 5_000_000, maxRedirects: 0 }),
      { authorizeExternalAction, beforePhysicalWire },
    );
  });

  it("bounds each sanctions redirect wire and preserves the 32 MiB artifact ceiling", async () => {
    const xml = "<sdnList></sdnList>";
    request.mockResolvedValueOnce(response({
      headers: { "content-type": "application/xml" },
      body: Buffer.from(xml),
      text: xml,
    }));

    await expect(sanctionsDownloadTool.execute(
      { url: "https://sanctions.example/list.xml" },
      { ...context, purpose: "sanctions_screening" },
    )).resolves.toMatchObject({ data: { body: xml } });

    expect(request).toHaveBeenCalledWith(
      "https://sanctions.example/list.xml",
      expect.objectContaining({
        maxBytes: 33_554_432,
        maxRedirects: 3,
      }),
      { authorizeExternalAction, beforePhysicalWire },
    );
  });
});
