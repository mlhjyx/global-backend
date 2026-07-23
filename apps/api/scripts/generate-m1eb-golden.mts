import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { format } from "prettier";
import { buildM1ebGoldenFixtures } from "../src/site-builder/design/m1eb-golden";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const outputDirectory = path.join(
  repositoryRoot,
  "apps/site-renderer/fixtures/m1-e-b-golden",
);
await mkdir(outputDirectory, { recursive: true });

const fixtures = await buildM1ebGoldenFixtures(repositoryRoot);
const expectedFiles = new Set<string>();
const manifest = [];
for (const fixture of fixtures) {
  const filename = `${fixture.id}-spec.json`;
  const bytes = Buffer.from(
    await format(JSON.stringify(fixture.spec), { parser: "json" }),
  );
  expectedFiles.add(filename);
  await writeFile(path.join(outputDirectory, filename), bytes);
  manifest.push({
    id: fixture.id,
    mode: fixture.mode,
    familyId: fixture.spec.site.familyId,
    designBriefDigest: fixture.designBrief.digest,
    specSha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
expectedFiles.add("manifest.json");
await writeFile(
  path.join(outputDirectory, "manifest.json"),
  await format(
    JSON.stringify({
      schemaVersion: "site-builder-m1-e-b-golden-manifest/v1",
      catalogVersion: "m1-e-b/1.0.0",
      rendererVersion: "site-renderer@m1-e-b/1.0.0",
      fixtures: manifest,
    }),
    { parser: "json" },
  ),
);

const unexpected = (await readdir(outputDirectory)).filter(
  (filename) => !expectedFiles.has(filename),
);
if (unexpected.length > 0) {
  throw new Error(`M1_E_B_GOLDEN_STALE_FILES: ${unexpected.sort().join(",")}`);
}
console.log(`wrote ${fixtures.length} M1-e-B SiteSpec 1.1 Golden fixtures`);
