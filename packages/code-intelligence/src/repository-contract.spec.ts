import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { buildContractGraph, criticalDiagnostics } from "./scan";

test("current repository keeps representative business and dynamic chains complete", async () => {
  const repositoryRoot = path.resolve(__dirname, "../../..");
  const { graph, coverage } = await buildContractGraph(repositoryRoot);

  assert.deepEqual(criticalDiagnostics(graph.diagnostics), []);
  assert.equal(
    graph.edges.some(
      (edge) =>
        edge.from === "governance:CAP-SITE-INTAKE-001" &&
        edge.to === "api:POST:/site-builder/intake" &&
        edge.attributes.relation === "public-contract",
    ),
    true,
  );
  assert.equal(
    graph.edges.some(
      (edge) =>
        edge.from === "test:apps/api/src/site-builder/intake.service.spec.ts" &&
        edge.to === "governance:CAP-SITE-INTAKE-001" &&
        edge.attributes.relation === "test-anchor",
    ),
    true,
  );

  const schedules = graph.nodes.filter(
    (node) =>
      node.id.startsWith("service:temporal-schedule:") &&
      !node.id.includes("registration"),
  );
  assert.equal(schedules.length, 8);
  for (const schedule of schedules) {
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.from === schedule.id &&
          edge.kind === "calls" &&
          edge.to.startsWith("workflow:temporal:"),
      ),
      true,
      `${schedule.id} must point to its configured workflow`,
    );
  }
  assert.equal(
    graph.edges.some(
      (edge) =>
        edge.from === "workflow:temporal:sanctionsRefreshWorkflow" &&
        edge.to === "activity:temporal:refreshSanctionsLists" &&
        edge.attributes.binding === "destructured-proxy-activity",
    ),
    true,
  );

  assert.equal(
    coverage.mechanisms.some(
      (mechanism) =>
        mechanism.status === "EXTRACTOR" && mechanism.matchedLocations === 0,
    ),
    false,
  );
  assert.equal(
    graph.nodes.some(
      (node) =>
        node.kind === "external_system" &&
        /169\.254\.169\.254|attacker\.invalid/.test(node.label),
    ),
    false,
  );
  assert.equal(
    graph.nodes.some(
      (node) =>
        node.kind === "data_model" &&
        node.attributes.tenantScoped === true &&
        node.attributes.hasRlsContract !== true,
    ),
    false,
  );

  const broker = graph.nodes.find((node) => node.id === "service:tool-broker");
  assert.equal(
    broker?.attributes.sourcePolicy,
    "PROVEN_STATIC_FAIL_CLOSED_BRANCH",
  );
  assert.equal(broker?.attributes.budget, "PROVEN_STATIC_RESERVE_SETTLE");
  assert.equal(
    broker?.attributes.allowedTools,
    "PROVEN_STATIC_ALLOWLIST_CHECK",
  );
  assert.equal(
    graph.nodes
      .filter(
        (node) =>
          node.kind === "service" &&
          node.attributes.subtype === "ai-task" &&
          node.attributes.maxCostCents != null,
      )
      .every(
        (node) =>
          node.attributes.killSwitch === "UNKNOWN_NOT_PROVEN_BY_TASK_BINDING",
      ),
    true,
  );
});
