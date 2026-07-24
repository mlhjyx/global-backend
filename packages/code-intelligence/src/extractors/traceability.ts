import path from "node:path";
import { GraphBuilder } from "../graph";
import { GraphNodeV1 } from "../schema";
import { isRegularFile, readUtf8, relativePath } from "../utils";

const CAPABILITY_ID = /\bCAP-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/;
const FILE_TOKEN =
  /\b(?:apps|packages|scripts)\/[A-Za-z0-9_./-]+\.(?:ts|tsx|mts|astro|prisma|sql)\b|\b[A-Za-z0-9_.-]+\.(?:spec\.)?(?:ts|tsx|mts|astro)\b/g;
const OPERATION_ID =
  /\b(?:(?<controller>[A-Za-z][A-Za-z0-9]*Controller)_)?(?<method>[A-Za-z][A-Za-z0-9]*)_v\d+\b/g;

function sourceFilesBySuffix(nodes: GraphNodeV1[]): Map<string, GraphNodeV1[]> {
  const bySuffix = new Map<string, GraphNodeV1[]>();
  for (const node of nodes) {
    if (node.kind !== "source_file") continue;
    const keys = new Set([
      node.label,
      path.posix.basename(node.label),
      ...node.label
        .split("/")
        .map((_, index, segments) => segments.slice(index).join("/")),
    ]);
    for (const key of keys) {
      const entries = bySuffix.get(key) ?? [];
      entries.push(node);
      bySuffix.set(key, entries);
    }
  }
  return bySuffix;
}

function apiByOperation(nodes: GraphNodeV1[]): Map<string, GraphNodeV1[]> {
  const output = new Map<string, GraphNodeV1[]>();
  for (const node of nodes) {
    if (node.kind !== "api") continue;
    const operation = node.attributes.operation;
    if (typeof operation !== "string") continue;
    const entries = output.get(operation) ?? [];
    entries.push(node);
    output.set(operation, entries);
  }
  return output;
}

function registeredAttributes(
  relation: string,
): Record<string, boolean | string> {
  return {
    relation,
    source: "docs/governance/traceability-matrix.md",
    confidence: "REGISTERED_TRACEABILITY",
    provesRuntime: false,
  };
}

/**
 * Link the repository's canonical traceability contract to nodes emitted by
 * the code extractors. Merely putting governance and code in one graph is not
 * enough: these explicit edges are the auditable bridge.
 */
export async function extractTraceability(
  builder: GraphBuilder,
  repositoryRoot: string,
): Promise<void> {
  const absolute = path.join(
    repositoryRoot,
    "docs",
    "governance",
    "traceability-matrix.md",
  );
  if (!(await isRegularFile(absolute))) return;
  const text = await readUtf8(absolute);
  const relative = relativePath(repositoryRoot, absolute);
  const nodes = builder.snapshotNodes();
  const files = sourceFilesBySuffix(nodes);
  const operations = apiByOperation(nodes);

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trimStart().startsWith("|")) continue;
    const capabilityMatch = CAPABILITY_ID.exec(line);
    if (!capabilityMatch) continue;
    const capabilityId = `governance:${capabilityMatch[0]}`;
    if (!builder.hasNode(capabilityId)) continue;
    const location = { path: relative, line: index + 1 };

    const linkedFiles = new Set<string>();
    for (const match of line.matchAll(FILE_TOKEN)) {
      const token = match[0].replace(/[),.;]+$/, "");
      for (const file of files.get(token) ?? []) {
        if (linkedFiles.has(file.id)) continue;
        linkedFiles.add(file.id);
        builder.addEdge({
          kind: "references",
          from: capabilityId,
          to: file.id,
          attributes: registeredAttributes(
            file.attributes.test === true
              ? "test-anchor"
              : "implementation-anchor",
          ),
          location,
        });
        if (file.attributes.test === true) {
          const testId = `test:${file.label}`;
          if (builder.hasNode(testId)) {
            builder.addEdge({
              kind: "validates",
              from: testId,
              to: capabilityId,
              attributes: registeredAttributes("test-anchor"),
              location,
            });
          }
        }
      }
    }

    let currentController: string | undefined;
    for (const match of line.matchAll(OPERATION_ID)) {
      const controller = match.groups?.controller ?? currentController;
      const method = match.groups?.method;
      if (match.groups?.controller) currentController = match.groups.controller;
      if (!controller || !method) continue;
      const operation = `${controller}.${method}`;
      for (const api of operations.get(operation) ?? []) {
        builder.addEdge({
          kind: "references",
          from: capabilityId,
          to: api.id,
          attributes: registeredAttributes("public-contract"),
          location,
        });
      }
    }
  }
}
