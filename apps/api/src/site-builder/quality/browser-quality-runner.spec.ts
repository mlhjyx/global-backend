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
import { describe, expect, it } from "vitest";
import {
  collectBrowserQualityFacts,
  startLoopbackStaticServer,
  startLoopbackOnlyProxy,
} from "./browser-quality-runner";
import { releaseSpecDigest } from "../release-artifact";
import { buildM1ebGoldenFixtures } from "../design/m1eb-golden";
import { STATIC_DESIGN_CATALOG_V2 } from "../design/catalog";
import { loadQualifiedComponentTemplates } from "../assembly/qualified-component-templates";
import { deriveCopySlotDefinitions } from "../assembly/copy-slot-derivation";
import type { PublishableClaimSnapshot } from "../publishable-claim-snapshot";
import { buildSiteSpecWithTemporaryFile } from "../renderer-build";
import { materializeControlledAssetOverlay } from "../controlled-asset-materializer";

const repositoryRoot = path.resolve(
  new URL("../../../../../", import.meta.url).pathname,
);

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

function html(canonicalPath: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="robots" content="noindex, nofollow">
    <link rel="canonical" href="${canonicalPath}">
    <title>Quality fixture</title>
    <meta name="description" content="A deterministic quality fixture.">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","url":"${canonicalPath}","inLanguage":"en"}</script>
  </head>
  <body>
    <main><h1>Quality fixture</h1><p>Bounded local content.</p><a class="btn" href="/detail">Details</a></main>
    <img src="https://outside.invalid/blocked.png" alt="blocked egress probe">
    <img loading="lazy" src="/missing-lazy.png" alt="missing asset probe">
    <script>try { new WebSocket("ws://169.254.169.254/private"); } catch {}</script>
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
      await buildSiteSpecWithTemporaryFile(spec, {
        outDir: root,
        basePath: "/",
        publicAssetDir: overlay.publicDir,
      });
      const facts = await collectBrowserQualityFacts({
        spec,
        buildRoot: root,
        candidateSpecDigest: releaseSpecDigest(spec),
        designBriefDigest: designBrief.digest,
        round: 0,
        validation,
      });
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
    } finally {
      await cleanupAssets?.();
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("captures all breakpoints, runs axe and Lighthouse, and records blocked egress", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "m1f-quality-"));
    try {
      await mkdir(path.join(root, "detail"), { recursive: true });
      await writeFile(path.join(root, "index.html"), html("/"));
      await writeFile(path.join(root, "detail", "index.html"), html("/detail"));
      await writeFile(
        path.join(root, "robots.txt"),
        "User-agent: *\nDisallow: /\n",
      );
      await writeFile(
        path.join(root, "sitemap.xml"),
        '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>/</loc></url><url><loc>/detail</loc></url></urlset>',
      );
      const { spec, designBrief, validation } = await loadFixture();
      expect(spec).toEqual(await loadSpecFromDisk());
      const facts = await collectBrowserQualityFacts({
        spec,
        buildRoot: root,
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
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("serves only files below the selected root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "m1f-static-"));
    try {
      await writeFile(path.join(root, "index.html"), "<h1>ok</h1>");
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
      await writeFile(path.join(root, "index.html"), "<h1>ok</h1>");
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
