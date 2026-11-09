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
  // B4（2026-11-08）：新增 tool-budget-reconciliation 周期清收。
  // B3（2026-11-08）：新增 discovery-stale-run-sweep 周期看门狗。
  // P1-19（2026-11-09）：新增 contact-reverify-sweep（联系人再验证，注册即 paused）。
  // P1-17（2026-11-09）：新增 contact-weekly-report（联系人工程周报，注册即 paused）。
  assert.equal(schedules.length, 14);
  assert.equal(
    graph.edges.some(
      (edge) =>
        edge.from === "service:temporal-schedule:contact-reverify-sweep" &&
        edge.kind === "calls" &&
        edge.to === "workflow:temporal:contactReverifySweepWorkflow",
    ),
    true,
    "contact-reverify-sweep must point to contactReverifySweepWorkflow",
  );
  assert.equal(
    graph.edges.some(
      (edge) =>
        edge.from === "service:temporal-schedule:contact-weekly-report" &&
        edge.kind === "calls" &&
        edge.to === "workflow:temporal:contactWeeklyReportWorkflow",
    ),
    true,
    "contact-weekly-report must point to contactWeeklyReportWorkflow",
  );
  assert.equal(
    graph.edges.some(
      (edge) =>
        edge.from === "service:temporal-schedule:raw-source-retention" &&
        edge.kind === "calls" &&
        edge.to === "workflow:temporal:rawRetentionSweepWorkflow",
    ),
    true,
    "raw-source-retention must point to rawRetentionSweepWorkflow",
  );
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

  const routeEvent =
    "symbol:apps/api/src/relay/outbox-relay.service.ts#OutboxRelayService.routeEvent";
  const expectedOutboxRegistries = new Map<string, string[]>([
    [
      "INTERNAL_COMMANDS",
      [
        "AssetObjectCleanupRequested",
        "CompanyProfileCreated",
        "DeletionRequested",
        "DiscoveryRunRequested",
        "PersonalArtifactCleanupRequested",
        "QualifyRequested",
      ],
    ],
    [
      "INTEGRATION_EVENTS",
      [
        // ch08 §3.1.4：campaign 失败回写第二通道（控制面 PATCH 重试耗尽后的 outbox 兜底）。
        "CampaignPlanJobFailed",
        // M2 步 10：qualify 每批一条候选批次事件。
        "CandidateBatchCompleted",
        "ClaimApproved",
        "ClaimExpired",
        "ClaimRevoked",
        "DeletionCompleted",
        "DiscoveryRunCompleted",
        "ICPActivated",
        "KnowledgeConflictDetected",
        "LeadQualified",
        "LeadsScored",
        // ch08 §3.1.12：制裁名单陈旧告警。
        "SanctionsListStale",
        "SiteBuildCostSummaryUpdated",
      ],
    ],
  ]);
  for (const [registry, eventTypes] of expectedOutboxRegistries) {
    const registryId = `service:outbox-event-registry:${registry}`;
    assert.equal(
      graph.edges.some(
        (edge) =>
          edge.kind === "consumes" &&
          edge.from === routeEvent &&
          edge.to === registryId &&
          edge.attributes.confidence === "PROVEN_STATIC_SET_MEMBERSHIP",
      ),
      true,
      `routeEvent must consume ${registry} through Set membership`,
    );
    assert.deepEqual(
      graph.edges
        .filter(
          (edge) =>
            edge.kind === "registers" &&
            edge.from === registryId &&
            edge.attributes.confidence === "PROVEN_STATIC_SET_REGISTRATION",
        )
        .map((edge) => edge.to.replace("event:outbox:", ""))
        .sort(),
      eventTypes.sort(),
      `${registry} literals and ContractGraph registration edges must stay complete`,
    );
  }

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
