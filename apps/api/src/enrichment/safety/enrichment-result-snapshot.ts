import { EnrichmentSafetyError, safetyInteger } from "./enrichment-safety.contract";
import {
  parseContactQualityBlock,
  type ContactQualityFact,
} from "./enrichment-quality-facts";

/** Versioned persisted snapshot header; version one has no quality facts by construction. */
export interface EnrichmentResultSnapshot {
  readonly version: 1 | 2;
  readonly targetCount: number;
  readonly newCandidatePoints: number;
  readonly contacts: readonly unknown[];
  readonly quality: readonly ContactQualityFact[];
}
export function readEnrichmentResultSnapshot(
  value: unknown,
): EnrichmentResultSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new EnrichmentSafetyError("INVALID_PLAN");
  const version = (value as { version?: unknown }).version;
  const keys =
    version === 2
      ? (["version", "targetCount", "newCandidatePoints", "contacts", "quality"] as const)
      : (["version", "targetCount", "newCandidatePoints", "contacts"] as const);
  const own = Reflect.ownKeys(value);
  if (
    (version !== 1 && version !== 2) ||
    own.length !== keys.length ||
    own.some((key) => typeof key !== "string" || !keys.includes(key as never))
  )
    throw new EnrichmentSafetyError("INVALID_PLAN");
  const row = value as Record<string, unknown>;
  const contacts = row.contacts;
  if (!Array.isArray(contacts) || contacts.length > 10)
    throw new EnrichmentSafetyError("INVALID_PLAN");
  return Object.freeze({
    version: version as 1 | 2,
    targetCount: safetyInteger(row.targetCount, 0, 10),
    newCandidatePoints: safetyInteger(row.newCandidatePoints, 0, 10),
    contacts,
    quality: version === 2 ? parseContactQualityBlock(row.quality) : [],
  });
}
