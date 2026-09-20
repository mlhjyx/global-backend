import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSiteSpecWithTemporaryFile } from "../../api/src/site-builder/renderer-build";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("site renderer product artifact boundary", () => {
  it("does not emit a visual gallery route in a production site build", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "site-renderer-product-"));
    roots.push(outDir);
    const spec = JSON.parse(
      await readFile(join(process.cwd(), "fixtures/demo-spec.json"), "utf8"),
    ) as unknown;
    await buildSiteSpecWithTemporaryFile(spec, {
      outDir,
      basePath: "/",
      siteOrigin: "https://preview.example.test",
    });

    expect(existsSync(join(outDir, "gallery", "index.html"))).toBe(false);
  }, 90_000);
});
