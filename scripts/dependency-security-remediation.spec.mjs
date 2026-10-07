import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);

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
    const manifest = JSON.parse(
      await readFile(new URL("package.json", repositoryRoot), "utf8"),
    );
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

// Removed outright: no patched release exists to hold a floor for.
const FORBIDDEN_LOCKFILE_SNAPSHOTS = Object.freeze(["extract-zip@2.0.1"]);

// Minimum reviewed versions in the resolved graph. Routine upgrades pass without
// editing this table; an older release of a listed package fails wherever it is
// pulled in. `from` confines a floor to the remediated line where an older line
// legitimately coexists (undici 7, file-type 3). The root pnpm.overrides are one
// way to hold a floor, so an override may retire once upstream ranges hold it.
const SECURITY_FLOORS = Object.freeze(
  [
    { name: "nanoid", floor: "3.3.18" },
    { name: "postcss", floor: "8.5.26" },
    { name: "js-yaml", floor: "4.3.2" },
    { name: "fast-uri", floor: "3.1.8" },
    { name: "deepmerge-ts", floor: "8.0.1" },
    { name: "multer", floor: "2.4.0" },
    { name: "smol-toml", floor: "1.9.0" },
    { name: "svgo", floor: "4.1.0" },
    { name: "lodash", floor: "4.18.1" },
    { name: "uuid", floor: "11.1.1" },
    { name: "undici", from: "8.0.0", floor: "8.10.2" },
    { name: "@nestjs/core", floor: "11.2.3" },
    { name: "express", floor: "5.2.1" },
    { name: "body-parser", floor: "2.3.0" },
    { name: "qs", floor: "6.16.0" },
    { name: "browserslist", floor: "4.28.7" },
    { name: "baseline-browser-mapping", floor: "2.11.25" },
    { name: "path-to-regexp", floor: "8.4.2" },
    { name: "file-type", from: "20.0.0", floor: "21.3.4" },
    { name: "fast-xml-parser", floor: "5.11.0" },
    { name: "@grpc/grpc-js", floor: "1.14.5" },
    { name: "axios", floor: "1.20.0" },
    { name: "brace-expansion", from: "4.0.0", floor: "5.0.12" },
    { name: "http-cache-semantics", floor: "4.3.0" },
    { name: "sharp", floor: "0.35.5" },
  ].map((entry) => Object.freeze(entry)),
);

// Every vulnerable release a floor replaced. Each must stay below its floor, so a
// floor cannot be lowered back past a known-bad release.
const VULNERABLE_PREDECESSORS = Object.freeze([
  "nanoid@3.3.15",
  "nanoid@3.3.16",
  "nanoid@3.3.17",
  "fast-uri@3.1.5",
  "fast-uri@3.1.6",
  "browserslist@4.28.6",
  "baseline-browser-mapping@2.10.43",
  "@nestjs/core@10.4.22",
  "express@4.22.1",
  "body-parser@1.20.4",
  "qs@6.15.3",
  "qs@6.14.2",
  "multer@2.0.2",
  "multer@2.3.0",
  "undici@8.10.0",
  "path-to-regexp@0.1.13",
  "path-to-regexp@0.2.5",
  "path-to-regexp@3.3.0",
  "file-type@20.4.1",
  "fast-xml-parser@4.5.7",
  "@grpc/grpc-js@1.14.4",
  "axios@1.18.1",
  "brace-expansion@5.0.9",
  "smol-toml@1.7.1",
  "http-cache-semantics@4.2.0",
  "sharp@0.35.4",
]);

function resolvedPackageVersions(lockfile) {
  const start = lockfile.indexOf("\npackages:\n");
  const end = lockfile.indexOf("\nsnapshots:\n", start);
  assert.ok(
    start !== -1 && end !== -1,
    "pnpm-lock.yaml must keep its packages section ahead of snapshots",
  );
  const versions = new Map();
  for (const [, name, version] of lockfile
    .slice(start, end)
    .matchAll(/^ {2}'?(@?[^@\s']+)@(.+?)'?:$/gmu)) {
    versions.set(name, [...(versions.get(name) ?? []), version]);
  }
  return versions;
}

function parseRelease(version) {
  const match =
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/u.exec(
      version,
    );
  return match
    ? { core: match.slice(1, 4).map(Number), prerelease: match[4] }
    : undefined;
}

function compareCore(left, right) {
  const index = left.core.findIndex((part, i) => part !== right.core[i]);
  return index === -1 ? 0 : Math.sign(left.core[index] - right.core[index]);
}

function meetsFloor(release, floor) {
  if (!release) return false;
  const order = compareCore(release, floor);
  // A prerelease sorts below the release it previews.
  return order > 0 || (order === 0 && release.prerelease === undefined);
}

function findSecurityFloorViolations(lockfile, floors) {
  const resolved = resolvedPackageVersions(lockfile);
  return floors.flatMap(({ name, from = "0.0.0", floor }) => {
    const lineStart = parseRelease(from);
    const minimum = parseRelease(floor);
    assert.ok(
      lineStart && minimum && !lineStart.prerelease && !minimum.prerelease,
      `${name} security floor must name plain release versions`,
    );
    const covered = (resolved.get(name) ?? []).filter((version) => {
      const release = parseRelease(version);
      // A version that cannot be compared stays covered and fails the floor.
      return !release || compareCore(release, lineStart) >= 0;
    });
    if (covered.length === 0) return [{ name, version: null, floor }];
    return covered
      .filter((version) => !meetsFloor(parseRelease(version), minimum))
      .map((version) => ({ name, version, floor }));
  });
}

// An override rewrites every matching dependency in the graph, so it may only
// pin an exact release: never a range, an alias to another package, or a source.
function findLooseOverrides(overrides) {
  return Object.entries(overrides ?? {})
    .filter(([, pin]) => {
      const release = parseRelease(pin);
      return !release || release.prerelease !== undefined;
    })
    .map(([selector]) => selector);
}

function lockfileWith(...snapshots) {
  const entries = snapshots.map((snapshot) => {
    const key =
      snapshot.startsWith("@") || snapshot.includes(":")
        ? `'${snapshot}'`
        : snapshot;
    return `  ${key}:\n    resolution: {integrity: sha512-fixture}\n`;
  });
  return `lockfileVersion: '9.0'\n\npackages:\n\n${entries.join("\n")}\nsnapshots:\n\n`;
}

test("production security remediation removes the unpatched extract-zip path", async () => {
  const apiManifest = JSON.parse(
    await readFile(new URL("apps/api/package.json", repositoryRoot), "utf8"),
  );
  const lockfile = await readFile(
    new URL("pnpm-lock.yaml", repositoryRoot),
    "utf8",
  );

  assert.equal(apiManifest.dependencies?.lighthouse, "13.4.1");
  for (const snapshot of FORBIDDEN_LOCKFILE_SNAPSHOTS) {
    assert.equal(
      new RegExp(`^  ${snapshot.replaceAll(".", "\\.")}:`, "mu").test(lockfile),
      false,
      `${snapshot} must not remain in the production dependency graph`,
    );
  }
});

test("the resolved dependency graph meets every reviewed security floor", async () => {
  const lockfile = await readFile(
    new URL("pnpm-lock.yaml", repositoryRoot),
    "utf8",
  );

  assert.deepEqual(findSecurityFloorViolations(lockfile, SECURITY_FLOORS), []);
});

test("extract-zip is remediated by removal, not a baseline exception", async () => {
  const baseline = await readFile(
    new URL(
      "docs/security/production-dependency-audit-baseline.json",
      repositoryRoot,
    ),
    "utf8",
  );

  assert.doesNotMatch(baseline, /GHSA-jmr9-qjv8-65gv|extract-zip/u);
});

test("reviewed security floors keep every recorded vulnerable predecessor out", () => {
  for (const snapshot of VULNERABLE_PREDECESSORS) {
    const separator = snapshot.lastIndexOf("@");
    const name = snapshot.slice(0, separator);
    const version = snapshot.slice(separator + 1);
    const floors = SECURITY_FLOORS.filter((entry) => entry.name === name);

    assert.ok(
      findSecurityFloorViolations(lockfileWith(snapshot), floors).some(
        (violation) => violation.version === version,
      ),
      `${snapshot} must stay below a reviewed security floor`,
    );
  }
});

test("security floors admit upgrades but reject any older release beside the patched one", () => {
  const floors = [
    { name: "qs", floor: "6.16.0" },
    { name: "@nestjs/core", floor: "11.2.3" },
  ];

  assert.deepEqual(
    findSecurityFloorViolations(
      lockfileWith("qs@6.17.0", "@nestjs/core@11.2.7"),
      floors,
    ),
    [],
  );
  assert.deepEqual(
    findSecurityFloorViolations(
      lockfileWith(
        "qs@6.14.0",
        "qs@6.16.0",
        "qs@6.16.0-rc.1",
        "@nestjs/core@11.2.3",
      ),
      floors,
    ),
    [
      { name: "qs", version: "6.14.0", floor: "6.16.0" },
      { name: "qs", version: "6.16.0-rc.1", floor: "6.16.0" },
    ],
  );
});

test("a scoped security floor ignores older lines but fails closed when it covers nothing or cannot compare", () => {
  const floors = [{ name: "undici", from: "8.0.0", floor: "8.10.2" }];

  assert.deepEqual(
    findSecurityFloorViolations(
      lockfileWith("undici@7.29.1", "undici@8.10.2"),
      floors,
    ),
    [],
  );
  assert.deepEqual(
    findSecurityFloorViolations(lockfileWith("undici@7.29.1"), floors),
    [{ name: "undici", version: null, floor: "8.10.2" }],
  );
  assert.deepEqual(
    findSecurityFloorViolations(
      lockfileWith("undici@8.0.0-rc.1", "undici@8", "undici@8.10.2"),
      floors,
    ),
    [
      { name: "undici", version: "8.0.0-rc.1", floor: "8.10.2" },
      { name: "undici", version: "8", floor: "8.10.2" },
    ],
  );
  const tarball = "https://codeload.github.com/nodejs/undici/tar.gz/0123abc";
  assert.deepEqual(
    findSecurityFloorViolations(
      lockfileWith("undici@8.10.2", `undici@${tarball}`),
      floors,
    ),
    [{ name: "undici", version: tarball, floor: "8.10.2" }],
  );
  for (const invalid of [
    { name: "undici", floor: "8.10" },
    { name: "undici", from: "8", floor: "8.10.2" },
    { name: "undici", floor: "8.10.2-rc.1" },
  ]) {
    assert.throws(
      () =>
        findSecurityFloorViolations(lockfileWith("undici@8.10.2"), [invalid]),
      /undici security floor must name plain release versions/,
    );
  }
});

test("root overrides pin exact releases rather than ranges, aliases or sources", async () => {
  assert.deepEqual(
    findLooseOverrides({
      qs: "6.16.0",
      "undici@>=8.0.0 <8.10.2": "8.10.2",
      lodash: "^4.18.1",
      multer: "npm:multer-fork@2.4.0",
      svgo: "github:svg/svgo#main",
      postcss: "8.5.26-beta.1",
    }),
    ["lodash", "multer", "svgo", "postcss"],
  );
  const manifest = JSON.parse(
    await readFile(new URL("package.json", repositoryRoot), "utf8"),
  );

  assert.deepEqual(findLooseOverrides(manifest.pnpm?.overrides), []);
});
