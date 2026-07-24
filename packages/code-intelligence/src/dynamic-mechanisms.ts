import registryJson from "../dynamic-mechanisms.json";
import { GraphBuilder } from "./graph";
import { CoverageItemV1, SourceLocationV1 } from "./schema";
import { lineOf } from "./utils";

interface RegistryMechanism {
  id: string;
  category: string;
  status: "EXTRACTOR" | "DETERMINISTIC_TEST" | "TEMPORARY_EXCEPTION";
  extractor: string | null;
  accountableRole: string;
  assignee: string;
  patterns: string[];
  expiresAt?: string;
}

interface DynamicMechanismRegistry {
  schemaVersion: "dynamic-mechanism-registry/v1";
  mechanisms: RegistryMechanism[];
}

const registry = registryJson as DynamicMechanismRegistry;

export interface MechanismObservation {
  path: string;
  text: string;
}

export function evaluateDynamicMechanisms(
  builder: GraphBuilder,
  observations: MechanismObservation[],
  today: string,
): CoverageItemV1[] {
  const knownIds = new Set(
    registry.mechanisms.map((mechanism) => mechanism.id),
  );
  const coverage: CoverageItemV1[] = [];

  for (const mechanism of registry.mechanisms) {
    let matchedLocations = 0;
    const mechanismNode = builder.addNode({
      id: `dynamic:${mechanism.id}`,
      kind: "dynamic_mechanism",
      label: mechanism.id,
      attributes: {
        category: mechanism.category,
        status: mechanism.status,
        extractor: mechanism.extractor,
        accountableRole: mechanism.accountableRole,
        assignee: mechanism.assignee,
        expiresAt: mechanism.expiresAt ?? null,
      },
    });
    for (const observation of observations) {
      for (const pattern of mechanism.patterns) {
        const matcher = new RegExp(pattern, "gm");
        for (const match of observation.text.matchAll(matcher)) {
          matchedLocations += 1;
          const location: SourceLocationV1 = {
            path: observation.path,
            line: lineOf(observation.text, match.index ?? 0),
          };
          const fileNode = builder.addNode({
            id: `file:${observation.path}`,
            kind: "source_file",
            label: observation.path,
            location,
          });
          builder.addEdge({
            kind: "implements",
            from: fileNode,
            to: mechanismNode,
            location,
          });
        }
      }
    }
    if (
      mechanism.status === "TEMPORARY_EXCEPTION" &&
      mechanism.expiresAt &&
      mechanism.expiresAt < today
    ) {
      builder.addDiagnostic({
        code: "DYNAMIC_MECHANISM_EXCEPTION_EXPIRED",
        severity: "error",
        message: `${mechanism.id} temporary exception expired at ${mechanism.expiresAt}`,
        nodeId: mechanismNode,
      });
    }
    if (mechanism.assignee === "UNASSIGNED") {
      builder.addDiagnostic({
        code: "DYNAMIC_MECHANISM_OWNER_UNASSIGNED",
        severity: "info",
        message: `${mechanism.id} has responsibility role ${mechanism.accountableRole} but no recorded person`,
        nodeId: mechanismNode,
      });
    }
    coverage.push({
      mechanismId: mechanism.id,
      category: mechanism.category,
      status: mechanism.status,
      accountableRole: mechanism.accountableRole,
      assignee: mechanism.assignee,
      matchedLocations,
      extractor: mechanism.extractor,
      expiresAt: mechanism.expiresAt ?? null,
    });
  }

  const explicitMarker = /@dynamic-mechanism\s+([a-z0-9][a-z0-9._-]*)/g;
  for (const observation of observations) {
    for (const match of observation.text.matchAll(explicitMarker)) {
      const mechanismId = match[1];
      if (knownIds.has(mechanismId)) continue;
      builder.addDiagnostic({
        code: "UNCLAIMED_DYNAMIC_MECHANISM",
        severity: "error",
        message: `dynamic mechanism ${mechanismId} is not registered`,
        location: {
          path: observation.path,
          line: lineOf(observation.text, match.index ?? 0),
        },
        attributes: { mechanismId },
      });
    }
  }

  return coverage.sort((left, right) =>
    left.mechanismId.localeCompare(right.mechanismId),
  );
}
