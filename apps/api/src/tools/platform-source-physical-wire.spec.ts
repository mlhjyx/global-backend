import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  requestPublicHttp,
  type PublicHttpResponse,
} from "../adapters/guarded-http";
import {
  mapYourShowFetchTool,
  sanctionsDownloadTool,
  tradeFairAlgoliaTool,
  crawl4aiRenderTool,
} from "./source-tools";
import { isAllowedByRobots } from "../adapters/robots";
import { crawlHtml } from "../adapters/web-crawler";

vi.mock("../adapters/robots", () => ({ isAllowedByRobots: vi.fn(async () => true) }));
vi.mock("../adapters/web-crawler", () => ({ crawlHtml: vi.fn(async () => ({ url: 'https://company.example', html: 'ok', headers: {} })) }));

vi.mock("../adapters/guarded-http", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../adapters/guarded-http")>();
  return { ...actual, requestPublicHttp: vi.fn() };
});

const request = vi.mocked(requestPublicHttp);
const authorizeExternalAction = vi.fn(async () => true);
const beforePhysicalWire = vi.fn(async () => undefined);
const dispatchPhysicalWire = vi.fn(async <T>(_wireId: string, execute: () => Promise<T>): Promise<T> => execute());
const context = {
  workspaceId: "platform",
  purpose: "discovery",
  authorizeExternalAction,
  beforePhysicalWire,
  dispatchPhysicalWire,
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
  dispatchPhysicalWire.mockClear();
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("raw fetch bypassed the guarded physical-wire path");
  }));
});

afterEach(() => vi.unstubAllGlobals());

describe("Platform source physical-wire contracts", () => {
  it('keeps non-Platform source calls on their original transport when no wrapper is supplied', async () => {
    request.mockResolvedValueOnce(response({ body: Buffer.from('{"DATA":{"results":{"exhibitor":{"hit":[]}}}}') }));
    await expect(mapYourShowFetchTool.execute({ host: 'show.mapyourshow.com' }, { workspaceId: 'workspace', purpose: 'discovery' }))
      .resolves.toMatchObject({ data: { hits: [] }, costCents: 0 });
    expect(request.mock.calls[0][2]?.dispatchPhysicalWire).toBeUndefined();
    expect(dispatchPhysicalWire).not.toHaveBeenCalled();
  });
  it.each([
    [mapYourShowFetchTool, { host: 'show.mapyourshow.com' }],
    [sanctionsDownloadTool, { url: 'https://sanctions.example/list.xml' }],
    [tradeFairAlgoliaTool, { cfg: { appId: 'APP', apiKey: 'public', indexName: 'exhibitors', eventEditionId: 'edition' } }],
    [crawl4aiRenderTool, { url: 'https://company.example' }],
  ] as const)('fails closed without the new Platform transport wrapper %#', async (tool, input) => {
    await expect(tool.execute(input as never, { ...context, dispatchPhysicalWire: undefined }))
      .rejects.toThrow('PLATFORM_EGRESS_PHYSICAL_WIRE_UNAVAILABLE');
    expect(request).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('binds the actual MapYourShow and sanctions wrapper callbacks to the declared wire IDs', async () => {
    const wire = vi.fn(async () => response({ body: Buffer.from('{"DATA":{"results":{"exhibitor":{"hit":[]}}}}') }));
    request.mockImplementationOnce(async (_url, _options, dependencies) => {
      expect(dependencies?.dispatchPhysicalWire).toBeTypeOf('function');
      return dependencies!.dispatchPhysicalWire!(wire);
    });
    await mapYourShowFetchTool.execute({ host: 'show.mapyourshow.com' }, context);
    expect(dispatchPhysicalWire).toHaveBeenCalledWith('mapyourshow.fetch', wire);
    request.mockImplementationOnce(async (_url, _options, dependencies) => dependencies!.dispatchPhysicalWire!(async () => response({
      body: Buffer.from('<sdnList/>'), headers: { 'content-type': 'application/xml' },
    })));
    await sanctionsDownloadTool.execute({ url: 'https://sanctions.example/list.xml' }, context);
    expect(dispatchPhysicalWire.mock.calls.map(call => call[0])).toEqual(['mapyourshow.fetch', 'sanctions.public_http']);
  });
  it('binds distinct robots and render callbacks to the existing intent wire contracts', async () => {
    vi.mocked(isAllowedByRobots).mockImplementationOnce(async (_url, dependencies) => dependencies!.dispatchPhysicalWire!(async () => true));
    vi.mocked(crawlHtml).mockImplementationOnce(async (_url, _authorize, _resolve, _before, dispatch) => dispatch!(async () => ({ url: 'https://company.example', html: 'ok', headers: {} })));
    await crawl4aiRenderTool.execute({ url: 'https://company.example' }, context);
    expect(dispatchPhysicalWire.mock.calls.map(call => call[0])).toEqual(['robots.public_http', 'crawl4ai.render.dispatch']);
  });
  it('binds Algolia page wrappers to their declared wire rather than treating a before counter as completion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ hits: [], nbPages: 1 }), { status: 200 })));
    await tradeFairAlgoliaTool.execute({ cfg: { appId: 'APP', apiKey: 'public', indexName: 'exhibitors', eventEditionId: 'edition' } }, context);
    expect(dispatchPhysicalWire.mock.calls.map(call => call[0])).toEqual(['tradefair.algolia.page']);
    expect(fetch).toHaveBeenCalledOnce();
  });
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
      { authorizeExternalAction, beforePhysicalWire, dispatchPhysicalWire: expect.any(Function) },
    );
  });

  it("rejects a MapYourShow response exceeding the requested output item cap", async () => {
    const json = JSON.stringify({
      DATA: {
        results: {
          exhibitor: { hit: Array.from({ length: 10_001 }, () => ({})) },
        },
      },
    });
    request.mockResolvedValueOnce(response({
      body: Buffer.from(json),
      text: json,
    }));

    await expect(mapYourShowFetchTool.execute(
      { host: "show.mapyourshow.com", limit: 10_000 },
      context,
    )).rejects.toThrow("MAPYOURSHOW_RESPONSE_ITEM_BOUND_EXCEEDED");
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
      { authorizeExternalAction, beforePhysicalWire, dispatchPhysicalWire: expect.any(Function) },
    );
  });
});
