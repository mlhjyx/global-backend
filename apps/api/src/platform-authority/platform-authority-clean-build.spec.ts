import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = resolve(__dirname, "../../../..");
const SOURCE_PACKAGE = resolve(REPOSITORY_ROOT, "packages/contracts");

describe("clean @global/contracts platform-authority build", () => {
  it("emits and loads the isolated subpath from an initially absent dist", async () => {
    const temporary = await mkdtemp(
      resolve(tmpdir(), "global-contracts-clean-build-"),
    );
    try {
      const packageRoot = resolve(temporary, "packages/contracts");
      await mkdir(packageRoot, { recursive: true });
      await cp(resolve(SOURCE_PACKAGE, "src"), resolve(packageRoot, "src"), {
        recursive: true,
      });
      await cp(
        resolve(SOURCE_PACKAGE, "package.json"),
        resolve(packageRoot, "package.json"),
      );
      await cp(
        resolve(SOURCE_PACKAGE, "tsconfig.json"),
        resolve(packageRoot, "tsconfig.json"),
      );
      await cp(
        resolve(SOURCE_PACKAGE, "tsconfig.platform-authority.json"),
        resolve(packageRoot, "tsconfig.platform-authority.json"),
      );
      await cp(
        resolve(REPOSITORY_ROOT, "tsconfig.base.json"),
        resolve(temporary, "tsconfig.base.json"),
      );
      await symlink(
        resolve(SOURCE_PACKAGE, "node_modules"),
        resolve(packageRoot, "node_modules"),
        "dir",
      );
      await mkdir(resolve(temporary, "node_modules/@types"), {
        recursive: true,
      });
      await mkdir(resolve(temporary, "node_modules/@global"), {
        recursive: true,
      });
      await symlink(
        resolve(REPOSITORY_ROOT, "node_modules/@types/node"),
        resolve(temporary, "node_modules/@types/node"),
        "dir",
      );
      await symlink(
        packageRoot,
        resolve(temporary, "node_modules/@global/contracts"),
        "dir",
      );

      await expect(lstat(resolve(packageRoot, "dist"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const build = spawnSync("pnpm", ["run", "build"], {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${resolve(REPOSITORY_ROOT, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      expect(
        build.status,
        [build.stdout, build.stderr].filter(Boolean).join("\n"),
      ).toBe(0);

      const requireFromCleanConsumer = createRequire(
        resolve(temporary, "consumer.cjs"),
      );
      const platformAuthority = requireFromCleanConsumer(
        "@global/contracts/platform-authority",
      ) as {
        PLATFORM_AUTHORITY_CANONICAL_REFERENCE_SCHEMA_V1: unknown;
        canonicalizePlatformAuthorityRequestBodyV1(input: unknown): {
          canonicalBodyUtf8: string;
        };
        buildPlatformAuthorityRequestHmacPreimageV1: unknown;
      };
      expect(
        platformAuthority.canonicalizePlatformAuthorityRequestBodyV1,
      ).toBeTypeOf("function");
      expect(
        platformAuthority.buildPlatformAuthorityRequestHmacPreimageV1,
      ).toBeTypeOf("function");
      expect(
        await lstat(
          resolve(
            packageRoot,
            "dist/platform-authority/canonical-request.d.ts",
          ),
        ),
      ).toMatchObject({ size: expect.any(Number) });

      const rawBody = Buffer.from(
        `{"amount_microusd":"1","count":"0","digest_sha256":"${"a".repeat(64)}","label":"fresh-build","numeric_date":"0","padding":"","schema_version":"platform-authority-canonical-reference/v1","workflow_run_id":"11111111-1111-4111-8111-111111111111"}`,
        "utf8",
      );
      const foreignShared = runInNewContext(
        `new SharedArrayBuffer(${rawBody.byteLength})`,
      ) as SharedArrayBuffer;
      const sharedView = new Uint8Array(foreignShared);
      sharedView.set(rawBody);
      expect(() =>
        platformAuthority.canonicalizePlatformAuthorityRequestBodyV1({
          contentType: "application/json",
          rawBody: sharedView,
          schema:
            platformAuthority.PLATFORM_AUTHORITY_CANONICAL_REFERENCE_SCHEMA_V1,
        }),
      ).toThrow("PLATFORM_AUTHORITY_CANONICAL_REQUEST_INVALID");

      const foreignUnshared = runInNewContext(
        `new ArrayBuffer(${rawBody.byteLength})`,
      ) as ArrayBuffer;
      const unsharedView = new Uint8Array(foreignUnshared);
      unsharedView.set(rawBody);
      expect(
        platformAuthority.canonicalizePlatformAuthorityRequestBodyV1({
          contentType: "application/json",
          rawBody: unsharedView,
          schema:
            platformAuthority.PLATFORM_AUTHORITY_CANONICAL_REFERENCE_SCHEMA_V1,
        }).canonicalBodyUtf8,
      ).toBe(rawBody.toString("utf8"));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }, 30_000);
});
