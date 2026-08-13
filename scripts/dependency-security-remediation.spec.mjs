import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const EXPECTED_SECURITY_OVERRIDES = Object.freeze({
  "body-parser@>=1.0.0 <2.0.0": "1.20.6",
  "brace-expansion@>=1.0.0 <2.0.0": "1.1.18",
  "brace-expansion@>=2.0.0 <3.0.0": "2.1.4",
  "fast-uri@>=3.0.0 <4.0.0": "3.1.5",
  "ip-address@>=10.0.0 <11.0.0": "10.3.1",
  "js-yaml@>=3.0.0 <4.0.0": "3.15.1",
  "js-yaml@>=4.0.0 <5.0.0": "4.3.1",
  "js-yaml@>=5.0.0 <6.0.0": "5.2.2",
  "multer@>=2.0.0 <3.0.0": "2.2.0",
  "nanoid@>=3.0.0 <4.0.0": "3.3.17",
  "postcss@>=8.0.0 <9.0.0": "8.5.23",
  "qs@>=6.0.0 <7.0.0": "6.15.3",
});

const FORBIDDEN_LOCKFILE_SNAPSHOTS = Object.freeze([
  "body-parser@1.20.4",
  "brace-expansion@1.1.16",
  "brace-expansion@2.1.2",
  "fast-uri@3.1.3",
  "fast-xml-parser@4.5.7",
  "ip-address@10.2.0",
  "js-yaml@3.15.0",
  "js-yaml@4.2.0",
  "js-yaml@4.3.0",
  "js-yaml@5.2.1",
  "multer@2.0.2",
  "nanoid@3.3.15",
  "nanoid@3.3.16",
  "postcss@8.5.16",
  "postcss@8.5.19",
  "qs@6.14.2",
  "path-to-regexp@0.2.5",
  "astro@5.18.2",
  "extract-zip@2.0.1",
  "sharp@0.34.5",
]);

test("production security floors are explicit and major-scoped", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8"));

  assert.deepEqual(manifest.pnpm?.overrides, EXPECTED_SECURITY_OVERRIDES);
  for (const selector of Object.keys(EXPECTED_SECURITY_OVERRIDES)) {
    assert.match(selector, /@>=\d+\.0\.0 <\d+\.0\.0$/u);
  }
});

test("the lockfile contains none of the remediated vulnerable snapshots", async () => {
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  for (const snapshot of FORBIDDEN_LOCKFILE_SNAPSHOTS) {
    assert.equal(
      new RegExp(`^  ${snapshot.replaceAll(".", "\\.")}:`, "mu").test(
        lockfile,
      ),
      false,
      `${snapshot} must not remain in the resolved dependency graph`,
    );
  }
});

test("the API has no production serve-static or multipart controller surface", async () => {
  const [apiManifestText, m0Verifier, previewStaticTracked, apiSourceInventory] =
    await Promise.all([
      readFile("apps/api/package.json", "utf8"),
      readFile("apps/api/scripts/verify-site-builder-m0.mts", "utf8"),
      readFile("apps/api/src/site-builder/preview-static.ts", "utf8").then(
        () => true,
        (error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        },
      ),
      import("node:child_process").then(
        ({ execFileSync }) =>
          execFileSync(
            "git",
            [
              "grep",
              "-nE",
              "FileInterceptor|FilesInterceptor|AnyFilesInterceptor|MulterModule",
              "--",
              "apps/api/src",
            ],
            { encoding: "utf8" },
          ),
      ).catch((error) => {
        if (error?.status === 1 && error?.stdout === "") return "";
        throw error;
      }),
    ]);
  const apiManifest = JSON.parse(apiManifestText);

  assert.equal(apiManifest.dependencies?.["@nestjs/serve-static"], undefined);
  assert.doesNotMatch(m0Verifier, /@nestjs\/serve-static/u);
  assert.equal(previewStaticTracked, false);
  assert.equal(apiSourceInventory, "");
});

test("the API XML parser uses the patched major line", async () => {
  const apiManifest = JSON.parse(await readFile("apps/api/package.json", "utf8"));

  assert.equal(apiManifest.dependencies?.["fast-xml-parser"], "5.7.1");
});

test("the browser quality runner uses the current Lighthouse security line", async () => {
  const apiManifest = JSON.parse(await readFile("apps/api/package.json", "utf8"));

  assert.equal(apiManifest.dependencies?.lighthouse, "13.4.1");
});

test("the API uses the patched Nest and Express platform line", async () => {
  const apiManifest = JSON.parse(await readFile("apps/api/package.json", "utf8"));

  assert.equal(apiManifest.dependencies?.["@nestjs/common"], "11.1.29");
  assert.equal(apiManifest.dependencies?.["@nestjs/core"], "11.1.29");
  assert.equal(apiManifest.dependencies?.["@nestjs/platform-express"], "11.1.29");
  assert.equal(apiManifest.devDependencies?.["@nestjs/cli"], "11.0.24");
});

test("the renderer uses the current Astro security line and runtime floor", async () => {
  const [
    rootManifestText,
    rendererManifestText,
    rendererConfig,
    playwrightConfig,
    reservedFetch,
  ] =
    await Promise.all([
      readFile("package.json", "utf8"),
      readFile("apps/site-renderer/package.json", "utf8"),
      readFile("apps/site-renderer/astro.config.mjs", "utf8"),
      readFile("apps/site-renderer/playwright.config.ts", "utf8"),
      readFile("apps/site-renderer/src/fetch.ts", "utf8").then(
        () => true,
        (error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        },
      ),
    ]);
  const rootManifest = JSON.parse(rootManifestText);
  const rendererManifest = JSON.parse(rendererManifestText);

  assert.equal(rootManifest.engines?.node, ">=22.19.0");
  assert.equal(rendererManifest.dependencies?.astro, "7.2.1");
  assert.equal(reservedFetch, false);
  assert.doesNotMatch(rendererConfig, /\bexperimental\s*:/u);
  assert.match(playwrightConfig, /ASTRO_DEV_BACKGROUND=0 pnpm dev/u);
});
