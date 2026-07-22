import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS } from "@global/contracts";

const rendererRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);
const repositoryRoot = resolve(rendererRoot, "../..");

const requestedComponents = new Set(
  (process.env.COMPONENT_QUALIFICATION_COMPONENTS ?? "")
    .split(",")
    .filter(Boolean),
);

const fixtureArtifacts = Object.values(
  M1_E_A_COMPONENT_QUALIFICATION_ARTIFACTS,
).filter(
  (artifact) =>
    artifact.part === "fixtures" &&
    (requestedComponents.size === 0 ||
      requestedComponents.has(artifact.componentType)),
);

if (fixtureArtifacts.length === 0) {
  throw new Error("COMPONENT_QUALIFICATION_FIXTURE_NOT_FOUND");
}

const updateSnapshots =
  process.env.COMPONENT_QUALIFICATION_UPDATE_SNAPSHOTS === "1";

for (const artifact of fixtureArtifacts) {
  const [fixture] = artifact.fixtureFiles;
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "visual-tests/component-qualification-fixtures.spec.ts",
      "--workers=3",
      ...(updateSnapshots ? ["--update-snapshots"] : []),
    ],
    {
      cwd: rendererRoot,
      env: {
        ...process.env,
        COMPONENT_QUALIFICATION_COMPONENT: artifact.componentType,
        SITESPEC_PATH: resolve(repositoryRoot, fixture.repositoryPath),
      },
      stdio: "inherit",
    },
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
