import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROLLED_ASSEMBLY_COMPONENT_TYPES } from "./component-assembly-adapters";
import { loadQualifiedComponentTemplates } from "./qualified-component-templates";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function catalogRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "component-catalog-"));
  temporaryRoots.push(root);
  await mkdir(
    path.join(
      root,
      "apps",
      "site-renderer",
      "product-assets",
      "component-catalog-v1",
    ),
    { recursive: true },
  );
  return root;
}

describe("loadQualifiedComponentTemplates", () => {
  it("loads every controlled component from the versioned product catalog", () => {
    const repository = loadQualifiedComponentTemplates(
      path.resolve(process.cwd(), "../.."),
    );
    for (const componentType of CONTROLLED_ASSEMBLY_COMPONENT_TYPES) {
      expect(repository.get(componentType)).toEqual(expect.any(Object));
    }
  });

  it("rejects a renamed fixture directory without the product catalog manifest", async () => {
    const root = await catalogRoot();
    await writeFile(
      path.join(
        root,
        "apps/site-renderer/product-assets/component-catalog-v1/hero-banner-spec.json",
      ),
      JSON.stringify({ pages: [] }),
    );

    expect(() => loadQualifiedComponentTemplates(root)).toThrow(
      "QUALIFIED_COMPONENT_CATALOG_MANIFEST_UNAVAILABLE",
    );
  });

  it("rejects an unversioned or untrusted product catalog manifest", async () => {
    const root = await catalogRoot();
    await writeFile(
      path.join(
        root,
        "apps/site-renderer/product-assets/component-catalog-v1/catalog-manifest.json",
      ),
      JSON.stringify({ schemaVersion: "fixture/v1" }),
    );

    expect(() => loadQualifiedComponentTemplates(root)).toThrow(
      "QUALIFIED_COMPONENT_CATALOG_MANIFEST_INVALID",
    );
  });
});
