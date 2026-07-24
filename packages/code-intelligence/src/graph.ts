import {
  ContractGraphV1,
  EvidenceRefV1,
  GraphDiagnosticV1,
  GraphEdgeKind,
  GraphEdgeV1,
  GraphNodeKind,
  GraphNodeV1,
  SourceLocationV1,
} from "./schema";
import { sha256, stableJson, uniqueSorted } from "./utils";

function mergeAttributes(
  left: GraphNodeV1["attributes"],
  right: GraphNodeV1["attributes"],
): GraphNodeV1["attributes"] {
  const output = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = output[key];
    if (Array.isArray(existing) || Array.isArray(value)) {
      const values = [
        ...(Array.isArray(existing)
          ? existing
          : existing == null
            ? []
            : [String(existing)]),
        ...(Array.isArray(value)
          ? value
          : value == null
            ? []
            : [String(value)]),
      ];
      output[key] = uniqueSorted(values);
    } else if (existing == null || existing === value) {
      output[key] = value;
    }
  }
  return output;
}

function locationKey(location: SourceLocationV1): string {
  return `${location.path}:${location.line ?? 0}:${location.column ?? 0}`;
}

function mergeLocations(
  left: SourceLocationV1[],
  right: SourceLocationV1[],
): SourceLocationV1[] {
  const byKey = new Map<string, SourceLocationV1>();
  for (const location of [...left, ...right])
    byKey.set(locationKey(location), location);
  return [...byKey.values()].sort((a, b) =>
    locationKey(a).localeCompare(locationKey(b)),
  );
}

export class GraphBuilder {
  private readonly nodes = new Map<string, GraphNodeV1>();
  private readonly edges = new Map<string, GraphEdgeV1>();
  private readonly diagnostics: GraphDiagnosticV1[] = [];

  addNode(input: {
    id: string;
    kind: GraphNodeKind;
    label: string;
    attributes?: GraphNodeV1["attributes"];
    location?: SourceLocationV1;
  }): string {
    const candidate: GraphNodeV1 = {
      id: input.id,
      kind: input.kind,
      label: input.label,
      attributes: input.attributes ?? {},
      locations: input.location ? [input.location] : [],
    };
    const existing = this.nodes.get(input.id);
    if (!existing) {
      this.nodes.set(input.id, candidate);
      return input.id;
    }
    if (
      existing.kind !== candidate.kind ||
      existing.label !== candidate.label
    ) {
      this.addDiagnostic({
        code: "DUPLICATE_NODE_CONFLICT",
        severity: "error",
        message: `node ${input.id} was emitted with conflicting identity`,
        nodeId: input.id,
        location: input.location,
      });
      return input.id;
    }
    existing.attributes = mergeAttributes(
      existing.attributes,
      candidate.attributes,
    );
    existing.locations = mergeLocations(
      existing.locations,
      candidate.locations,
    );
    return input.id;
  }

  addEdge(input: {
    kind: GraphEdgeKind;
    from: string;
    to: string;
    attributes?: GraphEdgeV1["attributes"];
    location?: SourceLocationV1;
  }): string {
    const identity = `${input.kind}\u0000${input.from}\u0000${input.to}\u0000${stableJson(input.attributes ?? {})}`;
    const id = `edge:${sha256(identity).slice(0, 24)}`;
    const existing = this.edges.get(id);
    if (existing) {
      if (input.location)
        existing.locations = mergeLocations(existing.locations, [
          input.location,
        ]);
      return id;
    }
    this.edges.set(id, {
      id,
      kind: input.kind,
      from: input.from,
      to: input.to,
      attributes: input.attributes ?? {},
      locations: input.location ? [input.location] : [],
    });
    return id;
  }

  addDiagnostic(diagnostic: GraphDiagnosticV1): void {
    this.diagnostics.push(diagnostic);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  snapshotNodes(): GraphNodeV1[] {
    return [...this.nodes.values()].map((node) => ({
      ...node,
      attributes: { ...node.attributes },
      locations: [...node.locations],
    }));
  }

  snapshotEdges(): GraphEdgeV1[] {
    return [...this.edges.values()].map((edge) => ({
      ...edge,
      attributes: { ...edge.attributes },
      locations: [...edge.locations],
    }));
  }

  finalize(evidence: EvidenceRefV1): ContractGraphV1 {
    for (const edge of this.edges.values()) {
      if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) {
        this.addDiagnostic({
          code: "BROKEN_EDGE",
          severity: "error",
          message: `edge ${edge.id} references a missing endpoint`,
          attributes: { from: edge.from, to: edge.to },
          location: edge.locations[0],
        });
      }
    }
    return {
      schemaVersion: "contract-graph/v1",
      evidence,
      nodes: [...this.nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
      edges: [...this.edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
      diagnostics: [...this.diagnostics].sort((a, b) =>
        `${a.code}:${a.location?.path ?? ""}:${a.location?.line ?? 0}:${a.message}`.localeCompare(
          `${b.code}:${b.location?.path ?? ""}:${b.location?.line ?? 0}:${b.message}`,
        ),
      ),
    };
  }
}
