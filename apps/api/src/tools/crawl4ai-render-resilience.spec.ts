import { beforeEach, describe, expect, it, vi } from "vitest";
import { EgressBlockedError } from "../adapters/guarded-http";
import {
  CRAWL4AI_RENDER_DEGRADED_EMPTY_HTML,
  crawlHtml,
  isCrawl4aiHtmlBody,
  isCrawl4aiRenderEmptyHtml,
} from "../adapters/web-crawler";
import { ExecutionControlError } from "../execution-budget/execution-control-error";
import { crawl4aiRenderTool } from "./source-tools";
import { ExternalToolActionDeniedError, type ToolContext } from "./tool-contract";

vi.mock("../adapters/robots", () => ({
  isAllowedByRobots: vi.fn(async () => true),
}));
vi.mock("../adapters/web-crawler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/web-crawler")>()),
  crawlHtml: vi.fn(),
}));

const workspaceCtx: ToolContext = {
  workspaceId: "5ff7ac7c-db3c-430e-b4e9-0581626e1b2b",
  purpose: "enrichment",
};

describe("crawl4ai.render timeout and non-HTML resilience (Batch 1.5-B)", () => {
  beforeEach(() => {
    vi.mocked(crawlHtml).mockReset();
  });

  it("settles cleanly at $0 with contract-valid empty HTML on workspace TimeoutError", async () => {
    vi.mocked(crawlHtml).mockRejectedValueOnce(
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    );

    const out = await crawl4aiRenderTool.execute(
      { url: "https://slow-solar.it/" },
      workspaceCtx,
    );

    expect(out).toEqual({
      data: {
        url: "https://slow-solar.it/",
        html: CRAWL4AI_RENDER_DEGRADED_EMPTY_HTML,
        headers: {},
      },
      costCents: 0,
      degraded: true,
    });
    expect(isCrawl4aiHtmlBody(out.data.html)).toBe(true);
    expect(isCrawl4aiRenderEmptyHtml(out.data.html)).toBe(true);
  });

  it("normalizes blank or non-HTML crawl responses to degraded empty HTML so artifact settlement succeeds", async () => {
    vi.mocked(crawlHtml).mockResolvedValueOnce({
      url: "https://blank-site.it/",
      html: "",
      headers: { server: "nginx" },
    });

    const out = await crawl4aiRenderTool.execute(
      { url: "https://blank-site.it/" },
      workspaceCtx,
    );

    expect(out).toEqual({
      data: {
        url: "https://blank-site.it/",
        html: CRAWL4AI_RENDER_DEGRADED_EMPTY_HTML,
        headers: { server: "nginx" },
      },
      costCents: 0,
      degraded: true,
    });
    expect(isCrawl4aiHtmlBody(out.data.html)).toBe(true);
  });

  it("charges 0 cents for workspace renders on self-hosted Crawl4AI while keeping platform scope at 1 cent", async () => {
    vi.mocked(crawlHtml)
      .mockResolvedValueOnce({
        url: "https://solar-italy.it/",
        html: "<!doctype html><html><body><h1>Solar Italy</h1></body></html>",
        headers: { "content-type": "text/html" },
      })
      .mockResolvedValueOnce({
        url: "https://solar-italy.it/",
        html: "<!doctype html><html><body><h1>Solar Italy</h1></body></html>",
        headers: { "content-type": "text/html" },
      });

    const workspaceOut = await crawl4aiRenderTool.execute(
      { url: "https://solar-italy.it/" },
      workspaceCtx,
    );
    expect(workspaceOut.costCents).toBe(0);
    expect(workspaceOut.degraded).toBeUndefined();

    const platformOut = await crawl4aiRenderTool.execute(
      { url: "https://solar-italy.it/" },
      {
        ...workspaceCtx,
        workspaceId: "platform",
        dispatchPhysicalWire: async (_wireId, execute) => execute(),
      },
    );
    expect(platformOut.costCents).toBe(1);
  });

  it("never swallows control, suppression, egress, platformEgress, or HTTP 500 errors", async () => {
    for (const err of [
      new ExecutionControlError("BUDGET_AUTHORITY_NOT_READY"),
      new ExternalToolActionDeniedError("suppression_action_gate"),
      new EgressBlockedError("private ip"),
      new Error("crawler 500"),
    ]) {
      vi.mocked(crawlHtml).mockRejectedValueOnce(err);
      await expect(
        crawl4aiRenderTool.execute({ url: "https://example.it/" }, workspaceCtx),
      ).rejects.toBe(err);
    }

    vi.mocked(crawlHtml).mockRejectedValueOnce(
      new DOMException("timed out", "TimeoutError"),
    );
    await expect(
      crawl4aiRenderTool.execute(
        { url: "https://platform.example/" },
        { ...workspaceCtx, platformEgress: {} as never },
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("never feeds .pdf URLs to crawlHtml and settles cleanly at $0 with degraded empty HTML", async () => {
    const out = await crawl4aiRenderTool.execute(
      { url: "https://solar-italy.it/wp-content/uploads/Brochure-2026.PDF?download=1#page=2" },
      workspaceCtx,
    );

    expect(crawlHtml).not.toHaveBeenCalled();
    expect(out).toEqual({
      data: {
        url: "https://solar-italy.it/wp-content/uploads/Brochure-2026.PDF?download=1#page=2",
        html: CRAWL4AI_RENDER_DEGRADED_EMPTY_HTML,
        headers: {},
      },
      costCents: 0,
      degraded: true,
    });
    expect(isCrawl4aiHtmlBody(out.data.html)).toBe(true);
    expect(isCrawl4aiRenderEmptyHtml(out.data.html)).toBe(true);
  });

  it("degrades application/pdf Content-Type responses cleanly at $0 even when wrapped in Chromium viewer HTML", async () => {
    vi.mocked(crawlHtml).mockResolvedValueOnce({
      url: "https://solar-italy.it/download?doc=42",
      html: '<html><body><embed type="application/pdf" src="about:blank"></body></html>',
      headers: { "Content-Type": "application/pdf; charset=binary" },
    });

    const out = await crawl4aiRenderTool.execute(
      { url: "https://solar-italy.it/download?doc=42" },
      workspaceCtx,
    );

    expect(out).toEqual({
      data: {
        url: "https://solar-italy.it/download?doc=42",
        html: CRAWL4AI_RENDER_DEGRADED_EMPTY_HTML,
        headers: { "Content-Type": "application/pdf; charset=binary" },
      },
      costCents: 0,
      degraded: true,
    });
  });
});
