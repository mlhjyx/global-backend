import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertRuntimeArtifactClean,
  findForbiddenRuntimeArtifacts,
} from "./verify-runtime-artifact.mjs";
import { prepareSiteRendererRuntime } from "./prepare-site-renderer-runtime.mjs";
import { generateRuntimeSbom } from "./generate-runtime-sbom.mjs";
import { generateRuntimeArtifactManifest } from "./generate-runtime-artifact-manifest.mjs";
import { assertRuntimeImageValid } from "./verify-runtime-image.mjs";
import { pruneRuntimeDependencyTests } from "./prune-runtime-dependency-tests.mjs";

test("runtime artifact scan rejects product test and synthetic-provider bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-artifact-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "site-builder", "eval"), { recursive: true });
  await writeFile(join(root, "main.js"), "runtime");
  await writeFile(join(root, "gallery.js"), "visual fixture");
  await writeFile(join(root, "m1eb-golden.js"), "evaluation fixture generator");
  await writeFile(join(root, "quality.test-fixture.js"), "test fixture");
  await writeFile(
    join(root, "site-builder", "eval", "campaign.js"),
    "evaluation",
  );

  const violations = await findForbiddenRuntimeArtifacts(root);
  assert.deepEqual(
    violations.map((item) => item.path),
    [
      "gallery.js",
      "m1eb-golden.js",
      "quality.test-fixture.js",
      "site-builder/eval",
    ],
  );
  await assert.rejects(
    () => assertRuntimeArtifactClean(root),
    /forbidden runtime artifacts/i,
  );
});
test("renderer runtime bundle is created from a narrow product allowlist", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "renderer-runtime-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const target = join(root, "target");
  await mkdir(join(source, "src", "pages"), { recursive: true });
  await mkdir(join(source, "src", "testing"), { recursive: true });
  await mkdir(join(source, "fixtures"), { recursive: true });
  await mkdir(join(source, "product-assets", "design-demo-visuals"), {
    recursive: true,
  });
  await mkdir(join(source, "product-assets", "component-catalog-v1"), {
    recursive: true,
  });
  await mkdir(join(source, "public"), { recursive: true });
  await writeFile(join(source, "package.json"), '{"name":"renderer"}');
  await writeFile(join(source, "astro.config.mjs"), "export default {};");
  await writeFile(join(source, "playwright.config.ts"), "test config");
  await writeFile(join(source, "src", "pages", "index.astro"), "<main />");
  await writeFile(join(source, "src", "pages", "index.spec.ts"), "test");
  await writeFile(join(source, "src", "pages", "gallery.astro"), "<main />");
  await writeFile(join(source, "src", "testing", "probe.css"), "test-only");
  await writeFile(join(source, "fixtures", "site.json"), "{}");
  await writeFile(
    join(source, "product-assets", "design-demo-visuals", "approved.svg"),
    "<svg />",
  );
  await writeFile(
    join(
      source,
      "product-assets",
      "component-catalog-v1",
      "hero-banner-spec.json",
    ),
    '{"schemaVersion":"1.1.0"}',
  );
  await writeFile(join(source, "public", "robots.txt"), "User-agent: *");

  await prepareSiteRendererRuntime(source, target);

  const { readdir } = await import("node:fs/promises");
  const files = (
    await readdir(target, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) =>
      `${entry.parentPath.slice(target.length + 1)}/${entry.name}`.replace(
        /^\//,
        "",
      ),
    )
    .sort();
  assert.deepEqual(files, [
    "astro.config.mjs",
    "package.json",
    "product-assets/component-catalog-v1/hero-banner-spec.json",
    "product-assets/design-demo-visuals/approved.svg",
    "public/robots.txt",
    "src/pages/index.astro",
  ]);
  await assert.doesNotReject(() => assertRuntimeArtifactClean(target));
});

test("managed Worker loads qualified component templates from the product catalog", async () => {
  const loader = await import("node:fs/promises").then(({ readFile }) =>
    readFile(
      new URL(
        "../apps/api/src/site-builder/assembly/qualified-component-templates.ts",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.match(loader, /product-assets["'],\s*["']component-catalog-v1/);
  assert.doesNotMatch(
    loader,
    /["']fixtures["'],\s*["']component-qualification/,
  );
});

test("runtime artifact scan accepts the compiled product surface", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-artifact-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "runtime"), { recursive: true });
  await mkdir(join(root, "product-assets", "component-catalog-v1"), {
    recursive: true,
  });
  await writeFile(join(root, "main.js"), "runtime");
  await writeFile(join(root, "runtime", "identity.js"), "identity");
  await writeFile(
    join(
      root,
      "product-assets",
      "component-catalog-v1",
      "photo-gallery-spec.json",
    ),
    '{"componentType":"PhotoGallery"}',
  );

  await assert.doesNotReject(() => assertRuntimeArtifactClean(root));
});

test("single OCI Dockerfile uses one non-root runtime with api and worker entrypoints", async () => {
  const dockerfile = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../Dockerfile", import.meta.url), "utf8"),
  );
  assert.match(dockerfile, /FROM runtime-base AS runtime/);
  assert.match(dockerfile, /USER global/);
  assert.match(
    dockerfile,
    /ENTRYPOINT \["node",\s*"\/app\/runtime-entrypoint\.mjs"\]/,
  );
  assert.match(dockerfile, /verify-runtime-artifact\.mjs/);
  assert.match(dockerfile, /prepare-site-renderer-runtime\.mjs/);
  assert.match(dockerfile, /generate-runtime-sbom\.mjs/);
  assert.match(dockerfile, /--dpkg-inventory \/tmp\/runtime-os-packages\.tsv/);
  assert.match(dockerfile, /@global\/contracts@0\.0\.1/);
  assert.match(dockerfile, /generate-runtime-artifact-manifest\.mjs/);
  assert.match(
    dockerfile,
    /pnpm --filter @global\/api deploy --prod --frozen-lockfile \/tmp\/api-runtime-deploy/,
  );
  assert.match(
    dockerfile,
    /pnpm --filter @global\/site-renderer deploy --prod --frozen-lockfile \/tmp\/renderer-runtime-deploy/,
  );
  assert.match(
    dockerfile,
    /snapshot\.debian\.org\/archive\/debian\/20260826T000000Z/,
  );
  assert.match(
    dockerfile,
    /snapshot\.debian\.org\/archive\/debian-security\/20260826T000000Z/,
  );
  assert.match(dockerfile, /check-valid-until=no/);
  assert.match(
    dockerfile,
    /FROM alpine:3\.23\.3@sha256:25109184c71bdad752c8312a8623239686a9a2071e8825f20acb8f2198c3f659 AS ca-bootstrap/,
  );
  assert.match(
    dockerfile,
    /766392c21c0baf5fa722cb309dc576b89d9fb3323dd32aa45a939dd575db6d1c  \/etc\/ssl\/certs\/ca-certificates\.crt/,
  );
  assert.match(
    dockerfile,
    /COPY --from=ca-bootstrap \/etc\/ssl\/certs\/ca-certificates\.crt \/etc\/ssl\/certs\/ca-certificates\.crt/,
  );
  assert.doesNotMatch(dockerfile, /http:\/\/snapshot\.debian\.org/);
  assert.doesNotMatch(dockerfile, /deb\.debian\.org/);
  assert.doesNotMatch(dockerfile, /trusted\s*=\s*yes/i);
  assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists\/\*.*apt-get/s);
  assert.match(dockerfile, /chromium=151\.0\.7922\.173-1~deb12u1/);
  assert.match(dockerfile, /util-linux=2\.38\.1-5\+deb12u3/);
  assert.match(dockerfile, /dpkg-query -W/);
  assert.match(dockerfile, /ENV CHROME_PATH=\/usr\/bin\/chromium/);
  assert.match(dockerfile, /runtime-image-verifier\.mjs \/app/);
  assert.match(dockerfile, /prlimit --version/);
  assert.match(dockerfile, /node_modules\/\.pnpm\/node_modules\/@global\/api/);
  assert.match(
    dockerfile,
    /node_modules\/\.pnpm\/node_modules\/@global\/site-renderer/,
  );
  assert.match(dockerfile, /prune-runtime-dependency-tests\.mjs/);
  assert.doesNotMatch(dockerfile, /\/workspace\/node_modules \.\/node_modules/);
  assert.doesNotMatch(
    dockerfile,
    /\/workspace\/apps\/site-renderer \.\/apps\/site-renderer/,
  );
  const contractsPackage = JSON.parse(
    await readFile(
      new URL("../packages/contracts/package.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(contractsPackage.files, ["dist"]);
});

test("CI starts the final Worker artifact fail-closed before it can poll Temporal", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /name: Worker fail-closed runtime smoke/);
  assert.match(
    workflow,
    /RUNTIME_IMAGE_REFERENCE="global-backend-ci@\$\{LOCAL_IMAGE_DIGEST\}"/,
  );
  assert.match(workflow, /docker run --rm --network none --read-only/);
  assert.match(workflow, /"\$\{OCI_IMAGE\}" worker >"\$\{WORKER_LOG\}" 2>&1/);
  assert.match(workflow, /Temporal polling remains disabled/);
  assert.match(workflow, /understanding worker up/);
});

test("CI runs a zero-cost renderer build inside the final read-only OCI image", async () => {
  const [workflow, astroConfig, rendererPackage, sourceBuild] =
    await Promise.all([
      readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
      readFile(
        new URL("../apps/site-renderer/astro.config.mjs", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../apps/site-renderer/package.json", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL(
          "../apps/site-renderer/scripts/run-with-temporary-cache.mjs",
          import.meta.url,
        ),
        "utf8",
      ),
    ]);
  const smoke = workflow.slice(
    workflow.indexOf("- name: Renderer read-only OCI smoke"),
    workflow.indexOf("- name: Renderer contract tests"),
  );
  assert.notEqual(smoke.length, 0);
  assert.match(smoke, /docker run --rm --network none --read-only/);
  assert.match(smoke, /--tmpfs \/tmp:rw,noexec,nosuid,nodev/);
  assert.match(smoke, /renderer-build\.js/);
  assert.match(smoke, /fixtures\/demo-spec\.json/);
  assert.doesNotMatch(smoke, /node_modules[^\n]*:(?:rw|ro)/);
  assert.match(astroConfig, /root:\s*cacheRoot/);
  assert.match(astroConfig, /srcDir:\s*sourceRoot/);
  assert.match(
    astroConfig,
    /process\.env\.RENDERER_SOURCE_ROOT\s*\?\?\s*path\.join\(cacheRoot,\s*["']src["']\)/,
  );
  assert.match(astroConfig, /RENDERER_SOURCE_ROOT_INVALID/);
  assert.match(
    astroConfig,
    /cacheDir:\s*path\.join\(cacheRoot,\s*["']astro["']\)/,
  );
  assert.match(
    astroConfig,
    /vite:\s*\{\s*cacheDir:\s*path\.join\(cacheRoot,\s*["']vite["']\)/s,
  );
  assert.equal(
    JSON.parse(rendererPackage).scripts.build,
    "node scripts/run-with-temporary-cache.mjs build",
  );
  assert.equal(
    JSON.parse(rendererPackage).scripts.dev,
    "node scripts/run-with-temporary-cache.mjs dev",
  );
  assert.match(sourceBuild, /mkdtemp\(/);
  assert.match(sourceBuild, /global-site-renderer-source-cache-/);
  assert.match(sourceBuild, /\.site-renderer-dev-cache-/);
  assert.match(sourceBuild, /RENDERER_CACHE_ROOT: cacheRoot/);
  assert.match(sourceBuild, /const forwardedArgs = process\.argv\.slice\(3\)/);
  assert.match(sourceBuild, /SITE_RENDERER_CONFIG_OVERRIDE_FORBIDDEN/);
  assert.match(sourceBuild, /command === ["']dev["']/);
  assert.match(sourceBuild, /RENDERER_DEV_DEPENDENCY_ROOT/);
  assert.match(
    sourceBuild,
    /\["SITESPEC_PATH", "OUT_DIR", "PUBLIC_ASSET_DIR"\]/,
  );
  assert.match(sourceBuild, /path\.resolve\(rendererRoot, value\)/);
  assert.match(astroConfig, /RENDERER_DEV_DEPENDENCY_ROOT_INVALID/);
  assert.match(sourceBuild, /await cp\(fixedSourceRoot, sourceRoot/);
  assert.match(sourceBuild, /childEnv\.RENDERER_SOURCE_ROOT = fixedSourceRoot/);
  assert.match(sourceBuild, /command === ["']build["'] && !childEnv\.OUT_DIR/);
  assert.match(
    sourceBuild,
    /childEnv\.OUT_DIR = path\.join\(rendererRoot, ["']dist["']\)/,
  );
  assert.match(sourceBuild, /finally\s*\{/);
  assert.match(sourceBuild, /forwardSignal\(["']SIGTERM["']\)/);
  assert.match(sourceBuild, /forwardSignal\(["']SIGINT["']\)/);
  assert.match(sourceBuild, /child\.kill\(expectedSignal\)/);
  assert.match(sourceBuild, /expectedSignal === ["']SIGTERM["']\s*\? 143/);
  assert.match(sourceBuild, /expectedSignal === ["']SIGINT["']\s*\? 130/);
  assert.match(
    await readFile(
      new URL("../apps/site-renderer/playwright.config.ts", import.meta.url),
      "utf8",
    ),
    /exec node scripts\/run-with-temporary-cache\.mjs dev/,
  );
  assert.match(
    await readFile(
      new URL("../apps/site-renderer/playwright.config.ts", import.meta.url),
      "utf8",
    ),
    /gracefulShutdown: \{ signal: ["']SIGTERM["'], timeout: 10_000 \}/,
  );
  assert.match(
    sourceBuild,
    /rm\(cacheRoot, \{ recursive: true, force: true \}\)/,
  );
  assert.ok(
    sourceBuild.indexOf('process.once("SIGTERM", forwardTerm)') <
      sourceBuild.indexOf("await Promise.all"),
  );
  assert.doesNotMatch(sourceBuild, /shell:\s*true/);
});

test("production dependency pruning removes tests but preserves runtime modules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-dependency-prune-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const modules = join(root, "node_modules");
  await mkdir(join(modules, "package", "test"), { recursive: true });
  await mkdir(join(modules, "package", "src"), { recursive: true });
  await writeFile(join(modules, "package", "runtime.js"), "runtime");
  await writeFile(join(modules, "package", "test", "case.js"), "test");
  await writeFile(join(modules, "package", "src", "runtime.spec.js"), "test");
  const swaggerFixtures = join(
    modules,
    ".pnpm/@nestjs+swagger@11.4.6/node_modules/@nestjs/swagger/dist/fixtures",
  );
  await mkdir(swaggerFixtures, { recursive: true });
  await writeFile(
    join(swaggerFixtures, "document.base.js"),
    "required runtime module",
  );

  assert.equal(await pruneRuntimeDependencyTests(modules), 2);
  await assert.doesNotReject(() =>
    readFile(join(modules, "package", "runtime.js")),
  );
  await assert.doesNotReject(() =>
    readFile(join(swaggerFixtures, "document.base.js")),
  );
  await assert.rejects(
    () => readFile(join(modules, "package", "test", "case.js")),
    {
      code: "ENOENT",
    },
  );
  await assert.rejects(
    () => readFile(join(modules, "package", "src", "runtime.spec.js")),
    {
      code: "ENOENT",
    },
  );
});

test("final image verification binds every product component and permits only contained dependency links", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-image-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of [
    "apps/api/dist",
    "apps/site-renderer/src",
    "apps/site-renderer/product-assets/component-catalog-v1",
    "packages/contracts/dist",
  ]) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, "apps/api/dist/main.js"), "api");
  await writeFile(join(root, "apps/site-renderer/src/index.astro"), "renderer");
  await writeFile(
    join(
      root,
      "apps/site-renderer/product-assets/component-catalog-v1/area-gallery-spec.json",
    ),
    '{"componentType":"AreaGallery"}',
  );
  await writeFile(join(root, "packages/contracts/dist/index.js"), "contracts");
  const sbomPath = join(root, "apps/api/dist/runtime-sbom.cdx.json");
  await writeFile(
    sbomPath,
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.6",
      components: [
        { name: "zod", version: "3.23.8" },
        { name: "@global/contracts", version: "0.0.1" },
        {
          name: "chromium",
          version: "151.0.7922.173-1~deb12u1",
          purl: "pkg:deb/debian/chromium@151.0.7922.173-1~deb12u1?arch=amd64",
        },
      ],
    }),
  );
  await mkdir(join(root, "var/lib/dpkg"), { recursive: true });
  await writeFile(
    join(root, "var/lib/dpkg/status"),
    [
      "Package: chromium",
      "Status: install ok installed",
      "Architecture: amd64",
      "Version: 151.0.7922.173-1~deb12u1",
      "",
    ].join("\n"),
  );
  const manifest = await generateRuntimeArtifactManifest({
    buildSha: "c".repeat(40),
    builtAt: "2026-08-16T12:00:00.000Z",
    components: [
      { name: "api", root: join(root, "apps/api/dist") },
      { name: "contracts", root: join(root, "packages/contracts/dist") },
      { name: "renderer", root: join(root, "apps/site-renderer") },
    ],
    sourceRoots: [{ name: "api-source", root: join(root, "apps/api/dist") }],
    sbomPath,
  });
  const manifestPath = join(root, "apps/api/dist/artifact-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest));
  const manifestDigest = `sha256:${(await import("node:crypto"))
    .createHash("sha256")
    .update(await readFile(manifestPath))
    .digest("hex")}`;
  const sbomDigest = `sha256:${(await import("node:crypto"))
    .createHash("sha256")
    .update(await readFile(sbomPath))
    .digest("hex")}`;
  await writeFile(
    join(root, "apps/api/dist/build-attestation.json"),
    JSON.stringify({
      artifact_manifest_digest: manifestDigest,
      sbom_digest: sbomDigest,
      renderer_digest: manifest.components.find(
        ({ name }) => name === "renderer",
      ).digest,
    }),
  );
  await mkdir(
    join(root, "apps/api/node_modules/.pnpm/zod@3.23.8/node_modules/zod"),
    { recursive: true },
  );
  await mkdir(join(root, "apps/site-renderer/node_modules"), {
    recursive: true,
  });
  await writeFile(
    join(
      root,
      "apps/api/node_modules/.pnpm/zod@3.23.8/node_modules/zod/package.json",
    ),
    JSON.stringify({ name: "zod", version: "3.23.8" }),
  );
  await symlink(
    ".pnpm/zod@3.23.8/node_modules/zod",
    join(root, "apps/api/node_modules/zod"),
  );
  for (const deployment of ["apps/api", "apps/site-renderer"]) {
    const packageRoot = join(
      root,
      deployment,
      "node_modules/.pnpm/@global+contracts@file+packages+contracts/node_modules/@global/contracts",
    );
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(join(root, deployment, "node_modules/@global"), {
      recursive: true,
    });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@global/contracts",
        version: "0.0.1",
        files: ["dist"],
      }),
    );
    await writeFile(join(packageRoot, "dist/index.js"), "contracts");
    await symlink(
      "../.pnpm/@global+contracts@file+packages+contracts/node_modules/@global/contracts",
      join(root, deployment, "node_modules/@global/contracts"),
    );
  }
  const swaggerFixtureRoot = join(
    root,
    "apps/api/node_modules/.pnpm/@nestjs+swagger@11.4.6/node_modules/@nestjs/swagger/dist/fixtures",
  );
  await mkdir(swaggerFixtureRoot, { recursive: true });
  await writeFile(
    join(swaggerFixtureRoot, "document.base.js"),
    "required runtime module",
  );

  await assert.doesNotReject(() => assertRuntimeImageValid(root));
  await writeFile(
    join(
      root,
      "apps/api/node_modules/.pnpm/zod@3.23.8/node_modules/zod/runtime.spec.js",
    ),
    "dependency test bytes",
  );
  await assert.rejects(
    () => assertRuntimeImageValid(root),
    /PRODUCT_TEST_FILE_PRESENT/,
  );
  await rm(
    join(
      root,
      "apps/api/node_modules/.pnpm/zod@3.23.8/node_modules/zod/runtime.spec.js",
    ),
  );
  await writeFile(join(root, "apps/site-renderer/src/index.astro"), "tampered");
  await assert.rejects(
    () => assertRuntimeImageValid(root),
    /renderer component digest mismatch/,
  );
});

test("final image verification rejects dependency links escaping their deployment and dev-only packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-image-negative-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "apps/api/node_modules"), { recursive: true });
  await mkdir(join(root, "outside"));
  await symlink("../../../outside", join(root, "apps/api/node_modules/escape"));
  await assert.rejects(
    () => assertRuntimeImageValid(root),
    /dependency symlink escapes deployment root/,
  );

  await rm(join(root, "apps/api/node_modules/escape"));
  await mkdir(join(root, "apps/api/node_modules/.pnpm/vitest@4.1.10"), {
    recursive: true,
  });
  await assert.rejects(
    () => assertRuntimeImageValid(root),
    /DEV_DEPENDENCY_PRESENT/,
  );
});

test("Docker build context excludes local credentials while preserving env examples", async () => {
  const dockerignore = await import("node:fs/promises").then(({ readFile }) =>
    readFile(new URL("../.dockerignore", import.meta.url), "utf8"),
  );
  for (const pattern of [
    "**/.env",
    "**/.env.*",
    "**/.secrets",
    "**/.secrets/**",
    "**/*-sa-key.json",
    "**/gcp-*.json",
    "**/*.gcp-key.json",
    "**/dist-test-*",
    "**/.astro",
    "**/playwright-report",
    "**/test-results",
  ]) {
    assert.ok(
      dockerignore.split(/\r?\n/u).includes(pattern),
      `missing ${pattern}`,
    );
  }
  assert.ok(dockerignore.split(/\r?\n/u).includes("!**/.env.example"));
});

test("CycloneDX SBOM is deterministically derived from the production dependency graph", () => {
  const sbom = generateRuntimeSbom({
    buildSha: "a".repeat(40),
    builtAt: "2026-08-16T12:00:00.000Z",
    dependencyTrees: [
      {
        name: "@global/api",
        version: "0.0.1",
        path: "/workspace/apps/api",
        dependencies: {
          zod: { version: "4.4.3", path: "/workspace/node_modules/zod" },
        },
      },
    ],
    requiredComponents: [{ name: "@global/contracts", version: "0.0.1" }],
    operatingSystemPackages: [
      {
        name: "chromium",
        version: "151.0.7922.173-1~deb12u1",
        architecture: "amd64",
      },
    ],
  });
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.equal(sbom.specVersion, "1.6");
  assert.equal(sbom.metadata.timestamp, "2026-08-16T12:00:00.000Z");
  assert.deepEqual(
    sbom.components.map((component) => component.name),
    ["chromium", "@global/api", "@global/contracts", "zod"],
  );
  assert.ok(
    sbom.components.some(
      (component) =>
        component.purl ===
        "pkg:deb/debian/chromium@151.0.7922.173-1~deb12u1?arch=amd64",
    ),
  );
  assert.ok(
    sbom.dependencies.some(
      (item) => item.ref === "pkg:npm/%40global/api@0.0.1",
    ),
  );
  assert.doesNotMatch(JSON.stringify(sbom), /\/workspace/);
});

test("artifact manifest binds API, contracts, pruned renderer, SBOM and source tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runtime-manifest-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ["api", "contracts", "renderer", "source"]) {
    await mkdir(join(root, directory));
  }
  await writeFile(join(root, "api", "main.js"), "api");
  await writeFile(join(root, "contracts", "index.js"), "contracts");
  await writeFile(join(root, "renderer", "page.astro"), "renderer");
  await writeFile(join(root, "source", "main.ts"), "source");
  await writeFile(join(root, "source", "main.spec.ts"), "test-only");
  const sbomPath = join(root, "api", "runtime-sbom.cdx.json");
  await writeFile(sbomPath, '{"bomFormat":"CycloneDX"}');

  const manifest = await generateRuntimeArtifactManifest({
    buildSha: "b".repeat(40),
    builtAt: "2026-08-16T12:00:00.000Z",
    components: [
      { name: "api", root: join(root, "api") },
      { name: "contracts", root: join(root, "contracts") },
      { name: "renderer", root: join(root, "renderer") },
    ],
    sourceRoots: [{ name: "api-source", root: join(root, "source") }],
    sbomPath,
  });
  assert.equal(manifest.schema_version, "global-runtime-artifact-manifest/v1");
  assert.match(manifest.source_tree_digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(
    manifest.components.map((component) => component.name),
    ["api", "contracts", "renderer"],
  );
  assert.ok(
    manifest.source_roots[0].files.every(
      (file) => !file.path.endsWith(".spec.ts"),
    ),
  );
  assert.match(manifest.sbom.sha256, /^sha256:[0-9a-f]{64}$/);
});
