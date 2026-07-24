import assert from "node:assert/strict";
import test from "node:test";
import { evaluateDynamicMechanisms } from "./dynamic-mechanisms";
import { GraphBuilder } from "./graph";
import { EvidenceRefV1 } from "./schema";
import { stableJson } from "./utils";

const EVIDENCE: EvidenceRefV1 = {
  schemaVersion: "evidence-ref/v1",
  repositoryRoot: "/repo",
  worktreePath: "/repo/.codex/worktrees/test",
  branch: "codex/test",
  commit: "a".repeat(40),
  commitTime: "2026-07-25T00:00:00Z",
  dirty: false,
  sourceHash: "b".repeat(64),
};

test("GraphBuilder merges repeated evidence and stays deterministic", () => {
  const build = (): string => {
    const builder = new GraphBuilder();
    builder.addNode({
      id: "file:a.ts",
      kind: "source_file",
      label: "a.ts",
      attributes: { tags: ["b"] },
      location: { path: "a.ts", line: 2 },
    });
    builder.addNode({
      id: "file:a.ts",
      kind: "source_file",
      label: "a.ts",
      attributes: { tags: ["a"] },
      location: { path: "a.ts", line: 1 },
    });
    builder.addNode({
      id: "symbol:a.ts#run",
      kind: "code_symbol",
      label: "run",
      location: { path: "a.ts", line: 3 },
    });
    builder.addEdge({
      kind: "contains",
      from: "file:a.ts",
      to: "symbol:a.ts#run",
      location: { path: "a.ts", line: 3 },
    });
    return stableJson(builder.finalize(EVIDENCE));
  };
  assert.equal(build(), build());
  const graph = JSON.parse(build());
  assert.deepEqual(graph.nodes[0].attributes.tags, ["a", "b"]);
  assert.equal(graph.diagnostics.length, 0);
});

test("broken endpoints are an error and cannot silently enter the graph", () => {
  const builder = new GraphBuilder();
  builder.addNode({ id: "file:a.ts", kind: "source_file", label: "a.ts" });
  builder.addEdge({
    kind: "calls",
    from: "file:a.ts",
    to: "symbol:missing",
  });
  const graph = builder.finalize(EVIDENCE);
  assert.equal(
    graph.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "BROKEN_EDGE" && diagnostic.severity === "error",
    ),
    true,
  );
});

test("an explicit unregistered dynamic mechanism fails closed", () => {
  const builder = new GraphBuilder();
  evaluateDynamicMechanisms(
    builder,
    [
      {
        path: "apps/api/src/example.ts",
        text: `// ${["@dynamic", "-mechanism custom.string-dispatch"].join("")}\n`,
      },
    ],
    "2026-07-25",
  );
  const graph = builder.finalize(EVIDENCE);
  assert.equal(
    graph.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "UNCLAIMED_DYNAMIC_MECHANISM" &&
        diagnostic.severity === "error",
    ),
    true,
  );
});

test("a registered marker is attributed without an unclaimed diagnostic", () => {
  const builder = new GraphBuilder();
  const coverage = evaluateDynamicMechanisms(
    builder,
    [
      {
        path: "apps/api/src/example.ts",
        text: "// @dynamic-mechanism temporal.proxy-activities\nproxyActivities<Foo>();",
      },
    ],
    "2026-07-25",
  );
  const graph = builder.finalize(EVIDENCE);
  assert.equal(
    graph.diagnostics.some(
      (diagnostic) => diagnostic.code === "UNCLAIMED_DYNAMIC_MECHANISM",
    ),
    false,
  );
  assert.equal(
    coverage.find((item) => item.mechanismId === "temporal.proxy-activities")
      ?.matchedLocations,
    1,
  );
});
