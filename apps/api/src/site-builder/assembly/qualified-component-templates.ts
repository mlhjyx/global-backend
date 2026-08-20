import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { SiteSpecComponentType } from "@global/contracts";
import { CONTROLLED_ASSEMBLY_COMPONENT_TYPES } from "./component-assembly-adapters";
import type { QualifiedComponentTemplateRepository } from "./copy-slot-derivation";

function rendererRoot(cwd = process.cwd()): string {
  const candidates = [
    path.join(cwd, "apps", "site-renderer"),
    path.join(cwd, "..", "site-renderer"),
  ];
  const found = candidates.find((candidate) => {
    try {
      return (
        readdirSync(
          path.join(candidate, "product-assets", "component-catalog-v1"),
        ).length > 0
      );
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error("QUALIFIED_COMPONENT_CATALOG_UNAVAILABLE");
  }
  return found;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function assertProductCatalogManifest(directory: string): void {
  let raw: string;
  try {
    raw = readFileSync(path.join(directory, "catalog-manifest.json"), "utf8");
  } catch {
    throw new Error("QUALIFIED_COMPONENT_CATALOG_MANIFEST_UNAVAILABLE");
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("QUALIFIED_COMPONENT_CATALOG_MANIFEST_INVALID");
  }
  if (
    !record(manifest) ||
    !exactKeys(manifest, [
      "schemaVersion",
      "catalogVersion",
      "templateFormat",
      "provenance",
      "controlledComponentTypes",
    ]) ||
    manifest.schemaVersion !== "site-renderer-component-catalog/v1" ||
    typeof manifest.catalogVersion !== "string" ||
    !/^\d{4}-\d{2}-\d{2}\.\d+$/u.test(manifest.catalogVersion) ||
    manifest.templateFormat !== "site-spec-component-props/v1" ||
    !record(manifest.provenance) ||
    !exactKeys(manifest.provenance, ["kind", "registry", "owner"]) ||
    manifest.provenance.kind !== "qualified-component-promotion" ||
    manifest.provenance.registry !==
      "@global/contracts/component-qualification" ||
    manifest.provenance.owner !== "site-builder" ||
    !Array.isArray(manifest.controlledComponentTypes) ||
    manifest.controlledComponentTypes.length !==
      CONTROLLED_ASSEMBLY_COMPONENT_TYPES.length ||
    manifest.controlledComponentTypes.some(
      (type, index) => type !== CONTROLLED_ASSEMBLY_COMPONENT_TYPES[index],
    )
  ) {
    throw new Error("QUALIFIED_COMPONENT_CATALOG_MANIFEST_INVALID");
  }
}

/**
 * Loads the versioned, checked-in component product catalog. Qualification
 * evidence may test these bytes, but the managed Worker never depends on a
 * test fixture directory. Neither tenant nor model chooses a path.
 */
export function loadQualifiedComponentTemplates(
  cwd = process.cwd(),
): QualifiedComponentTemplateRepository {
  const directory = path.join(
    rendererRoot(cwd),
    "product-assets",
    "component-catalog-v1",
  );
  assertProductCatalogManifest(directory);
  const templates = new Map<SiteSpecComponentType, Record<string, unknown>>();
  for (const filename of readdirSync(directory).sort()) {
    if (!filename.endsWith("-spec.json")) continue;
    const document = JSON.parse(
      readFileSync(path.join(directory, filename), "utf8"),
    ) as unknown;
    if (!record(document) || !Array.isArray(document.pages)) continue;
    for (const page of document.pages) {
      if (
        !record(page) ||
        !record(page.puck) ||
        !Array.isArray(page.puck.content)
      ) {
        continue;
      }
      for (const block of page.puck.content) {
        if (
          !record(block) ||
          typeof block.type !== "string" ||
          !record(block.props) ||
          !CONTROLLED_ASSEMBLY_COMPONENT_TYPES.includes(
            block.type as (typeof CONTROLLED_ASSEMBLY_COMPONENT_TYPES)[number],
          )
        ) {
          continue;
        }
        const type = block.type as SiteSpecComponentType;
        if (templates.has(type)) {
          throw new Error(`QUALIFIED_COMPONENT_CATALOG_DUPLICATE: ${type}`);
        }
        templates.set(type, structuredClone(block.props));
      }
    }
  }
  for (const type of CONTROLLED_ASSEMBLY_COMPONENT_TYPES) {
    if (!templates.has(type)) {
      throw new Error(`QUALIFIED_COMPONENT_CATALOG_MISSING: ${type}`);
    }
  }
  return Object.freeze({
    get(componentType: SiteSpecComponentType): Record<string, unknown> {
      const template = templates.get(componentType);
      if (!template) {
        throw new Error(
          `CONTROLLED_ASSEMBLY_ADAPTER_TEMPLATE_MISSING: ${componentType}`,
        );
      }
      return structuredClone(template);
    },
  });
}
