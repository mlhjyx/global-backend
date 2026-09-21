import "reflect-metadata";
import { expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { RequestMethod } from "@nestjs/common";
import { PlatformRevocationHttpController } from "./platform-revocation-http.controller";
import { PlatformFenceAckJwksController } from "./platform-fence-ack-jwks.controller";
import {
  RECOVERY_CONTROL_PLANE_METADATA,
  PLATFORM_REVOCATION_RECOVERY,
} from "../runtime/recovery-control-plane.decorator";
import { READ_ONLY_CONTROL_PLANE_METADATA } from "../runtime/read-only-control-plane.decorator";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : path.endsWith(".ts") && !/\.(spec|test-fixture)\.ts$/.test(path)
        ? [path]
        : [];
  });
}
it("has exactly one mutation recovery classification, on the signed revocation POST only", () => {
  const root = resolve(import.meta.dirname, "..");
  expect(
    sources(root)
      .filter((path) =>
        readFileSync(path, "utf8").includes("@PlatformRevocationRecovery()"),
      )
      .map((path) => relative(root, path)),
  ).toEqual(["platform-authority/platform-revocation-http.controller.ts"]);
  const handler = PlatformRevocationHttpController.prototype.receive;
  expect(Reflect.getMetadata(RECOVERY_CONTROL_PLANE_METADATA, handler)).toBe(
    PLATFORM_REVOCATION_RECOVERY,
  );
  expect(
    Reflect.getMetadata(
      RECOVERY_CONTROL_PLANE_METADATA,
      PlatformRevocationHttpController,
    ),
  ).toBeUndefined();
  expect(
    Reflect.getMetadata(READ_ONLY_CONTROL_PLANE_METADATA, handler),
  ).toBeUndefined();
  expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(
    RequestMethod.POST,
  );
  expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe("revocations");
});
it("public ACK projection has only its exact GET and does not share recovery/write classification", () => {
  const methods = Object.getOwnPropertyNames(
    PlatformFenceAckJwksController.prototype,
  ).filter((name) => name !== "constructor");
  expect(methods).toEqual(["keys"]);
  expect(
    Reflect.getMetadata(
      METHOD_METADATA,
      PlatformFenceAckJwksController.prototype.keys,
    ),
  ).toBe(RequestMethod.GET);
  expect(
    Reflect.getMetadata(
      PATH_METADATA,
      PlatformFenceAckJwksController.prototype.keys,
    ),
  ).toBe("fence-ack-jwks");
  expect(
    Reflect.getMetadata(
      RECOVERY_CONTROL_PLANE_METADATA,
      PlatformFenceAckJwksController.prototype.keys,
    ),
  ).toBeUndefined();
});
it("production main installs the same bounded parser before guards/listen and root imports the module", () => {
  const main = readFileSync(resolve(import.meta.dirname, "../main.ts"), "utf8");
  expect(main).toContain("installPlatformRevocationHttpBoundary(app)");
  expect(
    main.indexOf("installPlatformRevocationHttpBoundary(app)"),
  ).toBeLessThan(main.indexOf("app.listen("));
  expect(
    readFileSync(resolve(import.meta.dirname, "../app.module.ts"), "utf8"),
  ).toContain("    PlatformRevocationHttpModule,");
});
