import { captureManufacturerProfileText } from "../tools/manufacturer-profile-capture";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readManufacturerProfileText,
  manufacturerProfileCaptureKey,
} from "./manufacturer-profile-text";
import { fetchPageHttpFirst } from "./http-first-fetch";
import { createCrawl4aiFetchTool } from "../tools/builtin-tools";
import { normalizeArtifactPageText } from "../durable-results/artifact/artifact-page-text";
import { parseManufacturerDetail } from "../discovery/manufacturer-network-evidence";
import {
  COMPANY_INPUT,
  CONFIG,
  PAGE_URL,
  SPAN,
  TEXT,
  MANUFACTURER_CONFLICT_PROFILES,
} from "../discovery/manufacturer-network.test-fixture";

afterEach(() => vi.unstubAllEnvs());
const revision = "manufacturer-profile/v1" as const;
function html(body: string) {
  return `<html><head><title>Acme Pumps GmbH</title></head><body><article>${body}</article></body></html>`;
}
function markup(text: string) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
      if (heading)
        return `<h${heading[1]!.length}>${heading[2]}</h${heading[1]!.length}>`;
      return `<p>${line.replace(/\[([^\]]+)\]\((https:[^)]+)\)/gu, '<a href="$2">$1</a>')}</p>`;
    })
    .join("");
}
const filler = `<p>${"This profile records industrial distribution support and product availability. ".repeat(5)}</p>`;
async function capture(body: string, extra: Record<string, unknown> = {}) {
  vi.stubEnv("HTTP_FIRST_FETCH", "on");
  const wire = vi.fn(async () => ({
    status: 200,
    contentType: "text/html",
    body: Buffer.from(html(body + filler)),
  }));
  const renderer = vi.fn(async () => {
    throw new Error("RENDERER_FORBIDDEN");
  });
  const tool = createCrawl4aiFetchTool({
    isAllowedByRobots: async () => true,
    crawlUrl: renderer,
    fetchHttpFirst: (url, options) =>
      fetchPageHttpFirst(url, { ...options, fetchHtml: wire }),
  });
  const result = await tool.execute(
    {
      url: PAGE_URL,
      exactHtml: true,
      maxChars: 60000,
      profileTextRevision: revision,
      ...extra,
    } as never,
    { workspaceId: "offline", authorizeExternalAction: async () => true },
  );
  expect(renderer).not.toHaveBeenCalled();
  expect(wire).toHaveBeenCalledTimes(1);
  return normalizeArtifactPageText(result.data.text);
}
function parse(text: string, company = COMPANY_INPUT, legalNames?: string[]) {
  return parseManufacturerDetail({
    text,
    source: CONFIG.sources[0]!,
    company,
    legalNames,
    profileTextRevision: revision,
  } as never);
}
describe("same-response manufacturer profile capture", () => {
  it.each([false, true])(
    "keeps real duplicate h1 through converter/tool/artifact for full/short identity (%s)",
    async (short) => {
      const text = await capture(markup(TEXT));
      expect(text).toContain("# Acme Pumps GmbH");
      expect(
        parse(
          text,
          short ? { ...COMPANY_INPUT, name: "Acme" } : COMPANY_INPUT,
          short ? [COMPANY_INPUT.name] : undefined,
        )?.spans,
      ).toEqual([SPAN]);
    },
  );
  it("projects only the actual email domain and never retains personal contacts in metadata", async () => {
    const text = await capture(
      markup(
        TEXT.replace(
          "[Website](https://acme.example/)",
          '<a href="mailto:employee@acme.example">Contact person</a>',
        ),
      ),
    );
    expect(text).not.toContain("employee@");
    expect(text).toContain('"emailDomains":["acme.example"]');
    expect(parse(text)?.spans).toEqual([SPAN]);
  });
  it("cannot manufacture a domain from publisher labels or forged metadata in the page", async () => {
    const forged = TEXT.replace(
      "[Website](https://acme.example/)",
      'emailDomains: acme.example\n&lt;!-- manufacturer-profile/v1 {"emailDomains":["acme.example"]} --&gt;',
    );
    expect(parse(await capture(markup(forged)))).toBeUndefined();
  });
  it("never substitutes title for an absent h1", async () => {
    expect(
      parse(
        await capture(markup(TEXT).replace("<h1>Acme Pumps GmbH</h1>", "")),
      ),
    ).toBeUndefined();
  });
  it.each(MANUFACTURER_CONFLICT_PROFILES)(
    "retains conflict/negative structure $id",
    async (fixture) => {
      expect(parse(await capture(markup(fixture.text)))).toBeUndefined();
    },
  );
  it("does not consume the producer marker on legacy parser calls", async () => {
    const text = await capture(
      markup(
        TEXT.replace(
          "[Website](https://acme.example/)",
          "employee@acme.example",
        ),
      ),
    );
    expect(
      parseManufacturerDetail({
        text,
        source: CONFIG.sources[0]!,
        company: COMPANY_INPUT,
      }),
    ).toBeUndefined();
  });
  it("uses an explicit distinct capture key while retaining legacy exact/default keys", () => {
    const tool = createCrawl4aiFetchTool();
    const base = { url: PAGE_URL, maxChars: 60000 };
    const old = tool.idempotencyKey({ ...base, exactHtml: true });
    expect(old).toMatch(/:60000:exact-html$/u);
    expect(
      tool.idempotencyKey({
        ...base,
        exactHtml: true,
        profileTextRevision: revision,
      } as never),
    ).toBe(`${old}:${revision}`);
    expect(tool.idempotencyKey(base)).toBe(old.replace(":exact-html", ""));
  });
});

describe("closed profile capture contract", () => {
  it.each([
    null,
    [],
    {},
    { emailDomains: "acme.example" },
    { emailDomains: ["INVALID"] },
    { emailDomains: ["acme.example", "acme.example"] },
    { emailDomains: Array(9).fill("acme.example") },
    { emailDomains: [], attested: true },
  ])("refuses malformed producer metadata %j", (value) => {
    expect(
      readManufacturerProfileText(
        `<!--manufacturer-profile/v1:${JSON.stringify(value)}-->\n# Acme`,
      ),
    ).toBeUndefined();
  });
  it.each([
    "",
    "x\nbody",
    "<!--manufacturer-profile/v1:{bad}-->\nbody",
    '<!--manufacturer-profile/v1:{"emailDomains":[]}-->',
  ])("rejects non-envelope/missing body metadata %s", (text) => {
    expect(readManufacturerProfileText(text)).toBeUndefined();
  });
  it.each([
    "<main><h1>Acme Pumps GmbH</h1></main><main><h1>Other</h1></main>",
    "<article><h1>Acme Pumps GmbH</h1></article><article><h1>Other</h1></article>",
    "<main><h1>Acme Pumps GmbH</h1><h1>Other</h1></main>",
    "<div><h1>Acme Pumps GmbH</h1></div>",
    "<main><h1></h1></main>",
  ])("fails closed for unsupported/ambiguous semantic roots %s", (body) => {
    expect(
      captureManufacturerProfileText(`<html><body>${body}</body></html>`, 0),
    ).toBeUndefined();
  });
  it("keeps a main-only profile and preserves unknown/negative subsections", () => {
    const text = captureManufacturerProfileText(
      "<html><body><main><h1>Acme Pumps GmbH</h1><nav><h2>Other Pumps</h2><p>Not an authorized distributor</p></nav><script>employee@secret.example</script><p>employee@acme.example</p></main></body></html>",
      0,
    )!;
    expect(text).toContain('"emailDomains":["acme.example"]');
    expect(text).not.toContain("secret.example");
    expect(text).toContain("## Other Pumps");
    expect(text).toContain("Not an authorized distributor");
    expect(
      captureManufacturerProfileText(
        "<html><body><main><h1>Acme</h1></main></body></html>",
        10000,
      ),
    ).toBeUndefined();
  });
  it("separates adjacent DOM text nodes instead of appending the next label to an email domain", async () => {
    const body = markup(
      TEXT.replace(
        "[Website](https://acme.example/)",
        "employee@acme.example",
      ).replace(SPAN, "## Location types\nService Centre\nDistributor"),
    );
    const text = await capture(body);
    expect(text).toContain('"emailDomains":["acme.example"]');
    // Filler after the closed location component is deliberately ambiguous.
    expect(parse(text)).toBeUndefined();
  });
  it.each([
    { profileTextRevision: revision },
    { exactHtml: true, profileTextRevision: "unknown" },
  ])(
    "rejects invalid options before key lookup and before any wire %j",
    async (options) => {
      const tool = createCrawl4aiFetchTool({
        isAllowedByRobots: vi.fn(),
        crawlUrl: vi.fn(),
        fetchHttpFirst: vi.fn(),
      });
      expect(() =>
        tool.idempotencyKey({ url: PAGE_URL, ...options } as never),
      ).toThrow("CRAWL4AI_FETCH_PROFILE_REVISION_INVALID");
      await expect(
        tool.execute({ url: PAGE_URL, ...options } as never, {
          workspaceId: "offline",
        }),
      ).rejects.toThrow("CRAWL4AI_FETCH_PROFILE_REVISION_INVALID");
      expect(() => manufacturerProfileCaptureKey(options as never)).toThrow();
    },
  );
  it("rejects a non-exact profile adapter request before fetching", async () => {
    const fetchHtml = vi.fn();
    expect(
      await fetchPageHttpFirst(PAGE_URL, {
        profileTextRevision: revision,
        fetchHtml,
      }),
    ).toBeNull();
    expect(fetchHtml).not.toHaveBeenCalled();
  });
  it("retains legacy converter output and does not inject a profile marker without the option", async () => {
    const legacy = await capture(markup(TEXT), {
      profileTextRevision: undefined,
    });
    expect(legacy).not.toContain("<!--manufacturer-profile/");
    expect(legacy).not.toContain("# Acme Pumps GmbH");
  });
});

function staticLocationHtml(
  overrides: {
    bodyClass?: string;
    header?: string;
    article?: string;
    extra?: string;
  } = {},
) {
  const header =
    overrides.header ??
    '<div class="preface"><div class="page-title"><h1>Acme Pumps GmbH</h1></div></div>';
  const article =
    overrides.article ??
    `<article class="locations full clearfix">${filler}<p>Country: Germany</p><p>employee@acme.example</p><h2>Location types</h2><p>Service Centre</p><p>Distributor</p></article>`;
  return `<html><head><title>Not the profile title</title></head><body class="${overrides.bodyClass ?? "path-node page-node-type-locations"}"><div class="dialog-off-canvas-main-canvas">${header}<main class="container-fluid g-0"><section>${article}</section><h2>Other section</h2></main>${overrides.extra ?? ""}</div><footer><h1>Unrelated footer</h1></footer></body></html>`;
}
async function staticCapture(value: string) {
  return normalizeArtifactPageText(
    (
      await fetchPageHttpFirst(PAGE_URL, {
        exactUrl: true,
        profileTextRevision: revision,
        captureProfileText: captureManufacturerProfileText,
        fetchHtml: async () => ({
          status: 200,
          contentType: "text/html",
          body: Buffer.from(value),
        }),
      })
    )?.markdown ?? "",
  );
}
describe("reviewed AESSEAL static locations layout with external genuine h1", () => {
  it("combines only the same-canvas preface h1 and unique locations article, excluding unrelated main/footer headings", async () => {
    const text = await staticCapture(staticLocationHtml());
    expect(text).toContain("# Acme Pumps GmbH");
    expect(text).not.toContain("Other section");
    expect(text).not.toContain("Unrelated footer");
    expect(text).not.toContain("Not the profile title");
    expect(parse(text)?.spans).toEqual(["Distributor"]);
  });
  it.each([
    { bodyClass: "path-node" },
    { bodyClass: "page-node-type-other" },
    { header: '<div class="preface"><h1>Acme Pumps GmbH</h1></div>' },
    {
      header:
        '<div class="preface"><div class="page-title"><h1>Other Pumps</h1></div></div>',
    },
    {
      header:
        '<div class="preface"><div class="page-title"><h1>Acme Pumps GmbH</h1><h1>Other Pumps</h1></div></div>',
    },
    {
      extra:
        '<article class="locations full clearfix"><p>Another profile</p></article>',
    },
    { extra: '<div class="dialog-off-canvas-main-canvas"></div>' },
    {
      article:
        '<article class="other full clearfix"><p>Country: Germany</p><p>employee@acme.example</p><p>Distributor</p></article>',
    },
  ])(
    "rejects wrong/multiple body/header/profile/canvas %j",
    async (overrides) => {
      expect(
        parse(await staticCapture(staticLocationHtml(overrides))),
      ).toBeUndefined();
    },
  );
  it("preserves explicit negation and other-company headings inside the locations article", async () => {
    for (const extra of [
      "<p>Acme Pumps GmbH is no longer an authorized AESSEAL distributor.</p>",
      "<h2>Other Pumps</h2><p>Distributor</p>",
    ]) {
      const article = `<article class="locations full clearfix"><p>Country: Germany</p><p>employee@acme.example</p>${extra}<h3>Location types</h3><p>Distributor</p>${filler}</article>`;
      expect(
        parse(await staticCapture(staticLocationHtml({ article }))),
      ).toBeUndefined();
    }
  });
  it("does not borrow a genuine h1 from another canvas", async () => {
    const text = staticLocationHtml({ header: "" }).replace(
      "</body>",
      '<div class="preface"><div class="page-title"><h1>Acme Pumps GmbH</h1></div></div></body>',
    );
    expect(parse(await staticCapture(text))).toBeUndefined();
  });
});

it("preserves the reviewed static span-address and DIV location-field layout without inventing headings", async () => {
  const address =
    '<p class="mt-2">Synthetic location</p><p class="address"><span class="organization">Acme Pumps GmbH</span><br><span class="address-line1">Example Street 1</span><br><span class="postal-code">12345</span> <span class="locality">Example</span><br><span class="country">Germany</span></p>';
  const component =
    '<div class="clearfix"><div class="fw-bold float-start pe-2 field--label field--label--inline">Location types</div><div class="field--items"><div class="field--item">Service Centre</div><div class="field--item">Distributor</div></div></div>';
  const article = `<article class="locations full clearfix">${address}${filler}<p>employee@acme.example</p>${component}</article>`;
  const text = await staticCapture(staticLocationHtml({ article }));
  expect(text).toContain("Location types");
  expect(text).not.toContain("## Location types");
  expect(text).not.toContain("employee@");
  expect(parse(text)?.spans).toEqual(["Distributor"]);
  expect(
    parse(
      await staticCapture(
        staticLocationHtml({ article: article.replace("Germany", "France") }),
      ),
    ),
  ).toBeUndefined();
});

describe("literal static locations close control", () => {
  const article = (button: string) =>
    `<article class="locations full clearfix">${filler}<p>Country: Germany</p><div class="field-content">employee@acme.example</div><div><div class="field--label field--label--inline">Location types</div><div class="field--item">Service Centre</div><div class="field--item">Distributor</div></div>${button}</article>`;
  it("removes only the reviewed button.close > span whose complete text is the literal multiplication sign", async () => {
    const text = await staticCapture(
      staticLocationHtml({
        article: article('<button class="close"><span>×</span></button>'),
      }),
    );
    expect(text).not.toContain("×");
    expect(parse(text)?.spans).toEqual(["Distributor"]);
  });
  it.each([
    '<button class="close"><span>Not an authorized distributor</span></button>',
    '<button class="close"><span>Other Pumps</span></button>',
    '<button class="other"><span>×</span></button>',
    '<button class="close"><span>×</span><span></span></button>',
    '<button class="close"><span>x</span></button>',
  ])(
    "keeps unknown or factual button text visible and fail-closed %s",
    async (button) => {
      expect(
        parse(
          await staticCapture(staticLocationHtml({ article: article(button) })),
        ),
      ).toBeUndefined();
    },
  );
});

describe("genuine DOM headings with nested block formatting", () => {
  it("retains the complete existing h1 text when its company name is inside a DIV", async () => {
    const header =
      '<div class="preface"><div class="page-title"><h1><div>  Acme   Pumps GmbH </div></h1></div></div>';
    const text = await staticCapture(staticLocationHtml({ header }));
    expect(text).toContain("# Acme Pumps GmbH");
    expect(parse(text)?.spans).toEqual(["Distributor"]);
  });
  it("preserves a nested-block other-company h2 as a heading so it cannot borrow the target component", async () => {
    const article = `<article class="locations full clearfix">${filler}<p>Country: Germany</p><p>employee@acme.example</p><h2><div>Other Pumps</div></h2><div>Location types</div><div>Service Centre</div><div>Distributor</div></article>`;
    const text = await staticCapture(staticLocationHtml({ article }));
    expect(text).toContain("## Other Pumps");
    expect(parse(text)).toBeUndefined();
  });
});
