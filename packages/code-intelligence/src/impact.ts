import { ContractGraphV1, GraphNodeV1, ImpactReportV1 } from "./schema";

function nodeMap(graph: ContractGraphV1): Map<string, GraphNodeV1> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function codeNeighborhood(
  graph: ContractGraphV1,
  starts: Set<string>,
  maxDepth: number,
): Map<string, number> {
  const nodes = nodeMap(graph);
  const allowedKinds = new Set([
    "source_file",
    "code_symbol",
    "api",
    "event",
    "workflow",
    "activity",
    "data_model",
    "migration",
    "service",
    "test",
    "external_system",
    "ci_job",
    "deployment",
    "dynamic_mechanism",
  ]);
  const allowed = (id: string): boolean => {
    const node = nodes.get(id);
    return (
      node != null &&
      allowedKinds.has(node.kind) &&
      !(node.kind === "source_file" && node.label.startsWith("docs/"))
    );
  };
  const adjacent = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!allowed(edge.from) || !allowed(edge.to)) continue;
    const fromNode = nodes.get(edge.from);
    const fromTestSurface =
      fromNode?.kind === "test" ||
      (fromNode?.kind === "source_file" && fromNode.attributes.test === true);
    if (
      edge.kind === "validates" ||
      (fromTestSurface && edge.kind === "depends_on")
    ) {
      const to = adjacent.get(edge.to) ?? new Set<string>();
      to.add(edge.from);
      adjacent.set(edge.to, to);
    }
    if (fromTestSurface && edge.kind !== "contains") continue;
    const from = adjacent.get(edge.from) ?? new Set<string>();
    from.add(edge.to);
    adjacent.set(edge.from, from);
  }
  const depth = new Map([...starts].map((id) => [id, 0]));
  const queue = [...starts];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = depth.get(current)!;
    if (currentDepth >= maxDepth) continue;
    for (const next of adjacent.get(current) ?? []) {
      if (depth.has(next)) continue;
      depth.set(next, currentDepth + 1);
      queue.push(next);
    }
  }
  return depth;
}

function governanceNeighbors(
  graph: ContractGraphV1,
  capabilityId: string,
  kind: "scenario" | "page",
): string[] {
  const nodes = nodeMap(graph);
  const output = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.from !== capabilityId && edge.to !== capabilityId) continue;
    const other = edge.from === capabilityId ? edge.to : edge.from;
    const node = nodes.get(other);
    if (node?.kind === kind) output.add(node.label);
  }
  return [...output].sort();
}

export function createImpactReport(
  graph: ContractGraphV1,
  changedPaths: string[],
): ImpactReportV1 {
  const nodes = nodeMap(graph);
  const normalized = [...new Set(changedPaths)].sort();
  const starts = new Set(
    normalized.flatMap((changedPath) => {
      const ids = [`file:${changedPath}`, `test:${changedPath}`];
      return ids.filter((id) => graph.nodes.some((node) => node.id === id));
    }),
  );
  // Keep the PR2 report deliberately high precision. PR3 will merge deeper
  // CodeGraph traversal; this static baseline must not flood a business card
  // through shared DI symbols or broad module registries.
  const reached = codeNeighborhood(graph, starts, 2);
  const capabilityIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.attributes.source !== "docs/governance/traceability-matrix.md") {
      continue;
    }
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (from?.kind === "capability" && reached.has(edge.to)) {
      capabilityIds.add(from.id);
    }
    if (to?.kind === "capability" && reached.has(edge.from)) {
      capabilityIds.add(to.id);
    }
  }
  const capabilities = graph.nodes.filter((node) => capabilityIds.has(node.id));
  const codeKinds = new Set([
    "api",
    "event",
    "workflow",
    "activity",
    "data_model",
    "service",
    "code_symbol",
    "deployment",
  ]);
  const codeImpact = graph.nodes
    .filter(
      (node) =>
        codeKinds.has(node.kind) &&
        reached.has(node.id) &&
        !node.id.startsWith("symbol-ref:") &&
        !node.locations.every(
          (location) =>
            /\.(?:spec|test)\.(?:ts|tsx|mts)$/.test(location.path) ||
            /(?:^|\/)scripts\/verify-/.test(location.path),
        ),
    )
    .map((node) => node.id)
    .sort();
  const recommendedTestIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === "validates" && starts.has(edge.to)) {
      const candidate = nodes.get(edge.from);
      if (candidate?.kind === "test") recommendedTestIds.add(candidate.id);
    }
    if (
      edge.attributes.relation === "test-anchor" &&
      (capabilityIds.has(edge.from) || capabilityIds.has(edge.to))
    ) {
      const other = capabilityIds.has(edge.from) ? edge.to : edge.from;
      const candidate = nodes.get(other);
      if (candidate?.kind === "test") recommendedTestIds.add(candidate.id);
      if (candidate?.kind === "source_file") {
        const testId = `test:${candidate.label}`;
        if (nodes.get(testId)?.kind === "test") recommendedTestIds.add(testId);
      }
    }
  }
  const recommendedTests = [...recommendedTestIds]
    .map((id) => nodes.get(id)!.label)
    .sort();
  const relatedUnknowns = graph.diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.nodeId == null || reached.has(diagnostic.nodeId),
    )
    .filter(
      (diagnostic) =>
        diagnostic.code === "UNKNOWN_RELATION" ||
        diagnostic.code === "EXTERNAL_OWNED",
    )
    .map((diagnostic) => diagnostic.message)
    .sort();

  return {
    schemaVersion: "impact-report/v1",
    evidence: graph.evidence,
    changedPaths: normalized,
    businessImpact:
      capabilities.length > 0
        ? capabilities.map((capability) => ({
            capabilityId: capability.label,
            scenarios: governanceNeighbors(graph, capability.id, "scenario"),
            userPaths: governanceNeighbors(graph, capability.id, "page"),
            confidence: "INFERRED",
          }))
        : [
            {
              capabilityId: "UNKNOWN",
              scenarios: [],
              userPaths: [],
              confidence: "UNKNOWN",
            },
          ],
    codeImpact,
    recommendedTests,
    risks: [
      "ContractGraph is derived static evidence; verify current source, tests, and runtime evidence before changing or merging.",
    ],
    unknowns:
      relatedUnknowns.length > 0
        ? relatedUnknowns
        : ["No runtime evidence was evaluated by this static impact report."],
    rollback: [
      `Revert the commit that changes: ${normalized.join(", ") || "UNKNOWN"}`,
    ],
  };
}
