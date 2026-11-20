import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureManufacturerProfileText } from "../tools/manufacturer-profile-capture";
import { fetchPageHttpFirst } from "./http-first-fetch";
import { createCrawl4aiFetchTool } from "../tools/builtin-tools";
import { normalizeArtifactPageText } from "../durable-results/artifact/artifact-page-text";
import { parseManufacturerDetail } from "../discovery/manufacturer-network-evidence";
import {
  COMPANY_INPUT,
  CONFIG,
  PAGE_URL,
  SPAN,
} from "../discovery/manufacturer-network.test-fixture";

const revision = "manufacturer-profile/v1" as const;
afterEach(() => vi.unstubAllEnvs());
function page(payload: string, tail = "", emailOnly = false) {
  const identity = emailOnly
    ? '<div class="field-content">employee@acme.example</div>'
    : '<a href="https://acme.example/">Website</a>';
  return `<html><head><title>Acme Pumps GmbH</title></head><body class="path-node page-node-type-locations"><div class="dialog-off-canvas-main-canvas"><div class="preface"><div class="page-title"><h1><div>Acme Pumps GmbH</div></h1></div></div><main class="container-fluid g-0"><article class="locations full clearfix"><p>Country: Germany</p>${identity}<p>${SPAN}</p><p>${payload}</p>${tail}</article></main></div></body></html>`;
}
async function throughTool(
  html: string,
  options: {
    maxChars?: number;
    profileTextRevision?: typeof revision;
    exactHtml?: true;
  } = { maxChars: 60000, profileTextRevision: revision, exactHtml: true },
) {
  vi.stubEnv("HTTP_FIRST_FETCH", "on");
  const fetchHtml = vi.fn(async () => ({
    status: 200,
    contentType: "text/html",
    body: Buffer.from(html),
  }));
  const renderer = vi.fn(async () => {
    throw new Error("RENDERER_FORBIDDEN");
  });
  const tool = createCrawl4aiFetchTool({
    isAllowedByRobots: async () => true,
    crawlUrl: renderer,
    fetchHttpFirst: (url, settings) =>
      fetchPageHttpFirst(url, { ...settings, fetchHtml }),
  });
  const result = await tool.execute(
    { url: PAGE_URL, ...options },
    { workspaceId: "offline" },
  );
  expect(fetchHtml).toHaveBeenCalledTimes(1);
  expect(renderer).not.toHaveBeenCalled();
  return result.data;
}
function parse(text: string) {
  return parseManufacturerDetail({
    text,
    source: CONFIG.sources[0]!,
    company: COMPANY_INPUT,
    profileTextRevision: revision,
  });
}
const cases = [
  {
    id: "tool-maxchars-expired",
    repeats: 1800,
    tail: "<p>Status: Expired</p>",
  },
  {
    id: "normalizer-codepoints-expired",
    repeats: 2200,
    tail: "<p>Status: Expired</p>",
  },
  {
    id: "tool-maxchars-foreign-heading",
    repeats: 1800,
    tail: "<h2><div>Other Pumps</div></h2>",
  },
];
describe("manufacturer profile completeness before either crop", () => {
  it.each(cases)(
    "never converts $id into a positive proof",
    async ({ repeats, tail }) => {
      const html = page(
        "Industrial distribution information. ".repeat(repeats),
        tail,
      );
      expect(html).toContain(tail);
      const data = await throughTool(html);
      expect(parse(data.text)).toBeUndefined();
      expect(data.text).toBe("");
    },
  );
  it("refuses a possibly capped normalizer result rather than returning its trusted prefix", () => {
    expect(
      captureManufacturerProfileText(
        page(
          "Industrial distribution information. ".repeat(2200),
          "<p>Status: Expired</p>",
        ),
        0,
      ),
    ).toBeUndefined();
  });
  it("catches NFC expansion that reaches the codepoint cap even with fewer original characters", async () => {
    const html = page("\u0344".repeat(40000), "<p>Status: Expired</p>");
    expect(Array.from(html).length).toBeLessThan(75000);
    expect((await throughTool(html)).text).toBe("");
  });
  it("counts codepoints instead of rejecting a complete astral profile solely for UTF16 length", async () => {
    const html = page("😀".repeat(40000), "<p>Status: Expired</p>");
    const capture = captureManufacturerProfileText(html, 0)!;
    expect(capture.length).toBeGreaterThan(75000);
    expect(Array.from(capture).length).toBeLessThan(75000);
    const data = await throughTool(html, {
      maxChars: 100000,
      profileTextRevision: revision,
      exactHtml: true,
    });
    expect(data.text).toBe(capture);
    expect(data.text).toContain("Status: Expired");
    expect(parse(data.text)).toBeUndefined();
  });
  function sized(units: number, character = "x", emailOnly = false) {
    const base = captureManufacturerProfileText(page("X", "", emailOnly), 0)!;
    const extra = units - base.length;
    const padding =
      character === "x"
        ? " x".repeat(Math.floor(extra / 2)) + "x".repeat(extra % 2)
        : character.repeat(Math.floor(extra / character.length)) +
          "x".repeat(extra % character.length);
    return page("X" + padding, "", emailOnly);
  }
  it.each([false, true])(
    "accepts the complete exact maxChars boundary including the producer header, email-only=%s",
    async (emailOnly) => {
      const html = sized(60000, "x", emailOnly);
      const captured = captureManufacturerProfileText(html, 0)!;
      expect(captured.length).toBe(60000);
      const data = await throughTool(html);
      expect(data.text).toBe(captured);
      expect(parse(data.text)?.spans).toEqual([SPAN]);
    },
  );
  it.each(["x", "😀"])(
    "refuses the next UTF16 unit beyond maxChars without a partial prefix (%s)",
    async (character) => {
      const html = sized(60001, character, true);
      expect(captureManufacturerProfileText(html, 0)!.length).toBe(60001);
      expect((await throughTool(html)).text).toBe("");
    },
  );
  it("includes metadata in the later artifact codepoint limit", async () => {
    const html = sized(75001, "x", true);
    expect(captureManufacturerProfileText(html, 0)).toBeUndefined();
    expect(
      (
        await throughTool(html, {
          maxChars: 100000,
          profileTextRevision: revision,
          exactHtml: true,
        })
      ).text,
    ).toBe("");
  });
  it("keeps a complete exact artifact-codepoint boundary with no tail dropped", async () => {
    const html = sized(75000);
    const capture = captureManufacturerProfileText(html, 0)!;
    expect(Array.from(capture).length).toBe(75000);
    const data = await throughTool(html, {
      maxChars: 100000,
      profileTextRevision: revision,
      exactHtml: true,
    });
    expect(data.text).toBe(capture);
    expect(normalizeArtifactPageText(data.text)).toBe(capture);
  });
  it("keeps a valid small profile positive", async () => {
    const text = (
      await throughTool(page("Industrial distribution information. ".repeat(8)))
    ).text;
    expect(parse(text)?.spans).toEqual([SPAN]);
    expect(createHash("sha256").update(text).digest("hex")).toBe(
      "c06e6c190fd2083052f3186fa87f28459fd29ab9417fbf101715b75cfff7be22",
    );
  });
  it.each([true, undefined] as const)(
    "preserves legacy/v1 crop, key and hash without the profile option (%s)",
    async (exactHtml) => {
      const html = page(
        "Industrial distribution information. ".repeat(2200),
        "<p>Status: Expired</p>",
      );
      const converted = await fetchPageHttpFirst(PAGE_URL, {
        exactUrl: exactHtml,
        fetchHtml: async () => ({
          status: 200,
          contentType: "text/html",
          body: Buffer.from(html),
        }),
      });
      const data = await throughTool(html, {
        maxChars: 60000,
        ...(exactHtml ? { exactHtml } : {}),
      });
      expect(data.text).toBe(converted!.markdown.slice(0, 60000));
      expect(data.text.length).toBe(60000);
      expect(data.contentHash).toBe(
        createHash("sha256").update(data.text).digest("hex").slice(0, 24),
      );
      const key = createCrawl4aiFetchTool().idempotencyKey({
        url: PAGE_URL,
        maxChars: 60000,
        ...(exactHtml ? { exactHtml } : {}),
      });
      expect(key).toBe(
        `crawl4ai.fetch:${createHash("sha256").update(PAGE_URL).digest("hex").slice(0, 24)}:60000${exactHtml ? ":exact-html" : ""}`,
      );
    },
  );
});

it("fails a v2 adapter request before the wire when its internal producer callback is absent", async () => {
  const fetchHtml = vi.fn();
  expect(
    await fetchPageHttpFirst(PAGE_URL, {
      exactUrl: true,
      profileTextRevision: revision,
      fetchHtml,
    }),
  ).toBeNull();
  expect(fetchHtml).not.toHaveBeenCalled();
});
it("cannot replace the fixed producer with a callback in tool input or context", async () => {
  vi.stubEnv("HTTP_FIRST_FETCH", "on");
  const forged = vi.fn(() => "a forged positive");
  const fetchHtml = vi.fn(async () => ({
    status: 200,
    contentType: "text/html",
    body: Buffer.from(
      page("x").replace("<h1><div>Acme Pumps GmbH</div></h1>", ""),
    ),
  }));
  const renderer = vi.fn();
  const tool = createCrawl4aiFetchTool({
    isAllowedByRobots: async () => true,
    crawlUrl: renderer,
    fetchHttpFirst: (url, options) =>
      fetchPageHttpFirst(url, { ...options, fetchHtml }),
  });
  const result = await tool.execute(
    {
      url: PAGE_URL,
      exactHtml: true,
      profileTextRevision: revision,
      captureProfileText: forged,
    } as never,
    { workspaceId: "offline", captureProfileText: forged } as never,
  );
  expect(result.data.text).toBe("");
  expect(forged).not.toHaveBeenCalled();
  expect(fetchHtml).toHaveBeenCalledOnce();
  expect(renderer).not.toHaveBeenCalled();
});
