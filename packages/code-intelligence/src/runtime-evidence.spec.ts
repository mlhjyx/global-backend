import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  collectDevelopmentRuntimeEvidence,
  createRuntimeDifferenceReport,
  createRuntimeRecord,
  readRuntimeEvidenceBundle,
  runtimeEvidenceFreshnessDiagnostics,
  RuntimeProbeAdapter,
} from "./runtime-evidence";
import { createEvidence, writeDerivedArtifacts } from "./scan";
import { ContractGraphV1, CoverageReportV1, GraphNodeV1 } from "./schema";
import { sha256, stableJson } from "./utils";

const execFile = promisify(execFileCallback);

function node(
  id: string,
  kind: GraphNodeV1["kind"],
  requiresRuntimeEvidence = false,
): GraphNodeV1 {
  return {
    id,
    kind,
    label: id,
    attributes: { requiresRuntimeEvidence },
    locations: [],
  };
}

function fakeAdapter(): RuntimeProbeAdapter {
  return {
    now: () => new Date("2026-07-25T00:00:00.000Z"),
    fetchJson: async (_url, headers) => ({
      status: 200,
      headers: { "x-request-id": headers["x-request-id"] ?? "" },
      body: _url.endsWith("/db")
        ? { db: "ok" }
        : {
            status: "ok",
            service: "global-api",
            ts: "2026-07-25T00:00:00.000Z",
          },
      durationMs: 2,
    }),
    run: async (file, args) => {
      const joined = `${file} ${args.join(" ")}`;
      if (file === "systemctl") {
        const unit = args[1];
        return {
          stdout: `Id=${unit}\nActiveState=active\nSubState=running\nWorkingDirectory=/global/backend/apps/api\nExecMainStartTimestamp=Fri 2026-07-25 00:00:00 UTC\nFragmentPath=/etc/systemd/system/${unit}\n`,
          durationMs: 1,
        };
      }
      if (joined.includes("docker compose")) {
        return {
          stdout:
            JSON.stringify({
              Service: "postgres",
              State: "running",
              Health: "healthy",
              Image: "pgvector/pgvector:pg16",
              Project: "global",
              Labels:
                "com.docker.compose.project.working_dir=/global/backend,com.docker.compose.project.config_files=/global/backend/docker-compose.yml",
            }) + "\n",
          durationMs: 2,
        };
      }
      if (joined.includes("temporal operator cluster health")) {
        return { stdout: "SERVING\n", durationMs: 1 };
      }
      if (joined.includes("temporal schedule list")) {
        return {
          stdout: JSON.stringify([
            {
              scheduleId: "acq-sweep",
              info: {
                workflowType: { name: "acquisitionSweepWorkflow" },
                recentActions: [
                  {
                    actualTime: "2026-07-25T00:00:00Z",
                    startWorkflowResult: {
                      workflowId: "acq-sweep-workflow-fixture",
                      runId: "run-fixture",
                    },
                    startWorkflowStatus: "WORKFLOW_EXECUTION_STATUS_COMPLETED",
                  },
                ],
              },
            },
          ]),
          durationMs: 3,
        };
      }
      const sql = args.at(-1) ?? "";
      if (
        joined.includes("docker exec") &&
        sql.includes("_prisma_migrations")
      ) {
        return {
          stdout:
            JSON.stringify({
              migrationId: "20260725000000_fixture",
              finishedAt: "2026-07-25T00:00:00Z",
              rolledBackAt: null,
              unfinishedCount: 0,
            }) + "\n",
          durationMs: 4,
        };
      }
      if (joined.includes("docker exec") && sql.includes("outbox_event")) {
        return {
          stdout:
            JSON.stringify({
              eventId: "00000000-0000-4000-8000-000000000001",
              eventType: "AssetObjectCleanupRequested",
              correlationId: null,
              occurredAt: "2026-07-25T00:00:00Z",
              deliveryState: "PUBLISHED",
            }) + "\n",
          durationMs: 4,
        };
      }
      if (joined.includes("docker exec") && sql.includes("site_build_run")) {
        return {
          stdout:
            JSON.stringify({
              buildRunId: "00000000-0000-4000-8000-000000000002",
              status: "succeeded",
              kind: "refurbish",
              workflowId: "site-refurbish-00000000-0000-4000-8000-000000000002",
              workflowRunId: "run-build-fixture",
              createdAt: "2026-07-25T00:00:00Z",
            }) + "\n",
          durationMs: 4,
        };
      }
      throw new Error(`unexpected probe command: ${joined}`);
    },
  };
}

async function fixtureRepository(): Promise<{
  root: string;
  graph: ContractGraphV1;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "runtime-evidence-"));
  await execFile("git", ["init", "--quiet"], { cwd: root });
  await execFile("git", ["config", "user.email", "test@example.invalid"], {
    cwd: root,
  });
  await execFile("git", ["config", "user.name", "Runtime Evidence Test"], {
    cwd: root,
  });
  await writeFile(path.join(root, ".gitignore"), ".code-intelligence/\n");
  await writeFile(path.join(root, "fixture.ts"), "export const fixture = 1;\n");
  await execFile("git", ["add", ".gitignore", "fixture.ts"], { cwd: root });
  await execFile("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  const evidence = await createEvidence(root);
  const scheduleEdge = {
    id: "edge:schedule-calls-acquisition",
    kind: "calls" as const,
    from: "service:temporal-schedule:acq-sweep",
    to: "workflow:temporal:acquisitionSweepWorkflow",
    attributes: { requiresRuntimeEvidence: true },
    locations: [],
  };
  const graph: ContractGraphV1 = {
    schemaVersion: "contract-graph/v1",
    evidence,
    nodes: [
      node("api:GET:/health", "api", true),
      node("api:GET:/health/db", "api", true),
      node("service:systemd:global-api.service", "deployment"),
      node("service:systemd:global-worker.service", "deployment"),
      node("service:systemd:temporal-dev.service", "deployment"),
      node("service:compose:postgres", "service"),
      node("service:temporal-schedule:acq-sweep", "service", true),
      node("workflow:temporal:acquisitionSweepWorkflow", "workflow", true),
      node("event:outbox:AssetObjectCleanupRequested", "event", true),
      node("migration:20260725000000_fixture", "migration", true),
      node("data-model:prisma:SiteBuildRun", "data_model"),
      node("workflow:temporal:refurbishWorkflow", "workflow"),
    ],
    edges: [
      scheduleEdge,
      {
        id: "edge:registry-event",
        kind: "registers",
        from: "service:outbox-event-registry:INTERNAL_COMMANDS",
        to: "event:outbox:AssetObjectCleanupRequested",
        attributes: { confidence: "PROVEN_STATIC" },
        locations: [],
      },
    ],
    diagnostics: [],
  };
  const coverage: CoverageReportV1 = {
    schemaVersion: "contract-graph-coverage/v1",
    evidence,
    totals: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      files: 1,
      errors: 0,
      warnings: 0,
    },
    mechanisms: [],
    unknownMechanisms: [],
  };
  await writeDerivedArtifacts(root, { graph, coverage });
  return { root, graph };
}

test("development capture keeps only allowlisted metadata and binds dynamic evidence", async () => {
  const { root, graph } = await fixtureRepository();
  try {
    const bundle = await collectDevelopmentRuntimeEvidence(root, fakeAdapter());
    assert.equal(bundle.environment, "development");
    assert.equal(bundle.records.length, 11);
    assert.equal(
      bundle.records.every((record) => record.commit === "UNKNOWN"),
      true,
    );
    assert.equal(
      bundle.records.every(
        (record) =>
          record.evidenceHash.length === 64 &&
          !JSON.stringify(record).match(
            /(?:payload|prompt|password|credential|secret)/i,
          ),
      ),
      true,
    );
    const schedule = bundle.records.find(
      (record) => record.kind === "TEMPORAL_SCHEDULE",
    );
    assert.deepEqual(schedule?.graphEdgeIds, [
      "edge:schedule-calls-acquisition",
    ]);
    const report = createRuntimeDifferenceReport(graph, bundle);
    assert.equal(report.conclusion, "PARTIAL");
    assert.deepEqual(report.runtimeOnlyNodeIds, []);
    assert.deepEqual(report.runtimeOnlyEdgeIds, []);
    assert.equal(
      report.observedEdgeIds.includes("edge:schedule-calls-acquisition"),
      true,
    );
    await writeFile(
      path.join(root, "fixture.ts"),
      "export const fixture = 2;\n",
    );
    assert.equal(
      (await runtimeEvidenceFreshnessDiagnostics(root, bundle)).some(
        (diagnostic) => diagnostic.code === "RUNTIME_EVIDENCE_STALE",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime evidence rejects forbidden metadata and tampered record hashes", async () => {
  assert.throws(
    () =>
      createRuntimeRecord({
        kind: "API_HEALTH",
        environment: "development",
        subject: "fixture",
        observedAt: "2026-07-25T00:00:00Z",
        outcome: "SUCCESS",
        metadata: { payload: "must-not-be-saved" },
      }),
    /metadata key is forbidden/,
  );

  const { root } = await fixtureRepository();
  try {
    await collectDevelopmentRuntimeEvidence(root, fakeAdapter());
    const bundlePath = path.join(
      root,
      ".code-intelligence",
      "runtime-evidence-v1.json",
    );
    const manifestPath = path.join(
      root,
      ".code-intelligence",
      "runtime-evidence-manifest-v1.json",
    );
    const bundle = JSON.parse(await readFile(bundlePath, "utf8")) as Record<
      string,
      unknown
    > & {
      records: Array<Record<string, unknown>>;
    };
    bundle.records[0].outcome = "FAILURE";
    const body = stableJson(bundle);
    await writeFile(bundlePath, body);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    > & { files: Record<string, string> };
    manifest.files["runtime-evidence-v1.json"] = sha256(body);
    await writeFile(manifestPath, stableJson(manifest));
    await assert.rejects(
      readRuntimeEvidenceBundle(root),
      /record integrity check failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
