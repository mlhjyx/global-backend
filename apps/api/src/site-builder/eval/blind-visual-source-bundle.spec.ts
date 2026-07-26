import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

const RUNNER_SCRIPTS = [
  "apps/api/scripts/evaluate-site-builder-blind-visual-calibration.mts",
  "apps/api/scripts/evaluate-site-builder-blind-visual-calibration-campaign.mts",
] as const;

describe("blind visual source bundle", () => {
  it.each(RUNNER_SCRIPTS)(
    "%s fingerprints the trusted model identity resolver",
    async (scriptPath) => {
      const source = await readFile(
        path.join(repositoryRoot, scriptPath),
        "utf8",
      );
      expect(source).toContain(
        '"apps/api/src/model-gateway/model-identity.ts"',
      );
    },
  );
});
