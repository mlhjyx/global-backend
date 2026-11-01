import { beforeEach, describe, expect, it, vi } from "vitest";

import { requestPublicHttp, type PublicHttpResponse } from "../adapters/guarded-http";
import { isAllowedByRobots } from "../adapters/robots";
import { crawlHtml } from "../adapters/web-crawler";
import { queryAlgoliaExhibitors } from "../adapters/trade-fair-algolia";
import { registerBuiltinTools, socialFetchTool } from "./builtin-tools";
import {
  crawl4aiRenderTool,
  httpGetTool,
  mapYourShowFetchTool,
  registerSourceTools,
  sanctionsDownloadTool,
  tradeFairAlgoliaTool,
} from "./source-tools";
import { ToolRegistry } from "./tool-registry";
import type { ToolContext } from "./tool-contract";

vi.mock("../adapters/robots", () => ({ isAllowedByRobots: vi.fn(async () => true) }));
vi.mock("../adapters/web-crawler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/web-crawler")>()),
  crawlHtml: vi.fn(async () => ({ url: "https://company.example/", html: "<html></html>", headers: {} })),
}));
vi.mock("../adapters/trade-fair-algolia", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/trade-fair-algolia")>()),
  queryAlgoliaExhibitors: vi.fn(async () => []),
}));
vi.mock("../adapters/guarded-http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/guarded-http")>()),
  requestPublicHttp: vi.fn(),
}));

/**
 * D13: ToolBroker releases a failed reservation when a Tool that declares
 * `physicalWireObservation: "before_each_wire"` never asked for a wire. That
 * is only sound if every adapter the Tool calls receives exactly the Broker's
 * ctx.beforePhysicalWire; the adapters' own specs (guarded-http per hop,
 * web-crawler before fetch, external-wire-authorization per Algolia page)
 * prove they call it immediately before each wire.
 */
const DECLARED = [
  "crawl4ai.render",
  "http.get",
  "mapyourshow.fetch",
  "sanctions.download",
  "social.fetch",
  "tradefair.algolia",
];

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

describe("Tools that declare their physical wires to ToolBroker (D13)", () => {
  const beforePhysicalWire = vi.fn(async () => undefined);
  const context: ToolContext = { workspaceId: "workspace", purpose: "discovery", beforePhysicalWire };

  beforeEach(() => {
    vi.mocked(requestPublicHttp).mockReset();
    beforePhysicalWire.mockClear();
  });

  it("declares exactly the Tools whose every transport takes ctx.beforePhysicalWire", () => {
    const registry = registerSourceTools(registerBuiltinTools(new ToolRegistry()));
    const declared = registry
      .all()
      .filter((tool) => tool.physicalWireObservation === "before_each_wire")
      .map((tool) => tool.id)
      .sort();
    expect(declared).toEqual(DECLARED);
  });

  it("social.fetch hands the Broker's hook to its one guarded request", async () => {
    vi.mocked(requestPublicHttp).mockResolvedValueOnce(response({ body: Buffer.from("profile"), text: "profile" }));
    await socialFetchTool.execute({ url: "https://www.linkedin.com/in/max-mustermann" }, context);
    expect(requestPublicHttp).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestPublicHttp).mock.calls[0]![2]).toMatchObject({ beforePhysicalWire });
  });

  it("http.get hands the Broker's hook to its one guarded request (every hop calls it)", async () => {
    vi.mocked(requestPublicHttp).mockResolvedValueOnce(response({ body: Buffer.from("ok"), text: "ok" }));
    await httpGetTool.execute({ url: "https://company.example/sitemap.xml" }, context);
    expect(requestPublicHttp).toHaveBeenCalledTimes(1);
    expect(vi.mocked(requestPublicHttp).mock.calls[0]![2]).toMatchObject({ beforePhysicalWire });
  });

  it("crawl4ai.render hands it to both the robots fetch and the renderer dispatch", async () => {
    await crawl4aiRenderTool.execute({ url: "https://company.example/" }, context);
    expect(vi.mocked(isAllowedByRobots).mock.calls.at(-1)![1]).toMatchObject({ beforePhysicalWire });
    expect(vi.mocked(crawlHtml).mock.calls.at(-1)![3]).toBe(beforePhysicalWire);
  });

  it("tradefair.algolia hands it to the paged Algolia query", async () => {
    await tradeFairAlgoliaTool.execute(
      { cfg: { appId: "APP", apiKey: "public", indexName: "exhibitors", eventEditionId: "edition" } },
      context,
    );
    expect(vi.mocked(queryAlgoliaExhibitors).mock.calls.at(-1)![3]).toBe(beforePhysicalWire);
  });

  it("mapyourshow.fetch and sanctions.download hand it to their guarded request", async () => {
    vi.mocked(requestPublicHttp)
      .mockResolvedValueOnce(response({ body: Buffer.from('{"DATA":{"results":{"exhibitor":{"hit":[]}}}}') }))
      .mockResolvedValueOnce(
        response({ body: Buffer.from("<sdnList/>"), text: "<sdnList/>", headers: { "content-type": "application/xml" } }),
      );
    await mapYourShowFetchTool.execute({ host: "show.mapyourshow.com" }, context);
    await sanctionsDownloadTool.execute(
      { url: "https://sanctions.example/list.xml" },
      { ...context, purpose: "sanctions_screening" },
    );
    for (const call of vi.mocked(requestPublicHttp).mock.calls) {
      expect(call[2]).toMatchObject({ beforePhysicalWire });
    }
    expect(requestPublicHttp).toHaveBeenCalledTimes(2);
  });
});
