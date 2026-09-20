import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SECURITY_OVERRIDES = Object.freeze({
  "nanoid@>=3.0.0 <4.0.0": "3.3.18",
  postcss: "8.5.26",
  "js-yaml": "4.3.2",
  "fast-uri": "3.1.6",
  "deepmerge-ts": "8.0.1",
  multer: "2.3.0",
  "smol-toml": "1.7.1",
  svgo: "4.1.0",
  "third-party-web": "0.29.2",
});

test(
  "pnpm deploy preserves the reviewed third-party-web source when upstream latest moves",
  { timeout: 120_000 },
  async (t) => {
    const execute = promisify(execFile);
    const root = await mkdtemp(join(tmpdir(), "dependency-deploy-regression-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const archives = new Map();
    for (const version of ["0.29.2", "0.30.0"]) {
      const directory = join(root, `archive-${version}`);
      await mkdir(join(directory, "package"), { recursive: true });
      await writeFile(
        join(directory, "package/package.json"),
        JSON.stringify({ name: "third-party-web", version }),
      );
      await writeFile(
        join(directory, "package/source.txt"),
        `reviewed-source-${version}`,
      );
      await execute("tar", [
        "-czf",
        join(directory, "package.tgz"),
        "-C",
        directory,
        "package",
      ]);
      archives.set(version, await readFile(join(directory, "package.tgz")));
    }
    const traceDirectory = join(root, "trace-archive");
    await mkdir(join(traceDirectory, "package"), { recursive: true });
    await writeFile(
      join(traceDirectory, "package/package.json"),
      JSON.stringify({
        name: "@paulirish/trace_engine",
        version: "0.0.65",
        dependencies: { "third-party-web": "latest" },
      }),
    );
    await execute("tar", [
      "-czf",
      join(traceDirectory, "package.tgz"),
      "-C",
      traceDirectory,
      "package",
    ]);
    const traceArchive = await readFile(join(traceDirectory, "package.tgz"));
    let latest = "0.29.2";
    let registry;
    const server = createServer((request, response) => {
      if (request.url === "/trace-engine.tgz") {
        response.end(traceArchive);
        return;
      }
      if (
        decodeURIComponent(request.url ?? "") === "/@paulirish/trace_engine"
      ) {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            name: "@paulirish/trace_engine",
            "dist-tags": { latest: "0.0.65" },
            versions: {
              "0.0.65": {
                name: "@paulirish/trace_engine",
                version: "0.0.65",
                dependencies: { "third-party-web": "latest" },
                dist: { tarball: `${registry}trace-engine.tgz` },
              },
            },
          }),
        );
        return;
      }
      const version = request.url?.match(
        /^\/third-party-web\/-\/third-party-web-(0\.(?:29\.2|30\.0))\.tgz$/,
      )?.[1];
      if (version) {
        response.end(archives.get(version));
        return;
      }
      if (request.url !== "/third-party-web") {
        response.writeHead(404).end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: "third-party-web",
          "dist-tags": { latest },
          versions: Object.fromEntries(
            [...archives.keys()].map((item) => [
              item,
              {
                name: "third-party-web",
                version: item,
                dist: {
                  tarball: `${registry}third-party-web/-/third-party-web-${item}.tgz`,
                },
              },
            ]),
          ),
        }),
      );
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    t.after(() => new Promise((resolve) => server.close(resolve)));
    registry = `http://127.0.0.1:${server.address().port}/`;
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    const configuredPin = manifest.pnpm?.overrides?.["third-party-web"];

    async function deploy(pin, label) {
      const workspace = join(root, label);
      await mkdir(join(workspace, "app"), { recursive: true });
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({
          private: true,
          packageManager: "pnpm@9.15.9",
          ...(pin ? { pnpm: { overrides: { "third-party-web": pin } } } : {}),
        }),
      );
      await writeFile(
        join(workspace, "pnpm-workspace.yaml"),
        "packages:\n  - app\n",
      );
      // The real trace_engine manifest uses this same dist-tag. A tiny local package
      // lets us observe pnpm's actual resolver without network or lifecycle scripts.
      await writeFile(
        join(workspace, "app/package.json"),
        JSON.stringify({
          name: "deploy-fixture",
          version: "1.0.0",
          dependencies: { "@paulirish/trace_engine": "0.0.65" },
        }),
      );
      const env = {
        ...process.env,
        CI: "true",
        NPM_CONFIG_USERCONFIG: "/dev/null",
        NPM_CONFIG_GLOBALCONFIG: "/dev/null",
      };
      const options = {
        cwd: workspace,
        env,
        timeout: 50_000,
        maxBuffer: 2 * 1024 * 1024,
      };
      const common = [
        "--ignore-scripts",
        "--ignore-pnpmfile",
        `--registry=${registry}`,
        `--store-dir=${join(workspace, "store")}`,
      ];
      latest = "0.29.2";
      await execute(
        "pnpm",
        [
          "install",
          ...common,
          `--cache-dir=${join(workspace, "install-cache")}`,
        ],
        options,
      );
      assert.match(
        await readFile(join(workspace, "pnpm-lock.yaml"), "utf8"),
        /third-party-web: 0\.29\.2/,
      );
      latest = "0.30.0";
      const target = join(workspace, "deployed");
      // An empty metadata cache models a fresh Docker layer seeing today's dist-tag.
      await execute(
        "pnpm",
        [
          "--filter",
          "deploy-fixture",
          "deploy",
          "--prod",
          "--frozen-lockfile",
          ...common,
          `--cache-dir=${join(workspace, "deploy-cache")}`,
          target,
        ],
        options,
      );
      return readFile(
        join(
          target,
          "node_modules/.pnpm/node_modules/third-party-web/source.txt",
        ),
        "utf8",
      );
    }

    assert.equal(
      await deploy(undefined, "unpinned-control"),
      "reviewed-source-0.30.0",
      "pnpm 9 deploy control must reproduce the frozen-lockfile dist-tag drift",
    );
    assert.equal(
      await deploy(configuredPin, "repository-policy"),
      "reviewed-source-0.29.2",
      "repository override must preserve the reviewed deployed source",
    );
  },
);

const FORBIDDEN_LOCKFILE_SNAPSHOTS = Object.freeze([
  "extract-zip@2.0.1",
  "nanoid@3.3.15",
  "nanoid@3.3.16",
  "nanoid@3.3.17",
  "baseline-browser-mapping@2.10.43",
  "browserslist@4.28.6",
  "fast-uri@3.1.5",
]);

const REQUIRED_RUNTIME_SECURITY_SNAPSHOTS = Object.freeze([
  "@nestjs/core@11.2.3",
  "express@5.2.1",
  "body-parser@2.3.0",
  "qs@6.16.0",
  "fast-uri@3.1.6",
  "browserslist@4.28.7",
  "baseline-browser-mapping@2.10.44",
  "multer@2.3.0",
  "path-to-regexp@8.4.2",
  "file-type@21.3.4",
  "fast-xml-parser@5.11.0",
]);

const FORBIDDEN_RUNTIME_SECURITY_SNAPSHOTS = Object.freeze([
  "@nestjs/core@10.4.22",
  "express@4.22.1",
  "body-parser@1.20.4",
  "qs@6.15.3",
  "qs@6.14.2",
  "multer@2.0.2",
  "path-to-regexp@0.1.13",
  "path-to-regexp@0.2.5",
  "path-to-regexp@3.3.0",
  "file-type@20.4.1",
  "fast-xml-parser@4.5.7",
]);

function lockfileHasSnapshot(lockfile, snapshot) {
  const key = snapshot.startsWith("@") ? `  '${snapshot}':` : `  ${snapshot}:`;
  return lockfile.includes(key);
}

test("production security remediation removes the unpatched extract-zip path", async () => {
  const apiManifest = JSON.parse(
    await readFile("apps/api/package.json", "utf8"),
  );
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  assert.equal(apiManifest.dependencies?.lighthouse, "13.4.1");
  for (const snapshot of FORBIDDEN_LOCKFILE_SNAPSHOTS) {
    assert.equal(
      new RegExp(`^  ${snapshot.replaceAll(".", "\\.")}:`, "mu").test(lockfile),
      false,
      `${snapshot} must not remain in the production dependency graph`,
    );
  }
});

test("nanoid v3 is pinned to the current patched security floor", async () => {
  const rootManifest = JSON.parse(await readFile("package.json", "utf8"));

  assert.deepEqual(rootManifest.pnpm?.overrides, SECURITY_OVERRIDES);
});

test("extract-zip is remediated by removal, not a baseline exception", async () => {
  const baseline = await readFile(
    "docs/security/production-dependency-audit-baseline.json",
    "utf8",
  );

  assert.doesNotMatch(baseline, /GHSA-jmr9-qjv8-65gv|extract-zip/u);
});

test("reviewed runtime security floors replace every vulnerable predecessor snapshot", async () => {
  const lockfile = await readFile("pnpm-lock.yaml", "utf8");

  for (const snapshot of REQUIRED_RUNTIME_SECURITY_SNAPSHOTS) {
    assert.equal(
      lockfileHasSnapshot(lockfile, snapshot),
      true,
      `${snapshot} must remain in the reviewed runtime dependency graph`,
    );
  }
  for (const snapshot of FORBIDDEN_RUNTIME_SECURITY_SNAPSHOTS) {
    assert.equal(
      lockfileHasSnapshot(lockfile, snapshot),
      false,
      `${snapshot} must not re-enter the dependency graph`,
    );
  }
});
