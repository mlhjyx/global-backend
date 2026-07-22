import {
  hasOnlyKeys,
  isDesignAbstractionCode,
  isDesignAbstractionCodeArray,
  isDesignRatioBandArray,
  isFiniteNumber,
  isRecord,
} from "./design-integrity";

export const DESIGN_DNA_SCHEMA_VERSION = "site-builder-design-dna/v1" as const;

export interface DesignDna {
  schemaVersion: typeof DESIGN_DNA_SCHEMA_VERSION;
  id: string;
  name: string;
  ruleIds: string[];
  hierarchy: {
    displayScale: "compact" | "balanced" | "editorial";
    headingContrast: "low" | "medium" | "high";
    maxReadingWidthRem: number;
  };
  spatialRhythm: {
    sectionGapPx: [number, number];
    contentGapPx: [number, number];
    density: "airy" | "balanced" | "dense";
  };
  composition: {
    heroModes: Array<
      "split" | "full_bleed" | "editorial" | "product_stage" | "technical"
    >;
    imageTextRatios: string[];
    alignmentBias: "left" | "center" | "mixed";
  };
  surfaces: {
    cardStyle: "flat" | "bordered" | "elevated" | "tinted";
    borderWeight: "none" | "hairline" | "strong";
    radius: "none" | "subtle" | "soft";
  };
  imagery: {
    preferredSubjects: string[];
    cropModes: Array<"contain" | "cover" | "editorial_crop">;
    backgroundPolicy: "light" | "dark" | "mixed";
    maxGeneratedMediaRatio: number;
  };
  motion: {
    intensity: "none" | "low" | "medium";
    allowed: string[];
    forbidden: string[];
  };
  antiPatterns: string[];
}

function pair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((item) => isFiniteNumber(item) && item >= 0) &&
    value[0] <= value[1]
  );
}

export function validateDesignDna(value: unknown): DesignDna {
  const dna = isRecord(value) ? value : null;
  const hierarchy = dna && isRecord(dna.hierarchy) ? dna.hierarchy : null;
  const rhythm = dna && isRecord(dna.spatialRhythm) ? dna.spatialRhythm : null;
  const composition = dna && isRecord(dna.composition) ? dna.composition : null;
  const surfaces = dna && isRecord(dna.surfaces) ? dna.surfaces : null;
  const imagery = dna && isRecord(dna.imagery) ? dna.imagery : null;
  const motion = dna && isRecord(dna.motion) ? dna.motion : null;
  const valid =
    dna &&
    hasOnlyKeys(dna, [
      "schemaVersion",
      "id",
      "name",
      "ruleIds",
      "hierarchy",
      "spatialRhythm",
      "composition",
      "surfaces",
      "imagery",
      "motion",
      "antiPatterns",
    ]) &&
    dna.schemaVersion === DESIGN_DNA_SCHEMA_VERSION &&
    isDesignAbstractionCode(dna.id) &&
    isDesignAbstractionCode(dna.name) &&
    isDesignAbstractionCodeArray(dna.ruleIds) &&
    dna.ruleIds.length > 0 &&
    hierarchy &&
    ["compact", "balanced", "editorial"].includes(
      String(hierarchy.displayScale),
    ) &&
    ["low", "medium", "high"].includes(String(hierarchy.headingContrast)) &&
    isFiniteNumber(hierarchy.maxReadingWidthRem) &&
    hierarchy.maxReadingWidthRem > 0 &&
    rhythm &&
    pair(rhythm.sectionGapPx) &&
    pair(rhythm.contentGapPx) &&
    ["airy", "balanced", "dense"].includes(String(rhythm.density)) &&
    composition &&
    Array.isArray(composition.heroModes) &&
    composition.heroModes.length > 0 &&
    composition.heroModes.every((mode) =>
      [
        "split",
        "full_bleed",
        "editorial",
        "product_stage",
        "technical",
      ].includes(String(mode)),
    ) &&
    isDesignRatioBandArray(composition.imageTextRatios) &&
    ["left", "center", "mixed"].includes(String(composition.alignmentBias)) &&
    surfaces &&
    ["flat", "bordered", "elevated", "tinted"].includes(
      String(surfaces.cardStyle),
    ) &&
    ["none", "hairline", "strong"].includes(String(surfaces.borderWeight)) &&
    ["none", "subtle", "soft"].includes(String(surfaces.radius)) &&
    imagery &&
    isDesignAbstractionCodeArray(imagery.preferredSubjects) &&
    Array.isArray(imagery.cropModes) &&
    imagery.cropModes.every((mode) =>
      ["contain", "cover", "editorial_crop"].includes(String(mode)),
    ) &&
    ["light", "dark", "mixed"].includes(String(imagery.backgroundPolicy)) &&
    isFiniteNumber(imagery.maxGeneratedMediaRatio) &&
    imagery.maxGeneratedMediaRatio >= 0 &&
    imagery.maxGeneratedMediaRatio <= 1 &&
    motion &&
    ["none", "low", "medium"].includes(String(motion.intensity)) &&
    isDesignAbstractionCodeArray(motion.allowed) &&
    isDesignAbstractionCodeArray(motion.forbidden) &&
    isDesignAbstractionCodeArray(dna.antiPatterns);
  if (!valid) throw new Error("DESIGN_DNA_INVALID");
  return dna as unknown as DesignDna;
}
