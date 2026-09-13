import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { request as httpRequest } from "node:http";
import { createSocket, type Socket as DgramSocket } from "node:dgram";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import * as ChromeLauncher from "chrome-launcher";
import * as Lighthouse from "lighthouse";
import * as RendererBuild from "../renderer-build";
import {
  collectBrowserQualityFacts,
  assertBrowserQualityCandidate,
  startLoopbackStaticServer,
  startLoopbackOnlyProxy,
} from "./browser-quality-runner";
import { releaseSpecDigest } from "../release-artifact";
import { buildM1ebGoldenFixtures } from "../design/m1eb-golden";
import { STATIC_DESIGN_CATALOG_V2 } from "../design/catalog";
import { loadQualifiedComponentTemplates } from "../assembly/qualified-component-templates";
import { deriveCopySlotDefinitions } from "../assembly/copy-slot-derivation";
import type { PublishableClaimSnapshot } from "../publishable-claim-snapshot";
import {
  buildSiteSpecWithTemporaryFile,
  writeRendererOutputManifest,
} from "../renderer-build";
import { materializeControlledAssetOverlay } from "../controlled-asset-materializer";

vi.mock("chrome-launcher", { spy: true });
vi.mock("lighthouse", { spy: true });

const repositoryRoot = path.resolve(
  new URL("../../../../../", import.meta.url).pathname,
);
const SITE_ORIGIN = "https://preview.example.test";

async function loadFixture() {
  const fixtures = await buildM1ebGoldenFixtures(repositoryRoot);
  const fixture = fixtures.find(({ id }) => id === "natural-origin-rich");
  if (!fixture) throw new Error("golden fixture missing");
  const claimSnapshot: PublishableClaimSnapshot = {
    schemaVersion: "site-builder-publishable-claim-snapshot/v1",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    siteId: "22222222-2222-4222-8222-222222222222",
    companyProfileId: "33333333-3333-4333-8333-333333333333",
    buildRunId: "44444444-4444-4444-8444-444444444444",
    capturedAt: "2026-07-24T00:00:00.000Z",
    digest:
      fixture.spec.copyBundleSet?.bundles.en?.claimSnapshot.digest ??
      "a".repeat(64),
    items: [],
  };
  return {
    ...fixture,
    validation: {
      designBrief: fixture.designBrief,
      catalog: STATIC_DESIGN_CATALOG_V2,
      claimSnapshot,
      copySlots: deriveCopySlotDefinitions({
        brief: fixture.designBrief,
        catalog: STATIC_DESIGN_CATALOG_V2,
        templates: loadQualifiedComponentTemplates(repositoryRoot),
      }),
    },
  };
}

async function loadSpecFromDisk() {
  return JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "apps/site-renderer/fixtures/m1-e-b-golden/natural-origin-rich-spec.json",
      ),
      "utf8",
    ),
  );
}

function html(canonicalPath: string, stunPort?: number): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <link rel="canonical" href="${SITE_ORIGIN}${canonicalPath}">
    <title>Quality fixture</title>
    <meta name="description" content="A deterministic quality fixture.">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","url":"${SITE_ORIGIN}${canonicalPath}","inLanguage":"en"}</script>
  </head>
  <body>
    <main><h1>Quality fixture</h1><p>Bounded local content.</p><a class="btn" href="/detail">Details</a></main>
    <img src="https://outside.invalid/blocked.png" alt="blocked egress probe">
    <img loading="lazy" src="/missing-lazy.png" alt="missing asset probe">
    <script>try { new WebSocket("ws://169.254.169.254/private"); } catch {}</script>
    ${
      stunPort
        ? `<script>
      try {
        const peer = new RTCPeerConnection({iceServers:[{urls:"stun:127.0.0.1:${stunPort}"}]});
        peer.createDataChannel("probe");
        peer.createOffer().then((offer) => peer.setLocalDescription(offer));
      } catch {}
    </script>`
        : ""
    }
  </body>
</html>`;
}

async function requestThroughProxy(
  proxyOrigin: string,
  target: string,
): Promise<number> {
  const proxy = new URL(proxyOrigin);
  return new Promise<number>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: proxy.hostname,
        port: Number(proxy.port),
        method: "GET",
        path: target,
        headers: { host: new URL(target).host },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

describe("bounded browser quality runner", () => {
  it("accepts the real approved Renderer output at the deterministic SEO seam", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "m1f-real-renderer-"));
    let cleanupAssets: (() => Promise<void>) | undefined;
    try {
      const { spec, designBrief, validation } = await loadFixture();
      const overlay = await materializeControlledAssetOverlay({
        workspaceId: validation.claimSnapshot.workspaceId,
        siteId: validation.claimSnapshot.siteId,
        spec,
        designBrief,
        catalog: validation.catalog,
        repositoryRoot,
        tenantReader: {
          readReadyVariant: async () => {
            throw new Error("golden fixture unexpectedly uses tenant assets");
          },
        },
      });
      cleanupAssets = overlay.cleanup;
      const outputManifest = await buildSiteSpecWithTemporaryFile(spec, {
        outDir: root,
        basePath: "/preview/quality/",
        siteOrigin: SITE_ORIGIN,
        publicAssetDir: overlay.publicDir,
      });
      const qualityInput = {
        spec,
        buildRoot: root,
        basePath: "/preview/quality/",
        siteOrigin: SITE_ORIGIN,
        rendererOutputDigest: outputManifest.treeDigest,
        candidateSpecDigest: releaseSpecDigest(spec),
        designBriefDigest: designBrief.digest,
        round: 0 as const,
        validation,
      };
      const facts = await collectBrowserQualityFacts(qualityInput);
      expect(facts.pages).toHaveLength(2);
      for (const page of facts.pages) {
        expect(page.h1Count).toBe(1);
        expect(page.canonical).not.toBeNull();
        expect(page.robots).toContain("noindex");
        expect(page.robotsTxtOk).toBe(true);
        expect(page.sitemapOk).toBe(true);
        expect(page.jsonLdValid).toBe(true);
        expect(page.jsonLdUnsupportedFacts).toBe(false);
        expect(page.externalRequests).toEqual([]);
        expect(page.brokenInternalLinks).toEqual([]);
        expect(page.missingStaticAssets).toEqual([]);
      }
      await writeFile(
        path.join(root, "index.html"),
        "<html><head></head><body>stale candidate</body></html>",
      );
      await expect(collectBrowserQualityFacts(qualityInput)).rejects.toThrow(
        "RENDERER_OUTPUT_TREE_MISMATCH",
      );
    } finally {
      await cleanupAssets?.();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("captures all breakpoints, runs axe and Lighthouse, and records blocked egress", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "m1f-quality-"));
    let udp: DgramSocket | null = createSocket("udp4");
    let stunPacketObserved = false;
    try {
      udp.on("message", () => {
        stunPacketObserved = true;
      });
      await new Promise<void>((resolve) =>
        udp!.bind(0, "127.0.0.1", () => resolve()),
      );
      const address = udp.address();
      if (typeof address === "string") throw new Error("UDP address invalid");
      await mkdir(path.join(root, "detail"), { recursive: true });
      await writeFile(path.join(root, "index.html"), html("/", address.port));
      await writeFile(
        path.join(root, "detail", "index.html"),
        html("/detail", address.port),
      );
      await writeFile(
        path.join(root, "robots.txt"),
        "User-agent: *\nDisallow: /\n",
      );
      await writeFile(
        path.join(root, "sitemap.xml"),
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE_ORIGIN}/</loc></url><url><loc>${SITE_ORIGIN}/detail</loc></url></urlset>`,
      );
      const { spec, designBrief, validation } = await loadFixture();
      const outputManifest = await writeRendererOutputManifest({
        root,
        candidateSpecDigest: releaseSpecDigest(spec),
        basePath: "/",
        siteOrigin: SITE_ORIGIN,
      });
      expect(spec).toEqual(await loadSpecFromDisk());
      const facts = await collectBrowserQualityFacts({
        spec,
        buildRoot: root,
        basePath: "/",
        siteOrigin: SITE_ORIGIN,
        rendererOutputDigest: outputManifest.treeDigest,
        candidateSpecDigest: releaseSpecDigest(spec),
        designBriefDigest: designBrief.digest,
        round: 0,
        validation,
      });
      expect(facts.pages).toHaveLength(2);
      for (const page of facts.pages) {
        expect(Object.keys(page.screenshots).sort()).toEqual([
          "1440",
          "375",
          "768",
        ]);
        expect(page.externalRequests).toContain("https://outside.invalid");
        expect(page.externalRequests).toContain("ws://169.254.169.254");
        expect(page.missingStaticAssets).toContain("/missing-lazy.png");
        expect(page.robotsTxtOk).toBe(true);
        expect(page.sitemapOk).toBe(true);
        expect(page.jsonLdUnsupportedFacts).toBe(false);
      }
      expect(facts.lighthouse).toHaveLength(2);
      expect(facts.lighthouse.map(({ breakpoint }) => breakpoint)).toEqual([
        375, 1440,
      ]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(stunPacketObserved).toBe(false);
    } finally {
      udp?.close();
      udp = null;
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("serves only files below the selected root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "m1f-static-"));
    try {
      await writeFile(
        path.join(root, "index.html"),
        "<html><head></head><body><h1>ok</h1></body></html>",
      );
      const server = await startLoopbackStaticServer(root);
      try {
        expect((await fetch(server.origin)).status).toBe(200);
        expect(
          (await fetch(`${server.origin}/..%2F..%2Fetc%2Fpasswd`)).status,
        ).toBe(404);
        await symlink("/etc/passwd", path.join(root, "escape.txt"));
        expect((await fetch(`${server.origin}/escape.txt`)).status).toBe(404);
      } finally {
        await server.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("denies proxy traffic to DNS names and literal IPs", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "m1f-proxy-"));
    try {
      await writeFile(
        path.join(root, "index.html"),
        "<html><head></head><body><h1>ok</h1></body></html>",
      );
      const staticServer = await startLoopbackStaticServer(root);
      const proxy = await startLoopbackOnlyProxy(staticServer.origin);
      try {
        expect(
          await requestThroughProxy(proxy.origin, `${staticServer.origin}/`),
        ).toBe(200);
        for (const target of [
          "http://example.com/",
          "http://169.254.169.254/latest/meta-data/",
          "http://127.0.0.1:1/private",
        ]) {
          expect(await requestThroughProxy(proxy.origin, target)).toBe(403);
        }
      } finally {
        await proxy.close();
        await staticServer.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

class SyntheticElement {
  innerText = "visible text";
  textContent: string | null = "visible text";
  scrollWidth = 100;
  clientWidth = 100;
  scrollHeight = 20;
  clientHeight = 20;
  href = "";
  hreflang = "en";
  content = "noindex";
  src = "";
  srcset = "";
  currentSrc = "";
  rel = "";
  style = {
    display: "block",
    visibility: "visible",
    opacity: "1",
    overflow: "visible",
    pointerEvents: "auto",
  };
  rect = { left: 0, right: 100, top: 0, bottom: 20, width: 100, height: 20 };
  getBoundingClientRect() {
    return this.rect;
  }
  contains(other: unknown) {
    return other === this;
  }
  getAttribute(name: string) {
    return name === "href" ? this.href : null;
  }
}
class SyntheticImage extends SyntheticElement {}
class SyntheticScript extends SyntheticElement {}
class SyntheticSource extends SyntheticElement {}
class SyntheticLink extends SyntheticElement {}
interface FakeBrowserMode {
  malformedDom?: boolean;
  invalidCanonical?: string;
  invalidHreflang?: string;
  invalidJsonLd?: string;
  violations?: boolean;
  navigationFailure?: boolean;
  closeFailure?: boolean;
  networkOverflow?: boolean;
  urlOverflow?: boolean;
  resourceOverflow?: boolean;
  resourceFacts?: boolean;
  lighthouse?: "empty" | "score";
  missingRobots?: boolean;
  invalidSitemap?: string;
}
let syntheticFixture: Awaited<ReturnType<typeof loadFixture>>;
beforeAll(async () => {
  syntheticFixture = await loadFixture();
});
const syntheticRoots = new Set<string>();
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const root of syntheticRoots)
    await rm(root, { recursive: true, force: true });
  syntheticRoots.clear();
});

async function fakeBrowserFixture(mode: FakeBrowserMode = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "browser-quality-fake-"));
  syntheticRoots.add(root);
  const spec = structuredClone(syntheticFixture.spec);
  const input = {
    ...syntheticFixture,
    spec,
    buildRoot: root,
    basePath: "/",
    siteOrigin: SITE_ORIGIN,
    rendererOutputDigest: "a".repeat(64),
    candidateSpecDigest: releaseSpecDigest(spec),
    designBriefDigest: syntheticFixture.designBrief.digest,
    round: 0 as const,
    chromeExecutablePath: "/proc/self/exe",
  };
  const expected = spec.site.locales.flatMap((locale) =>
    spec.pages.map(
      (page) =>
        `${locale === spec.site.defaultLocale ? "" : `/${locale}`}${page.path === "/" ? "/" : page.path}`,
    ),
  );
  if (!mode.missingRobots)
    await writeFile(
      path.join(root, "robots.txt"),
      "User-agent: *\nDisallow: /\n",
    );
  await writeFile(
    path.join(root, "sitemap.xml"),
    mode.invalidSitemap ??
      `<urlset>${expected.map((p) => `<url><loc>${SITE_ORIGIN}${p}</loc></url>`).join("")}</urlset>`,
  );
  await writeFile(path.join(root, "exists.css"), "body{}");
  const contexts: Array<{ close: ReturnType<typeof vi.fn> }> = [];
  const browser = {
    close: vi.fn().mockResolvedValue(undefined),
    newContext: vi.fn(),
  };
  const launch = vi
    .spyOn(chromium, "launch")
    .mockResolvedValue(browser as never);
  const kill = vi.fn().mockResolvedValue(undefined);
  const chromeLaunch = vi
    .spyOn(ChromeLauncher, "launch")
    .mockResolvedValue({ port: 12345, kill } as never);
  const lighthouse = vi
    .spyOn(Lighthouse, "default")
    .mockResolvedValue(
      mode.lighthouse === "empty"
        ? undefined
        : ({
            lhr: {
              categories: {
                performance: {
                  score: mode.lighthouse === "score" ? null : 0.9,
                },
                accessibility: { score: 1 },
                seo: { score: 0.95 },
              },
            },
          } as never),
    );
  vi.spyOn(RendererBuild, "assertRendererOutputMatches").mockResolvedValue({} as never);
  vi.stubGlobal("HTMLImageElement", SyntheticImage);
  vi.stubGlobal("HTMLScriptElement", SyntheticScript);
  vi.stubGlobal("HTMLSourceElement", SyntheticSource);
  vi.stubGlobal("HTMLLinkElement", SyntheticLink);
  vi.stubGlobal("getComputedStyle", (node: SyntheticElement) => node.style);
  browser.newContext.mockImplementation(async () => {
    let routeHandler: ((route: unknown) => Promise<void>) | undefined;
    let wsHandler: ((socket: unknown) => void) | undefined;
    let responseHandler: ((response: unknown) => void) | undefined;
    const context = {
      close: vi.fn().mockImplementation(async () => {
        if (mode.closeFailure) throw new Error("synthetic close failure");
      }),
      addInitScript: vi.fn().mockResolvedValue(undefined),
      route: vi.fn(async (_pattern, handler) => {
        routeHandler = handler;
      }),
      routeWebSocket: vi.fn(async (_pattern, handler) => {
        wsHandler = handler;
      }),
      newPage: vi.fn(),
    };
    const page = {
      setDefaultTimeout: vi.fn(),
      on: vi.fn((_event, handler) => {
        responseHandler = handler;
      }),
      addScriptTag: vi.fn().mockResolvedValue(undefined),
      screenshot: vi
        .fn()
        .mockResolvedValue(Buffer.from("synthetic screenshot")),
      evaluate: vi.fn(async (fn, args) => fn(args)),
      goto: vi.fn(async (rawUrl: string) => {
        if (mode.navigationFailure)
          throw new Error("synthetic navigation failure");
        const url = new URL(rawUrl);
        vi.stubGlobal("location", url);
        const canonical = new SyntheticLink();
        canonical.href = `${SITE_ORIGIN}${url.pathname}`;
        if (mode.invalidCanonical === "absent") canonical.href = "";
        if (mode.invalidCanonical === "origin")
          canonical.href = `https://other.example${url.pathname}`;
        if (mode.invalidCanonical === "search") canonical.href += "?x=1";
        if (mode.invalidCanonical === "hash") canonical.href += "#part";
        if (mode.invalidCanonical === "path")
          canonical.href = `${SITE_ORIGIN}/other`;
        const alternate = new SyntheticLink();
        alternate.href = `${SITE_ORIGIN}${url.pathname}`;
        alternate.hreflang = spec.site.defaultLocale;
        if (mode.invalidHreflang === "locale") alternate.hreflang = "wrong";
        if (mode.invalidHreflang === "origin")
          alternate.href = "https://other.example/";
        if (mode.invalidHreflang === "search") alternate.href += "?x=1";
        if (mode.invalidHreflang === "hash") alternate.href += "#part";
        if (mode.invalidHreflang === "path")
          alternate.href = `${SITE_ORIGIN}/other`;
        const script = new SyntheticScript();
        const jsonLd: Record<string, unknown> = {
          "@context": "https://schema.org",
          "@type": "WebPage",
          url: `${SITE_ORIGIN}${url.pathname}`,
          inLanguage: spec.site.defaultLocale,
        };
        if (mode.invalidJsonLd === "context") jsonLd["@context"] = "other";
        if (mode.invalidJsonLd === "type") jsonLd["@type"] = "Product";
        if (mode.invalidJsonLd === "url") jsonLd.url = "https://other.example/";
        if (mode.invalidJsonLd === "locale") jsonLd.inLanguage = "de";
        if (mode.invalidJsonLd === "claim") jsonLd.name = "unapproved claim";
        if (mode.invalidJsonLd === "number") jsonLd.number = 3;
        if (mode.invalidJsonLd === "id")
          jsonLd["@id"] = "https://other.example/#x";
        if (mode.invalidJsonLd === "valid-nested") {
          jsonLd.extra = [null, { "@id": SITE_ORIGIN }];
        }
        script.textContent =
          mode.invalidJsonLd === "parse"
            ? "{broken"
            : mode.invalidJsonLd === "null"
              ? "null"
              : mode.invalidJsonLd === "array"
                ? "[]"
                : JSON.stringify(jsonLd);
        const main = new SyntheticElement();
        const peer = new SyntheticElement();
        peer.rect = {
          left: 200,
          right: 300,
          top: 50,
          bottom: 70,
          width: 100,
          height: 20,
        };
        const hidden = new SyntheticElement();
        hidden.style.display = "none";
        if (mode.malformedDom) {
          main.style.overflow = "hidden";
          main.scrollWidth = 150;
          peer.rect = { ...main.rect };
          peer.style.pointerEvents = "none";
        }
        const image = new SyntheticImage();
        image.currentSrc = `${url.origin}/missing.png`;
        const source = new SyntheticSource();
        source.src = `${url.origin}/exists.css`;
        source.srcset = `${url.origin}/missing-2.png 1x, ${url.origin}/exists.css 2x`;
        const stylesheet = new SyntheticLink();
        stylesheet.rel = "stylesheet";
        stylesheet.href = `${url.origin}/exists.css`;
        const external = new SyntheticScript();
        external.src = "https://outside.invalid/a.js";
        const anchor = new SyntheticElement();
        anchor.href = `${url.origin}/missing-page`;
        const remoteAnchor = new SyntheticElement();
        remoteAnchor.href = "https://external.invalid/";
        const resources = mode.resourceOverflow
          ? Array.from({ length: 513 }, (_, i) => {
              const n = new SyntheticScript();
              n.src = `https://outside-${i}.invalid/a.js`;
              return n;
            })
          : mode.resourceFacts
            ? [image, source, stylesheet, external]
            : [];
        const anchors = mode.urlOverflow
          ? Array.from({ length: 513 }, (_, i) => ({
              ...anchor,
              href: `${url.origin}/page-${i}`,
            }))
          : mode.resourceFacts
            ? [anchor, remoteAnchor]
            : [];
        const doc = {
          documentElement: {
            textContent: mode.malformedDom ? "⟦unresolved⟧" : "Complete",
            scrollWidth: mode.malformedDom ? 2000 : 1440,
            clientWidth: 1440,
            scrollHeight: 2000,
          },
          querySelectorAll: (selector: string) => {
            if (selector === "h1") return [main];
            if (selector === "h1,h2,h3,h4,h5,h6,p,a,button,li,label,span")
              return [main, hidden];
            if (selector.startsWith("a[href],button"))
              return [main, peer, hidden];
            if (selector === ".btn,[data-cta=true]")
              return mode.malformedDom ? [peer, hidden] : [];
            if (selector === 'script[type="application/ld+json"]')
              return mode.invalidJsonLd === "missing" ? [] : [script];
            if (selector.startsWith("img[src]")) return resources;
            if (selector === "a[href]") return anchors;
            if (selector.startsWith('link[rel="alternate"]'))
              return mode.invalidHreflang === "missing" ? [] : [alternate];
            return [];
          },
          querySelector: (selector: string) =>
            selector === 'link[rel="canonical"]'
              ? canonical
              : selector === 'meta[name="robots"]'
                ? { content: "noindex, nofollow" }
                : null,
        };
        vi.stubGlobal("document", doc);
        vi.stubGlobal("window", {
          axe: {
            run: vi.fn().mockResolvedValue({
              violations: mode.violations
                ? [
                    { id: "contrast", impact: "minor", nodes: [1] },
                    { id: "contrast", impact: "serious", nodes: [2] },
                    { id: "other", impact: null, nodes: [] },
                  ]
                : [],
            }),
          },
        });
        if (routeHandler)
          for (const target of [
            "data:text/plain,x",
            "blob:http://localhost/id",
            rawUrl,
            "https://outside.invalid/x",
          ])
            await routeHandler({
              request: () => ({ url: () => target }),
              continue: vi.fn(),
              abort: vi.fn(),
            });
        if (wsHandler)
          wsHandler({
            url: () => "ws://outside.invalid/socket",
            close: vi.fn(),
          });
        if (mode.networkOverflow && routeHandler)
          for (let i = 0; i < 513; i++)
            await routeHandler({
              request: () => ({ url: () => `https://host-${i}.invalid/x` }),
              abort: vi.fn(),
            });
        if (responseHandler)
          for (const [status, type] of [
            [200, "image"],
            [404, "xhr"],
            [404, "image"],
          ] as const)
            responseHandler({
              status: () => status,
              request: () => ({ resourceType: () => type }),
              url: () => `${url.origin}/missing-response.png`,
            });
        return {};
      }),
    };
    context.newPage.mockResolvedValue(page);
    contexts.push(context);
    return context;
  });
  return {
    root,
    input,
    browser,
    launch,
    chromeLaunch,
    lighthouse,
    kill,
    contexts,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

describe("fake runtime quality collection", () => {
  it("collects immutable-target facts through synthetic browser and lighthouse implementations", async () => {
    const f = await fakeBrowserFixture({
      violations: true,
      resourceFacts: true,
      malformedDom: true,
    });
    try {
      const result = await collectBrowserQualityFacts(f.input);
      expect(result.pages.length).toBe(f.input.spec.pages.length);
      expect(result.pages[0]).toMatchObject({
        robotsTxtOk: true,
        sitemapOk: true,
        h1Count: 1,
        unresolvedPlaceholder: true,
      });
      expect(result.pages[0].missingStaticAssets).toContain("/missing.png");
      expect(
        result.pages[0].axeViolations.find((v) => v.id === "contrast"),
      ).toMatchObject({ impact: "serious", nodeCount: 6 });
      expect(result.lighthouse).toHaveLength(2);
      expect(f.kill).toHaveBeenCalledTimes(2);
      expect(f.browser.close).toHaveBeenCalledOnce();
      expect(f.contexts.every((c) => c.close.mock.calls.length === 1)).toBe(
        true,
      );
    } finally {
      await f.cleanup();
    }
  });
  it.each(["absent", "origin", "search", "hash", "path"])(
    "rejects canonical %s drift in the collected facts",
    async (invalidCanonical) => {
      const f = await fakeBrowserFixture({ invalidCanonical });
      try {
        expect(
          (await collectBrowserQualityFacts(f.input)).pages.every(
            (p) => p.canonical === null,
          ),
        ).toBe(true);
      } finally {
        await f.cleanup();
      }
    },
  );
  it.each(["missing", "locale", "origin", "search", "hash", "path"])(
    "rejects hreflang %s drift in the collected facts",
    async (invalidHreflang) => {
      const f = await fakeBrowserFixture({ invalidHreflang });
      try {
        expect(
          (await collectBrowserQualityFacts(f.input)).pages.every(
            (p) => p.hreflangs.length === 0,
          ),
        ).toBe(true);
      } finally {
        await f.cleanup();
      }
    },
  );
  it.each([
    "context",
    "type",
    "url",
    "locale",
    "claim",
    "number",
    "id",
    "null",
    "array",
  ])(
    "marks structured data %s as unsupported instead of trusting it",
    async (invalidJsonLd) => {
      const f = await fakeBrowserFixture({ invalidJsonLd });
      try {
        expect(
          (await collectBrowserQualityFacts(f.input)).pages.every(
            (p) => p.jsonLdUnsupportedFacts,
          ),
        ).toBe(true);
      } finally {
        await f.cleanup();
      }
    },
  );
  it.each(["missing", "parse"])(
    "reports invalid %s JSON-LD evidence",
    async (invalidJsonLd) => {
      const f = await fakeBrowserFixture({ invalidJsonLd });
      try {
        expect(
          (await collectBrowserQualityFacts(f.input)).pages.every(
            (p) => !p.jsonLdValid,
          ),
        ).toBe(true);
      } finally {
        await f.cleanup();
      }
    },
  );
  it("accepts bounded nested null and same-origin identity data", async () => {
    const f = await fakeBrowserFixture({
      invalidJsonLd: "valid-nested",
      closeFailure: true,
    });
    try {
      expect(
        (await collectBrowserQualityFacts(f.input)).pages.every(
          (p) => !p.jsonLdUnsupportedFacts,
        ),
      ).toBe(true);
    } finally {
      await f.cleanup();
    }
  });
  it.each(["networkOverflow", "urlOverflow", "resourceOverflow"] as const)(
    "fails closed when %s exceeds evidence ceilings",
    async (key) => {
      const f = await fakeBrowserFixture({ [key]: true });
      try {
        await expect(collectBrowserQualityFacts(f.input)).rejects.toThrow(
          "URL limit",
        );
        expect(f.browser.close).toHaveBeenCalledOnce();
      } finally {
        await f.cleanup();
      }
    },
  );
  it.each(["empty", "score"] as const)(
    "rejects %s Lighthouse evidence and kills the synthetic browser process",
    async (lighthouse) => {
      const f = await fakeBrowserFixture({ lighthouse });
      try {
        await expect(collectBrowserQualityFacts(f.input)).rejects.toThrow(
          "lighthouse",
        );
        expect(f.kill).toHaveBeenCalledOnce();
      } finally {
        await f.cleanup();
      }
    },
  );
  it("closes resources after navigation failure", async () => {
    const f = await fakeBrowserFixture({ navigationFailure: true });
    try {
      await expect(collectBrowserQualityFacts(f.input)).rejects.toThrow(
        "navigation failure",
      );
      expect(f.browser.close).toHaveBeenCalledOnce();
      expect(f.contexts[0].close).toHaveBeenCalledOnce();
    } finally {
      await f.cleanup();
    }
  });
  it.each([
    "<urlset/>",
    "<urlset><url>bad</url></urlset>",
    "<urlset><url><loc></loc></url></urlset>",
    "<urlset><url><loc>https://other.example/</loc></url></urlset>",
  ])("marks malformed or foreign sitemap invalid", async (invalidSitemap) => {
    const f = await fakeBrowserFixture({ invalidSitemap, missingRobots: true });
    try {
      const result = await collectBrowserQualityFacts(f.input);
      expect(result.pages.every((p) => !p.sitemapOk && !p.robotsTxtOk)).toBe(
        true,
      );
    } finally {
      await f.cleanup();
    }
  });
});

describe("fake runtime boundary validation and loopback serving", () => {
  it.each([
    "relative/",
    "/bad//path/",
    "/bad/../path/",
    "/bad/./path/",
    "/bad\\path/",
  ])("rejects invalid mounted base %s", async (basePath) => {
    const f = await fakeBrowserFixture();
    try {
      expect(() =>
        assertBrowserQualityCandidate({ ...f.input, basePath }),
      ).toThrow("basePath");
      expect(f.launch).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
  it.each(["renderer", "brief", "spec"] as const)(
    "rejects %s identity drift before launching",
    async (field) => {
      const f = await fakeBrowserFixture();
      try {
        const input = {
          ...f.input,
          ...(field === "renderer"
            ? { rendererOutputDigest: "invalid" }
            : field === "brief"
              ? { designBriefDigest: "b".repeat(64) }
              : { candidateSpecDigest: "b".repeat(64) }),
        };
        expect(() => assertBrowserQualityCandidate(input)).toThrow(
          "QUALITY_ARTIFACT_INVALID",
        );
        expect(f.launch).not.toHaveBeenCalled();
      } finally {
        await f.cleanup();
      }
    },
  );
  it("refuses an already-cancelled quality run before any launch", async () => {
    const f = await fakeBrowserFixture();
    const abort = new AbortController();
    abort.abort();
    try {
      await expect(
        collectBrowserQualityFacts({ ...f.input, signal: abort.signal }),
      ).rejects.toThrow("QUALITY_RUN_CANCELLED");
      expect(f.launch).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
  it("rejects an unavailable explicit executable without trying another binary", async () => {
    const f = await fakeBrowserFixture();
    try {
      await expect(
        collectBrowserQualityFacts({
          ...f.input,
          chromeExecutablePath: path.join(f.root, "absent-chrome"),
        }),
      ).rejects.toThrow("chrome unavailable");
      expect(f.launch).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
    }
  });
  it("serves only safe mounted methods and filenames with bounded HTML guarding", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "quality-local-serving-"));
    try {
      await writeFile(
        path.join(root, "index.html"),
        "<html><head></head><body>safe</body></html>",
      );
      await writeFile(
        path.join(root, "nohead.html"),
        "<body>cannot install network guard</body>",
      );
      await writeFile(path.join(root, "binary.bin"), "binary");
      await writeFile(
        path.join(root, "flat.html"),
        "<html><head></head></html>",
      );
      const server = await startLoopbackStaticServer(root, "/mount/");
      try {
        expect(
          (await fetch(`${server.origin}/mount/`, { method: "POST" })).status,
        ).toBe(405);
        const head = await fetch(`${server.origin}/mount/`, { method: "HEAD" });
        expect(head.status).toBe(200);
        expect(await head.text()).toBe("");
        expect((await fetch(`${server.origin}/outside`)).status).toBe(404);
        for (const suffix of ["%E0%A4%A", "%00", "%5Csecret"])
          expect((await fetch(`${server.origin}/mount/${suffix}`)).status).toBe(
            404,
          );
        expect((await fetch(`${server.origin}/mount/nohead.html`)).status).toBe(
          422,
        );
        expect((await fetch(`${server.origin}/mount/flat`)).status).toBe(200);
        expect(
          (await fetch(`${server.origin}/mount/binary.bin`)).headers.get(
            "content-type",
          ),
        ).toBe("application/octet-stream");
      } finally {
        await server.close();
      }
      await expect(
        startLoopbackStaticServer(path.join(root, "binary.bin")),
      ).rejects.toThrow("build root");
      const link = path.join(root, "root-link");
      await symlink(root, link);
      await expect(startLoopbackStaticServer(link)).rejects.toThrow(
        "build root",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it.each([
    "https://127.0.0.1:1234",
    "http://localhost:1234",
    "http://127.0.0.1",
  ])(
    "refuses unsafe proxy allowlist %s without opening a server",
    async (origin) => {
      await expect(startLoopbackOnlyProxy(origin)).rejects.toThrow(
        "proxy allowlist",
      );
    },
  );
});
