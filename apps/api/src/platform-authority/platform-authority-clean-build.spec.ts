import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";
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
      execFileSync("pnpm", ["run", "build"], {
        cwd: packageRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${resolve(REPOSITORY_ROOT, "node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const requireFromCleanConsumer = createRequire(
        resolve(temporary, "consumer.cjs"),
      );
      const platformAuthority = requireFromCleanConsumer(
        "@global/contracts/platform-authority",
      ) as Record<string, unknown>;
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
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
