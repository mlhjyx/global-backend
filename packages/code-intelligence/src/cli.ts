#!/usr/bin/env node
import path from "node:path";
import {
  buildContractGraph,
  criticalDiagnostics,
  graphFreshnessDiagnostics,
  readGraph,
  writeDerivedArtifacts,
} from "./scan";
import { ContractGraphV1, GraphNodeV1 } from "./schema";
import { sha256, stableJson } from "./utils";

interface ParsedArguments {
  command: string;
  repositoryRoot: string;
  terms: string[];
}

function parseArguments(argv: string[]): ParsedArguments {
  const command = argv[0] ?? "help";
  const terms: string[] = [];
  let repositoryRoot = process.cwd();
  for (let index = 1; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo") {
      const target = argv[index + 1];
      if (!target) throw new Error("--repo requires a path");
      repositoryRoot = path.resolve(process.cwd(), target);
      index += 1;
    } else {
      terms.push(value);
    }
  }
  return { command, repositoryRoot, terms };
}

function printHelp(): void {
  console.log(`global-code-intelligence

Commands:
  scan [--repo PATH]          Build worktree-bound derived graph artifacts
  check [--repo PATH]         Build twice and enforce deterministic/error gates
  query TERM [--repo PATH]    Query a fresh graph; stale/wrong-worktree graphs fail
  status [--repo PATH]        Show evidence, coverage and freshness

Derived artifacts are written only under .code-intelligence/ and are never truth.`);
}

function searchable(node: GraphNodeV1): string {
  return [
    node.id,
    node.label,
    ...Object.values(node.attributes).flatMap((value) =>
      Array.isArray(value) ? value : value == null ? [] : [String(value)],
    ),
  ]
    .join("\n")
    .toLowerCase();
}

function queryGraph(graph: ContractGraphV1, term: string): unknown {
  const normalized = term.toLowerCase();
  const matchedNodes = graph.nodes
    .filter((node) => searchable(node).includes(normalized))
    .slice(0, 50);
  const matchedNodeIds = new Set(matchedNodes.map((node) => node.id));
  const edges = graph.edges
    .filter(
      (edge) => matchedNodeIds.has(edge.from) || matchedNodeIds.has(edge.to),
    )
    .slice(0, 200);
  const includedNodeIds = new Set(matchedNodeIds);
  for (const edge of edges) {
    includedNodeIds.add(edge.from);
    includedNodeIds.add(edge.to);
  }
  const nodes = graph.nodes
    .filter((node) => includedNodeIds.has(node.id))
    .slice(0, 250);
  return {
    evidence: graph.evidence,
    query: term,
    matchedNodeIds: [...matchedNodeIds].sort(),
    truncated: {
      matches: matchedNodes.length === 50,
      nodes: nodes.length === 250,
      edges: edges.length === 200,
    },
    nodes,
    edges,
  };
}

async function requireFreshGraph(
  repositoryRoot: string,
): Promise<ContractGraphV1> {
  const graph = await readGraph(repositoryRoot);
  const diagnostics = await graphFreshnessDiagnostics(repositoryRoot, graph);
  if (diagnostics.length > 0) {
    console.error(stableJson({ ok: false, diagnostics }));
    throw new Error("refusing to query a stale or wrong-worktree graph");
  }
  return graph;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  switch (args.command) {
    case "scan": {
      const result = await buildContractGraph(args.repositoryRoot);
      const paths = await writeDerivedArtifacts(args.repositoryRoot, result);
      console.log(
        stableJson({
          ok: criticalDiagnostics(result.graph.diagnostics).length === 0,
          evidence: result.graph.evidence,
          totals: result.coverage.totals,
          paths,
        }),
      );
      if (criticalDiagnostics(result.graph.diagnostics).length > 0) {
        process.exitCode = 1;
      }
      return;
    }
    case "check": {
      const first = await buildContractGraph(args.repositoryRoot);
      const second = await buildContractGraph(args.repositoryRoot);
      const firstBody = stableJson(first);
      const secondBody = stableJson(second);
      const deterministic = firstBody === secondBody;
      const errors = criticalDiagnostics(first.graph.diagnostics);
      console.log(
        stableJson({
          ok: deterministic && errors.length === 0,
          deterministic,
          digest: sha256(firstBody),
          evidence: first.graph.evidence,
          totals: first.coverage.totals,
          errors,
        }),
      );
      if (!deterministic || errors.length > 0) process.exitCode = 1;
      return;
    }
    case "query": {
      const term = args.terms.join(" ").trim();
      if (!term) throw new Error("query requires a term");
      const graph = await requireFreshGraph(args.repositoryRoot);
      console.log(stableJson(queryGraph(graph, term)));
      return;
    }
    case "status": {
      const graph = await readGraph(args.repositoryRoot);
      const freshness = await graphFreshnessDiagnostics(
        args.repositoryRoot,
        graph,
      );
      console.log(
        stableJson({
          ok: freshness.length === 0,
          evidence: graph.evidence,
          totals: {
            nodes: graph.nodes.length,
            edges: graph.edges.length,
            diagnostics: graph.diagnostics.length,
          },
          freshness,
        }),
      );
      if (freshness.length > 0) process.exitCode = 1;
      return;
    }
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    default:
      throw new Error(`unknown command ${args.command}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
