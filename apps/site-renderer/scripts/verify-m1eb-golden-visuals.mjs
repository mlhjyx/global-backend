import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const rendererRoot = path.resolve(import.meta.dirname, "..");
const fixturesRoot = path.join(rendererRoot, "fixtures", "m1-e-b-golden");
const sourceAssetsRoot = path.join(
  rendererRoot,
  "fixtures",
  "design-demo-visuals",
);
const snapshotRoot = path.join(
  rendererRoot,
  "visual-tests",
  "__screenshots__",
  "m1-e-b",
);
const update = process.env.M1EB_GOLDEN_UPDATE_SNAPSHOTS === "1";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const fixtureManifest = JSON.parse(
  await readFile(path.join(fixturesRoot, "manifest.json"), "utf8"),
);
if (
  fixtureManifest.schemaVersion !== "site-builder-m1-e-b-golden-manifest/v1" ||
  fixtureManifest.fixtures.length !== 12
) {
  throw new Error("M1_E_B_GOLDEN_MANIFEST_INVALID");
}

const overlay = await mkdtemp(path.join(tmpdir(), "m1-e-b-public-"));
await chmod(overlay, 0o700);
try {
  const catalogDirectory = path.join(overlay, "assets", "catalog");
  await mkdir(catalogDirectory, { recursive: true });
  const sourceByDigest = new Map();
  for (const filename of await readdir(sourceAssetsRoot)) {
    if (!filename.endsWith(".svg")) continue;
    const bytes = await readFile(path.join(sourceAssetsRoot, filename));
    sourceByDigest.set(sha256(bytes), bytes);
  }

  for (const fixture of fixtureManifest.fixtures) {
    const fixturePath = path.join(fixturesRoot, `${fixture.id}-spec.json`);
    const fixtureBytes = await readFile(fixturePath);
    if (sha256(fixtureBytes) !== fixture.specSha256) {
      throw new Error(`M1_E_B_GOLDEN_SPEC_HASH_MISMATCH: ${fixture.id}`);
    }
    const spec = JSON.parse(fixtureBytes);
    for (const asset of Object.values(spec.assets)) {
      if (asset.source !== "catalog") continue;
      const bytes = sourceByDigest.get(asset.sha256);
      if (!bytes || asset.mimeType !== "image/svg+xml") {
        throw new Error(
          `M1_E_B_GOLDEN_CATALOG_ASSET_MISSING: ${fixture.id}/${asset.catalogAssetId}`,
        );
      }
      const target = path.join(catalogDirectory, `${asset.sha256}.svg`);
      await writeFile(target, bytes, { flag: "wx" }).catch(async (error) => {
        if (error?.code !== "EEXIST") throw error;
        if (sha256(await readFile(target)) !== asset.sha256) throw error;
      });
    }
    const args = [
      "exec",
      "playwright",
      "test",
      "visual-tests/m1eb-golden.spec.ts",
      ...(update ? ["--update-snapshots"] : []),
    ];
    const result = spawnSync("pnpm", args, {
      cwd: rendererRoot,
      env: {
        ...process.env,
        M1EB_GOLDEN_ID: fixture.id,
        SITESPEC_PATH: fixturePath,
        PUBLIC_ASSET_DIR: overlay,
      },
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`M1_E_B_GOLDEN_VISUAL_FAILED: ${fixture.id}`);
    }
  }

  const evidence = [];
  for (const project of ["desktop-1440", "mobile-375", "tablet-768"]) {
    for (const fixture of fixtureManifest.fixtures) {
      const relativePath = `${project}/${fixture.id}.png`;
      const bytes = await readFile(path.join(snapshotRoot, relativePath));
      evidence.push({
        fixtureId: fixture.id,
        viewport: project,
        path: relativePath,
        sha256: sha256(bytes),
      });
    }
  }
  evidence.sort((left, right) => left.path.localeCompare(right.path));
  const evidenceManifestPath = path.join(snapshotRoot, "manifest.json");
  const expected = {
    schemaVersion: "site-builder-m1-e-b-visual-evidence/v1",
    screenshotCount: 36,
    screenshots: evidence,
  };
  if (update) {
    await writeFile(
      evidenceManifestPath,
      `${JSON.stringify(expected, null, 2)}\n`,
    );
  } else {
    const observed = JSON.parse(await readFile(evidenceManifestPath, "utf8"));
    if (JSON.stringify(observed) !== JSON.stringify(expected)) {
      throw new Error("M1_E_B_GOLDEN_VISUAL_HASH_MISMATCH");
    }
  }
  console.log("verified 12 M1-e-B Golden specs and 36 byte-pinned screenshots");
} finally {
  await rm(overlay, { recursive: true, force: true });
}
