import type { SiteSpecV1_1 } from "@global/contracts";
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
import { describe, expect, it } from "vitest";
import {
  collectBrowserQualityFacts,
  startLoopbackStaticServer,
} from "./browser-quality-runner";
import { releaseSpecDigest } from "../release-artifact";

async function loadSpec(): Promise<SiteSpecV1_1> {
  const repositoryRoot = path.resolve(
    new URL("../../../../../", import.meta.url).pathname,
  );
  return JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        "apps/site-renderer/fixtures/m1-e-b-golden/natural-origin-rich-spec.json",
      ),
      "utf8",
    ),
  ) as SiteSpecV1_1;
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
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Fixture"}</script>
  </head>
  <body>
    <main><h1>Quality fixture</h1><p>Bounded local content.</p><a class="btn" href="/detail">Details</a></main>
    <img src="https://outside.invalid/blocked.png" alt="blocked egress probe">
  </body>
</html>`;
}

describe("bounded browser quality runner", () => {
  it(
    "captures all breakpoints, runs axe and Lighthouse, and records blocked egress",
    async () => {
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
          '<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://preview.invalid/</loc></url></urlset>',
        );
        const spec = await loadSpec();
        const facts = await collectBrowserQualityFacts({
          spec,
          buildRoot: root,
          candidateSpecDigest: releaseSpecDigest(spec),
          designBriefDigest: "b".repeat(64),
          round: 0,
          structuredDataFactValidator: () => true,
          candidateValidator: () => undefined,
        });
        expect(facts.pages).toHaveLength(2);
        for (const page of facts.pages) {
          expect(Object.keys(page.screenshots).sort()).toEqual([
            "1440",
            "375",
            "768",
          ]);
          expect(page.externalRequests).toContain(
            "https://outside.invalid",
          );
          expect(page.robotsTxtOk).toBe(true);
          expect(page.sitemapOk).toBe(true);
          expect(page.jsonLdUnsupportedFacts).toBe(false);
        }
        expect(facts.lighthouse).toHaveLength(2);
        expect(facts.lighthouse.map(({ breakpoint }) => breakpoint)).toEqual([
          375,
          1440,
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );

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
});
