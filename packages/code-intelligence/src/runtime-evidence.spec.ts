import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  assertDevelopmentRuntimeEnvironment,
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

function rehashRecord(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const { evidenceHash: _evidenceHash, id: _id, ...core } = record;
  const id = `runtime:${String(core.kind).toLowerCase()}:${sha256(
    stableJson(core),
  ).slice(0, 20)}`;
  return {
    ...core,
    id,
    evidenceHash: sha256(stableJson({ ...core, id })),
  };
}

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

interface FakeAdapterOptions {
  systemdSubState?: string;
  outboxCorrelationId?: unknown;
  echoRequestId?: boolean;
  composeHealth?: string;
  apiService?: unknown;
  fetchThrows?: boolean;
  migrationId?: unknown;
  outboxEventType?: unknown;
  buildStatus?: unknown;
  buildWorkflowId?: unknown;
}

function fakeAdapter(options: FakeAdapterOptions = {}): RuntimeProbeAdapter {
  return {
    now: () => new Date("2026-07-25T00:00:00.000Z"),
    fetchJson: async (_url, headers) => {
      if (options.fetchThrows) throw new Error("fixture API unavailable");
      return {
        status: 200,
        headers: {
          "x-request-id":
            options.echoRequestId === false
              ? ""
              : (headers["x-request-id"] ?? ""),
        },
        body: _url.endsWith("/db")
          ? { db: "ok" }
          : {
              status: "ok",
              service:
                options.apiService === undefined
                  ? "global-api"
                  : options.apiService,
              ts: "2026-07-25T00:00:00.000Z",
            },
        durationMs: 2,
      };
    },
    run: async (file, args) => {
      const joined = `${file} ${args.join(" ")}`;
      if (file === "systemctl") {
        const unit = args[1];
        return {
          stdout: `Id=${unit}\nActiveState=active\nSubState=${options.systemdSubState ?? "running"}\nWorkingDirectory=/global/backend/apps/api\nExecMainStartTimestamp=Fri 2026-07-25 00:00:00 UTC\nFragmentPath=/etc/systemd/system/${unit}\n`,
          durationMs: 1,
        };
      }
      if (joined.includes("docker compose")) {
        return {
          stdout:
            JSON.stringify({
              Service: "postgres",
              State: "running",
              Health: options.composeHealth ?? "healthy",
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
              migrationId: options.migrationId ?? "20260725000000_fixture",
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
              eventType:
                options.outboxEventType ?? "AssetObjectCleanupRequested",
              correlationIdPresent: options.outboxCorrelationId != null,
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
              status: options.buildStatus ?? "succeeded",
              kind: "refurbish",
              workflowId:
                options.buildWorkflowId ??
                "site-refurbish-00000000-0000-4000-8000-000000000002",
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
    assert.equal(
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "RUNTIME_CONFIGURATION_PROVENANCE_DRIFT",
      ),
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

test("runtime evidence rejects non-allowlisted and sensitive values", () => {
  assert.throws(
    () =>
      createRuntimeRecord({
        kind: "API_HEALTH",
        environment: "development",
        subject: "global-api",
        observedAt: "2026-07-25T00:00:00Z",
        outcome: "SUCCESS",
        metadata: { payload: "must-not-be-saved" },
      }),
    /metadata key is not allowlisted/,
  );
  assert.throws(
    () =>
      createRuntimeRecord({
        kind: "API_HEALTH",
        environment: "development",
        subject: "customer@example.com",
        observedAt: "2026-07-25T00:00:00Z",
        outcome: "SUCCESS",
      }),
    /subject is unsafe/,
  );
  assert.throws(
    () =>
      createRuntimeRecord({
        kind: "API_HEALTH",
        environment: "development",
        subject: "global-api",
        correlationId: "https://example.invalid/?email=customer@example.com",
        observedAt: "2026-07-25T00:00:00Z",
        outcome: "SUCCESS",
      }),
    /correlationId is unsafe/,
  );
  for (const service of [
    "Bearer abc.def",
    "Ｂｅａｒｅｒ abc.def",
    "person＠example.com",
    "ｈｔｔｐｓ：／／example.invalid",
    "sk-live-AbCdEf123",
    "JaneDoe",
  ]) {
    assert.throws(
      () =>
        createRuntimeRecord({
          kind: "API_HEALTH",
          environment: "development",
          subject: "global-api",
          observedAt: "2026-07-25T00:00:00Z",
          outcome: "SUCCESS",
          metadata: { service },
        }),
      /outside the allowlist: service/,
    );
  }
  assert.throws(
    () =>
      createRuntimeRecord({
        kind: "API_HEALTH",
        environment: "development",
        subject: "global-api",
        observedAt: "2026-07-25T00:00:00Z",
        outcome: "SUCCESS",
        metadata: { customerName: "Jane Doe" },
      }),
    /metadata key is not allowlisted/,
  );
  assert.throws(
    () =>
      createRuntimeRecord({
        kind: "API_HEALTH",
        environment: "development",
        subject: "global-api",
        observedAt: "2026-07-25T00:00:00Z",
        outcome: "SUCCESS",
        metadata: { deliveryState: "PUBLISHED" },
      }),
    /metadata fields do not match the API_HEALTH allowlist/,
  );
  assert.throws(
    () =>
      createRuntimeRecord({
        kind: "API_HEALTH",
        environment: "development",
        subject: "global-api",
        observedAt: "2026-07-25T00:00:00Z",
        outcome: "SUCCESS",
      }),
    /metadata fields do not match the API_HEALTH allowlist/,
  );
  assert.throws(
    () =>
      createRuntimeRecord({
        kind: "BUILD_RUN",
        environment: "development",
        subject: "00000000-0000-4000-8000-000000000002",
        observedAt: "2026-07-25T00:00:00Z",
        workflowId: `site-${"A".repeat(10_000)}`,
        workflowRunId: "run-fixture",
        buildRunId: "00000000-0000-4000-8000-000000000002",
        outcome: "SUCCESS",
        metadata: {
          executionStatus: "succeeded",
          buildKind: "refurbish",
          workflowIdentityPersisted: true,
          runtimeRevisionProven: false,
        },
      }),
    /workflowId is unsafe/,
  );
});

test("runtime evidence detects tampered record hashes", async () => {
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

    await collectDevelopmentRuntimeEvidence(root, fakeAdapter());
    const withoutCommit = JSON.parse(
      await readFile(bundlePath, "utf8"),
    ) as Record<string, unknown> & {
      records: Array<Record<string, unknown>>;
    };
    const recordWithoutCommit = { ...withoutCommit.records[0] };
    delete recordWithoutCommit.commit;
    withoutCommit.records[0] = rehashRecord(recordWithoutCommit);
    const withoutCommitBody = stableJson(withoutCommit);
    await writeFile(bundlePath, withoutCommitBody);
    const withoutCommitManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as Record<string, unknown> & { files: Record<string, string> };
    withoutCommitManifest.files["runtime-evidence-v1.json"] =
      sha256(withoutCommitBody);
    await writeFile(manifestPath, stableJson(withoutCommitManifest));
    await assert.rejects(
      readRuntimeEvidenceBundle(root),
      /record integrity check failed/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("collector omits free-text Outbox correlation and preserves unknown health", async () => {
  const { root, graph } = await fixtureRepository();
  try {
    const sensitiveCorrelation =
      "https://example.invalid/customer@example.com?token=secret";
    const bundle = await collectDevelopmentRuntimeEvidence(
      root,
      fakeAdapter({
        outboxCorrelationId: sensitiveCorrelation,
        echoRequestId: false,
        composeHealth: "",
      }),
    );
    const serialized = JSON.stringify(bundle);
    assert.equal(serialized.includes(sensitiveCorrelation), false);
    assert.equal(serialized.includes("customer@example.com"), false);
    const outbox = bundle.records.find(
      (record) => record.kind === "OUTBOX_EVENT",
    );
    assert.equal(outbox?.correlationId, undefined);
    assert.equal(outbox?.metadata.correlationIdPresent, true);
    const compose = bundle.records.find(
      (record) => record.kind === "COMPOSE_SERVICE",
    );
    assert.equal(compose?.outcome, "UNKNOWN");
    const api = bundle.records.filter((record) => record.kind === "API_HEALTH");
    assert.equal(
      api.every((record) => record.correlationId == null),
      true,
    );
    const report = createRuntimeDifferenceReport(graph, bundle);
    assert.equal(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === "API_CORRELATION_UNPROVEN",
      ),
      true,
    );
    assert.equal(
      report.diagnostics.some(
        (diagnostic) => diagnostic.code === "RUNTIME_HEALTH_UNPROVEN",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime evidence accepts the registered OpenOx video compatibility service", () => {
  const record = createRuntimeRecord({
    kind: "COMPOSE_SERVICE",
    environment: "development",
    subject: "openox-video-compat",
    observedAt: "2026-07-27T00:00:00.000Z",
    graphNodeIds: ["service:compose:openox-video-compat"],
    outcome: "SUCCESS",
    metadata: {
      state: "running",
      health: "healthy",
      image: "global-openox-video-compat:local",
      composeProject: "global",
      configurationRoot: "/global/backend",
      configurationFile: "/global/backend/docker-compose.yml",
      runtimeRevisionProven: false,
    },
  });

  assert.equal(record.subject, "openox-video-compat");
  assert.equal(record.outcome, "SUCCESS");
});

test("API probe failures remain safe FAILURE evidence", async () => {
  for (const options of [
    { fetchThrows: true },
    { apiService: null },
    { apiService: "JaneDoe" },
  ] satisfies FakeAdapterOptions[]) {
    const { root } = await fixtureRepository();
    try {
      const bundle = await collectDevelopmentRuntimeEvidence(
        root,
        fakeAdapter(options),
      );
      const api = bundle.records.find(
        (record) =>
          record.kind === "API_HEALTH" && record.subject === "global-api",
      );
      assert.equal(api?.outcome, "FAILURE");
      assert.equal(api?.metadata.service, null);
      assert.equal(JSON.stringify(api).includes("JaneDoe"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("malformed database rows degrade to redacted FAILURE evidence", async () => {
  const cases: Array<{
    options: FakeAdapterOptions;
    kind: "DATABASE_MIGRATION" | "OUTBOX_EVENT" | "BUILD_RUN";
    subject: string;
    marker: string;
  }> = [
    {
      options: { migrationId: "bad-migration-JaneDoe" },
      kind: "DATABASE_MIGRATION",
      subject: "latest-migration",
      marker: "bad-migration-JaneDoe",
    },
    {
      options: { outboxEventType: "JaneDoe" },
      kind: "OUTBOX_EVENT",
      subject: "latest-outbox-event",
      marker: "JaneDoe",
    },
    {
      options: { buildStatus: "sk-live-BuildSecret123" },
      kind: "BUILD_RUN",
      subject: "latest-build-run",
      marker: "sk-live-BuildSecret123",
    },
    {
      options: { buildWorkflowId: `site-${"A".repeat(1_000)}` },
      kind: "BUILD_RUN",
      subject: "latest-build-run",
      marker: `site-${"A".repeat(1_000)}`,
    },
  ];
  for (const fixture of cases) {
    const { root } = await fixtureRepository();
    try {
      const bundle = await collectDevelopmentRuntimeEvidence(
        root,
        fakeAdapter(fixture.options),
      );
      const failed = bundle.records.find(
        (record) => record.kind === fixture.kind,
      );
      assert.equal(failed?.subject, fixture.subject);
      assert.equal(failed?.outcome, "FAILURE");
      assert.equal(JSON.stringify(bundle).includes(fixture.marker), false);
      assert.equal(
        bundle.records.filter(
          (record) =>
            record.kind === "API_HEALTH" && record.outcome === "SUCCESS",
        ).length,
        2,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("long-running systemd units require active/running", async () => {
  const { root } = await fixtureRepository();
  try {
    const bundle = await collectDevelopmentRuntimeEvidence(
      root,
      fakeAdapter({ systemdSubState: "exited" }),
    );
    const systemd = bundle.records.filter(
      (record) => record.kind === "SYSTEMD_SERVICE",
    );
    assert.equal(systemd.length, 3);
    assert.equal(
      systemd.every((record) => record.outcome === "FAILURE"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bundle validates manifest collector, clean provenance, and environment consistency", async () => {
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
    const originalBundle = JSON.parse(await readFile(bundlePath, "utf8")) as {
      environment: string;
      collector: { branch: string; dirty: boolean };
      records: Array<{ environment: string }>;
    };
    const originalManifest = JSON.parse(
      await readFile(manifestPath, "utf8"),
    ) as {
      collector: { branch: string; dirty: boolean };
      files: Record<string, string>;
    };

    const mismatchedManifest = structuredClone(originalManifest);
    mismatchedManifest.collector.branch = "codex/other";
    await writeFile(manifestPath, stableJson(mismatchedManifest));
    await assert.rejects(
      readRuntimeEvidenceBundle(root),
      /manifest collector does not match bundle/,
    );

    const mixedEnvironment = structuredClone(originalBundle);
    mixedEnvironment.environment = "preproduction";
    const mixedBody = stableJson(mixedEnvironment);
    const mixedManifest = structuredClone(originalManifest);
    mixedManifest.files["runtime-evidence-v1.json"] = sha256(mixedBody);
    await writeFile(bundlePath, mixedBody);
    await writeFile(manifestPath, stableJson(mixedManifest));
    await assert.rejects(
      readRuntimeEvidenceBundle(root),
      /record integrity check failed/,
    );

    const dirtyBundle = structuredClone(originalBundle);
    dirtyBundle.collector.dirty = true;
    const dirtyBody = stableJson(dirtyBundle);
    const dirtyManifest = structuredClone(originalManifest);
    dirtyManifest.collector.dirty = true;
    dirtyManifest.files["runtime-evidence-v1.json"] = sha256(dirtyBody);
    await writeFile(bundlePath, dirtyBody);
    await writeFile(manifestPath, stableJson(dirtyManifest));
    await assert.rejects(
      readRuntimeEvidenceBundle(root),
      /cannot originate from a dirty worktree/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("freshness binds branch, clean state, repository root, and capture age", async () => {
  const { root } = await fixtureRepository();
  try {
    const bundle = await collectDevelopmentRuntimeEvidence(root, fakeAdapter());
    const wrongBranch = structuredClone(bundle);
    wrongBranch.collector.branch = "codex/other";
    assert.equal(
      (
        await runtimeEvidenceFreshnessDiagnostics(root, wrongBranch, {
          now: new Date("2026-07-25T00:01:00Z"),
        })
      ).some((diagnostic) => diagnostic.code === "RUNTIME_EVIDENCE_STALE"),
      true,
    );

    const wrongRoot = structuredClone(bundle);
    wrongRoot.collector.repositoryRoot = "/different/repository";
    assert.equal(
      (
        await runtimeEvidenceFreshnessDiagnostics(root, wrongRoot, {
          now: new Date("2026-07-25T00:01:00Z"),
        })
      ).some(
        (diagnostic) => diagnostic.code === "RUNTIME_EVIDENCE_WRONG_WORKTREE",
      ),
      true,
    );

    assert.equal(
      (
        await runtimeEvidenceFreshnessDiagnostics(root, bundle, {
          now: new Date("2026-07-26T00:00:01Z"),
        })
      ).some((diagnostic) => diagnostic.code === "RUNTIME_EVIDENCE_STALE"),
      true,
    );

    await writeFile(
      path.join(root, "fixture.ts"),
      "export const fixture = 2;\n",
    );
    assert.equal(
      (
        await runtimeEvidenceFreshnessDiagnostics(root, bundle, {
          now: new Date("2026-07-25T00:01:00Z"),
        })
      ).some((diagnostic) => diagnostic.code === "RUNTIME_EVIDENCE_STALE"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("capture rejects dirty graph provenance and non-development environments", async () => {
  assert.doesNotThrow(() => assertDevelopmentRuntimeEnvironment("development"));
  assert.throws(
    () => assertDevelopmentRuntimeEnvironment("preproduction"),
    /supports development only/,
  );
  assert.throws(
    () => assertDevelopmentRuntimeEnvironment("production"),
    /supports development only/,
  );

  const { root, graph } = await fixtureRepository();
  try {
    await writeFile(
      path.join(root, "fixture.ts"),
      "export const fixture = 2;\n",
    );
    const dirtyEvidence = await createEvidence(root);
    const dirtyGraph = { ...graph, evidence: dirtyEvidence };
    await writeDerivedArtifacts(root, {
      graph: dirtyGraph,
      coverage: {
        schemaVersion: "contract-graph-coverage/v1",
        evidence: dirtyEvidence,
        totals: {
          nodes: dirtyGraph.nodes.length,
          edges: dirtyGraph.edges.length,
          files: 1,
          errors: 0,
          warnings: 1,
        },
        mechanisms: [],
        unknownMechanisms: [],
      },
    });
    await assert.rejects(
      collectDevelopmentRuntimeEvidence(root, fakeAdapter()),
      /dirty worktree/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime evidence rejects cross-kind graph references", () => {
  assert.throws(
    () =>
      createRuntimeRecord({
        kind: "OUTBOX_EVENT",
        environment: "development",
        subject: "AssetObjectCleanupRequested",
        observedAt: "2026-07-25T00:00:00Z",
        sourceObservedAt: "2026-07-25T00:00:00Z",
        graphNodeIds: ["event:outbox:AssetObjectCleanupRequested"],
        graphEdgeIds: ["edge:registry-event"],
        eventId: "00000000-0000-4000-8000-000000000001",
        eventType: "AssetObjectCleanupRequested",
        outcome: "SUCCESS",
        metadata: {
          deliveryState: "PUBLISHED",
          correlationIdPresent: true,
          runtimeRevisionProven: false,
        },
      }),
    /graphEdgeIds/,
  );
  assert.throws(
    () =>
      createRuntimeRecord({
        kind: "API_HEALTH",
        environment: "development",
        subject: "global-api",
        observedAt: "2026-07-25T00:00:00Z",
        sourceObservedAt: "2026-07-25T00:00:00Z",
        graphNodeIds: ["workflow:temporal:refurbishWorkflow"],
        graphEdgeIds: ["edge:registry-event"],
        httpStatus: 200,
        outcome: "SUCCESS",
        metadata: {
          expectedKey: "status",
          checkPassed: true,
          requestIdEchoed: false,
          service: "global-api",
        },
      }),
    /graphNodeIds/,
  );
});

test("runtime evidence outcome must agree with per-kind status semantics", () => {
  const attacks: Array<Parameters<typeof createRuntimeRecord>[0]> = [
    {
      kind: "API_HEALTH" as const,
      subject: "global-api",
      graphNodeIds: ["api:GET:/health"],
      outcome: "SUCCESS" as const,
      sourceObservedAt: "2026-07-25T00:00:00Z",
      metadata: {
        expectedKey: "status",
        checkPassed: true,
        requestIdEchoed: false,
        service: "global-api",
      },
    },
    {
      kind: "SYSTEMD_SERVICE" as const,
      subject: "global-api.service",
      graphNodeIds: ["service:systemd:global-api.service"],
      outcome: "SUCCESS" as const,
      metadata: {
        activeState: "inactive",
        subState: "dead",
        workingDirectory: null,
        fragmentPath: null,
        processStartedAt: null,
        runtimeRevisionProven: false,
      },
    },
    {
      kind: "COMPOSE_SERVICE" as const,
      subject: "postgres",
      graphNodeIds: ["service:compose:postgres"],
      outcome: "SUCCESS" as const,
      metadata: {
        state: "running",
        health: "unhealthy",
        image: "pgvector/pgvector:pg16",
        composeProject: "global",
        configurationRoot: "/global/backend",
        configurationFile: "/global/backend/docker-compose.yml",
        runtimeRevisionProven: false,
      },
    },
    {
      kind: "TEMPORAL_CLUSTER" as const,
      subject: "temporal-dev",
      graphNodeIds: ["service:systemd:temporal-dev.service"],
      outcome: "SUCCESS" as const,
      metadata: {
        serving: false,
        address: "127.0.0.1:7233",
        runtimeRevisionProven: false,
      },
    },
    {
      kind: "TEMPORAL_SCHEDULE" as const,
      subject: "acq-sweep",
      graphNodeIds: [
        "service:temporal-schedule:acq-sweep",
        "workflow:temporal:acquisitionSweepWorkflow",
      ],
      graphEdgeIds: ["edge:schedule-calls-acquisition"],
      scheduleId: "acq-sweep",
      outcome: "SUCCESS" as const,
      metadata: {
        workflowType: "acquisitionSweepWorkflow",
        executionStatus: "UNKNOWN",
        runtimeRevisionProven: false,
      },
    },
    {
      kind: "OUTBOX_EVENT" as const,
      subject: "AssetObjectCleanupRequested",
      graphNodeIds: ["event:outbox:AssetObjectCleanupRequested"],
      sourceObservedAt: "2026-07-25T00:00:00Z",
      eventId: "00000000-0000-4000-8000-000000000001",
      eventType: "AssetObjectCleanupRequested",
      outcome: "SUCCESS" as const,
      metadata: {
        deliveryState: "PARKED",
        correlationIdPresent: true,
        runtimeRevisionProven: false,
      },
    },
    {
      kind: "DATABASE_MIGRATION" as const,
      subject: "20260725000000_fixture",
      graphNodeIds: ["migration:20260725000000_fixture"],
      migrationId: "20260725000000_fixture",
      outcome: "SUCCESS" as const,
      metadata: {
        finished: false,
        rolledBack: false,
        unfinishedCount: 1,
        database: "global_dev",
        runtimeRevisionProven: false,
      },
    },
    {
      kind: "BUILD_RUN" as const,
      subject: "00000000-0000-4000-8000-000000000002",
      sourceObservedAt: "2026-07-25T00:00:00Z",
      graphNodeIds: [
        "data-model:prisma:SiteBuildRun",
        "workflow:temporal:refurbishWorkflow",
      ],
      workflowId: "site-refurbish-00000000-0000-4000-8000-000000000002",
      workflowRunId: "run-build-fixture",
      buildRunId: "00000000-0000-4000-8000-000000000002",
      outcome: "SUCCESS" as const,
      metadata: {
        executionStatus: "failed",
        buildKind: "refurbish",
        workflowIdentityPersisted: true,
        runtimeRevisionProven: false,
      },
    },
  ];
  for (const attack of attacks) {
    assert.throws(
      () =>
        createRuntimeRecord({
          environment: "development",
          observedAt: "2026-07-25T00:00:00Z",
          ...attack,
        }),
      /outcome disagrees/,
    );
  }
});

test("difference report rejects a fake existing Temporal Schedule edge", async () => {
  const { root, graph } = await fixtureRepository();
  try {
    const bundle = await collectDevelopmentRuntimeEvidence(root, fakeAdapter());
    const wrongSchedule = createRuntimeRecord({
      kind: "TEMPORAL_SCHEDULE",
      environment: "development",
      subject: "acq-sweep",
      observedAt: bundle.capturedAt,
      sourceObservedAt: bundle.capturedAt,
      graphNodeIds: [
        "service:temporal-schedule:acq-sweep",
        "workflow:temporal:acquisitionSweepWorkflow",
      ],
      graphEdgeIds: ["edge:registry-event"],
      workflowId: "acq-sweep-workflow-fixture",
      workflowRunId: "run-fixture",
      scheduleId: "acq-sweep",
      outcome: "SUCCESS",
      metadata: {
        workflowType: "acquisitionSweepWorkflow",
        executionStatus: "WORKFLOW_EXECUTION_STATUS_COMPLETED",
        runtimeRevisionProven: false,
      },
    });
    bundle.records = bundle.records.map((record) =>
      record.kind === "TEMPORAL_SCHEDULE" ? wrongSchedule : record,
    );
    const report = createRuntimeDifferenceReport(graph, bundle);
    assert.equal(report.conclusion, "CONTRADICTED");
    assert.equal(report.observedEdgeIds.includes("edge:registry-event"), false);
    assert.equal(
      report.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === "RUNTIME_GRAPH_TARGET_MISSING" &&
          diagnostic.severity === "error",
      ),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
