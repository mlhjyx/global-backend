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
const SUPPORTED_EXTRACTORS = new Set([
  "typescript.nestjs",
  "typescript.temporal",
  "typescript.temporal-worker",
  "typescript.temporal-client",
  "typescript.temporal-schedule",
  "typescript.outbox",
  "typescript.prisma",
  "typescript.ai-route",
  "typescript.tool-broker",
  "typescript.provider-registry",
  "workspace.packages",
  "infrastructure",
]);

const GENERIC_DYNAMIC_SURFACES = [
  {
    detector: "temporal-proxy",
    matcher: /\bproxyActivities\s*</,
  },
  {
    detector: "temporal-worker",
    matcher: /\bWorker\.create\s*\(/,
  },
  {
    detector: "temporal-client",
    matcher: /\bworkflow\.(?:start|execute)\s*\(/,
  },
  {
    detector: "temporal-schedule",
    matcher: /\bschedule\.create\s*\(/,
  },
  {
    detector: "outbox-string-dispatch",
    matcher: /\beventType\s*:/,
  },
  {
    detector: "semantic-function-registry",
    matcher:
      /\b(?:[A-Za-z_$][A-Za-z0-9_$]*)?(?:registry|handlers?|dispatchers?|routes?|providers?|adapters?|workflows?|activities|tools)\.set\s*\(/i,
  },
  {
    detector: "computed-function-dispatch",
    matcher:
      /\b(?:[A-Za-z_$][A-Za-z0-9_$]*)?(?:registry|handlers?|dispatchers?|routes?|providers?|adapters?|workflows?|activities|tools)(?:\.get\s*\([^)]*\)|\s*\[[^\]]+\])\s*\(/i,
  },
  {
    detector: "dynamic-import",
    matcher: /\bimport\s*\(\s*(?!["'`])/,
  },
  {
    detector: "reflective-dispatch",
    matcher: /\bReflect\.(?:get|apply|construct)\s*\(/,
  },
] as const;

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
    if (
      mechanism.status === "EXTRACTOR" &&
      (!mechanism.extractor || !SUPPORTED_EXTRACTORS.has(mechanism.extractor))
    ) {
      builder.addDiagnostic({
        code: "DYNAMIC_MECHANISM_EXTRACTOR_MISSING",
        severity: "error",
        message: `${mechanism.id} declares unsupported extractor ${mechanism.extractor ?? "null"}`,
        nodeId: mechanismNode,
      });
    }
    if (mechanism.status === "EXTRACTOR" && matchedLocations === 0) {
      builder.addDiagnostic({
        code: "DYNAMIC_MECHANISM_UNOBSERVED",
        severity: "error",
        message: `${mechanism.id} declares an extractor but no registered source pattern was observed`,
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

  const registeredPatterns = registry.mechanisms.flatMap((mechanism) =>
    mechanism.patterns.map((pattern) => new RegExp(pattern)),
  );
  for (const observation of observations) {
    if (
      /\.(?:spec|test)\.(?:ts|tsx|mts)$/.test(observation.path) ||
      /(?:^|\/)fixtures?\//.test(observation.path) ||
      /(?:^|\/)scripts\/verify-[^/]+\.(?:ts|mts)$/.test(observation.path)
    ) {
      continue;
    }
    const lines = observation.text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const surface of GENERIC_DYNAMIC_SURFACES) {
        if (!surface.matcher.test(line)) continue;
        const claimedByPattern = registeredPatterns.some((pattern) =>
          pattern.test(line),
        );
        const nearby = lines
          .slice(Math.max(0, index - 2), Math.min(lines.length, index + 3))
          .join("\n");
        const claimedByMarker = [...nearby.matchAll(explicitMarker)].some(
          (match) => knownIds.has(match[1]),
        );
        if (claimedByPattern || claimedByMarker) continue;
        builder.addDiagnostic({
          code: "UNCLAIMED_DYNAMIC_MECHANISM",
          severity: "error",
          message: `${surface.detector} dynamic surface is not covered by the registry`,
          location: { path: observation.path, line: index + 1 },
          attributes: { detector: surface.detector },
        });
      }
    }
  }

  return coverage.sort((left, right) =>
    left.mechanismId.localeCompare(right.mechanismId),
  );
}
