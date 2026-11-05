import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(__dirname, "../../../..");

describe("compiled platform authority runtime boundary", () => {
  it("keeps the root contracts graph free of platform authority while the explicit subpath loads it", () => {
    const observation = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "-e",
          `
            const { createRequire } = require("node:module");
            const { resolve, sep } = require("node:path");
            const requireFromApi = createRequire(resolve(process.cwd(), "apps/api/package.json"));
            const marker = ["platform-authority", "canonical-request.js"].join(sep);
            const root = requireFromApi("@global/contracts");
            const rootLoadedCanonical = Object.keys(require.cache).some((path) => path.endsWith(marker));
            let subpath;
            let subpathError = null;
            try {
              subpath = requireFromApi("@global/contracts/platform-authority");
            } catch (error) {
              subpathError = error && typeof error === "object" && "code" in error ? error.code : "UNKNOWN";
            }
            const subpathLoadedCanonical = Object.keys(require.cache).some((path) => path.endsWith(marker));
            process.stdout.write(JSON.stringify({
              rootHasCanonical: Object.hasOwn(root, "canonicalizePlatformAuthorityRequestBodyV1"),
              rootLoadedCanonical,
              subpathCanonicalType: typeof subpath?.canonicalizePlatformAuthorityRequestBodyV1,
              subpathError,
              subpathLoadedCanonical,
            }));
          `,
        ],
        {
          cwd: REPOSITORY_ROOT,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    ) as Record<string, unknown>;

    expect(observation).toEqual({
      rootHasCanonical: false,
      rootLoadedCanonical: false,
      subpathCanonicalType: "function",
      subpathError: null,
      subpathLoadedCanonical: true,
    });
  });

  it("loads the exact embedded reviewed-v3 policy through the compiled API module", async () => {
    const runtime = (await import(
      resolve(
        REPOSITORY_ROOT,
        "apps/api/dist/platform-authority/platform-authority-policy-asset.js",
      )
    )) as {
      loadVerifiedPlatformAuthorityPolicyAsset(): {
        byteLength: number;
        sha256: string;
      };
    };

    expect(runtime.loadVerifiedPlatformAuthorityPolicyAsset()).toMatchObject({
      byteLength: 15996,
      sha256:
        "f521671e2c4058025b99b9a6e646a1534645a35b6191288516583704cfa2dbd4",
    });
    const { createHash } = await import("node:crypto");
    const { readFile } = await import("node:fs/promises");
    const emitted = await readFile(
      resolve(
        REPOSITORY_ROOT,
        "apps/api/dist/platform-authority/platform-authority-policy-matrix-v3.json",
      ),
    );
    expect(emitted.byteLength).toBe(15996);
    expect(createHash("sha256").update(emitted).digest("hex")).toBe(
      "f521671e2c4058025b99b9a6e646a1534645a35b6191288516583704cfa2dbd4",
    );
  });
});
