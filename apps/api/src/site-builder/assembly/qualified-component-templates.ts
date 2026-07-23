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
      return readdirSync(path.join(candidate, "fixtures")).length > 0;
    } catch {
      return false;
    }
  });
  if (!found) {
    throw new Error("QUALIFIED_COMPONENT_FIXTURES_UNAVAILABLE");
  }
  return found;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Loads only the checked-in M1-e-A qualification fixtures. The directory and
 * component allowlist are fixed by code; neither tenant nor model chooses a path.
 */
export function loadQualifiedComponentTemplates(
  cwd = process.cwd(),
): QualifiedComponentTemplateRepository {
  const directory = path.join(
    rendererRoot(cwd),
    "fixtures",
    "component-qualification",
  );
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
          throw new Error(`QUALIFIED_COMPONENT_FIXTURE_DUPLICATE: ${type}`);
        }
        templates.set(type, structuredClone(block.props));
      }
    }
  }
  for (const type of CONTROLLED_ASSEMBLY_COMPONENT_TYPES) {
    if (!templates.has(type)) {
      throw new Error(`QUALIFIED_COMPONENT_FIXTURE_MISSING: ${type}`);
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
