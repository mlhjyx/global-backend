import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Context as ActivityContext } from "@temporalio/activity";
import { Connection, WorkflowClient } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import {
  DESIGN_EVALUATION_V2_SCHEMA_VERSION,
  QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
  qualityArtifactSetDigest,
} from "@global/contracts";
import { refurbishWorkflow } from "../src/temporal/refurbish.workflow";

type Scenario =
  | "round0_pass_ack_loss"
  | "round2_pass"
  | "round3_fail"
  | "pointer_conflict"
  | "worker_restart"
  | "cancel_during_quality";

interface ScenarioState {
  buildingVersions: number;
  releases: number;
  materializeCalls: number;
  finalizeCalls: number;
  compensated: "failed" | "cancelled" | null;
  activePointer: "old" | "new";
  evaluationStarted: boolean;
  evaluationCalls: number;
  workerRestartRequested: boolean;
  paidActivityCalls: number;
}

const BRIEF_DIGEST = "b".repeat(64);
const states = new Map<string, ScenarioState>();

function state(workflowId: string): ScenarioState {
  const existing = states.get(workflowId);
  if (existing) return existing;
  const created: ScenarioState = {
    buildingVersions: 0,
    releases: 0,
    materializeCalls: 0,
    finalizeCalls: 0,
    compensated: null,
    activePointer: "old",
    evaluationStarted: false,
    evaluationCalls: 0,
    workerRestartRequested: false,
    paidActivityCalls: 0,
  };
  states.set(workflowId, created);
  return created;
}

function scenario(input: Record<string, unknown>): Scenario {
  return input.verificationScenario as Scenario;
}

function recordPaidActivity(): void {
  const workflowId =
    ActivityContext.current().info.workflowExecution.workflowId;
  state(workflowId).paidActivityCalls += 1;
}

function candidate(input: Record<string, unknown>, digest = "a".repeat(64)) {
  const workflowId =
    ActivityContext.current().info.workflowExecution.workflowId;
  const current = state(workflowId);
  current.buildingVersions = Math.max(current.buildingVersions, 1);
  return {
    previewSlug: "m1f-verification",
    versionId: "version-1",
    designBrief: { digest: BRIEF_DIGEST },
    candidate: {
      workspaceId: input.workspaceId,
      siteId: input.siteId,
      siteVersionId: "version-1",
      buildRunId: input.buildRunId,
      specDigest: digest,
      designBriefDigest: BRIEF_DIGEST,
      rendererOutputDigest: "c".repeat(64),
      basePath: "/preview/m1f-verification/",
      siteOrigin: "http://localhost:3000",
      root: "/tmp/m1f-verification",
    },
  };
}

function quality(round: 0 | 1 | 2 | 3, digest: string, passed: boolean) {
  const draft = {
    schemaVersion: QUALITY_ARTIFACT_SET_SCHEMA_VERSION,
    candidateSpecDigest: digest,
    designBriefDigest: BRIEF_DIGEST,
    round,
    expectedTargets: [{ locale: "en", pageId: "home" }],
    artifacts: ([375, 768, 1440] as const).map((breakpoint) => ({
      artifactId: `screenshot-${breakpoint}`,
      objectKey: `verification/round-${round}/screenshot-${breakpoint}.png`,
      sha256: String(breakpoint).padStart(64, "0"),
      sizeBytes: 10,
      mimeType: "image/png" as const,
      kind: "screenshot" as const,
      target: { locale: "en", pageId: "home", breakpoint },
    })),
  };
  const artifactSet = {
    ...draft,
    artifactSetDigest: qualityArtifactSetDigest(draft),
  };
  const failure = {
    source: "deterministic" as const,
    severity: "blocker" as const,
    ruleCode: "HORIZONTAL_OVERFLOW" as const,
    target: { locale: "en", pageId: "home", breakpoint: 375 as const },
    evidenceRef: { artifactId: "screenshot-375" },
  };
  return {
    evaluation: {
      schemaVersion: DESIGN_EVALUATION_V2_SCHEMA_VERSION,
      candidateSpecDigest: digest,
      designBriefDigest: BRIEF_DIGEST,
      artifactSetDigest: artifactSet.artifactSetDigest,
      round,
      evaluatorVersion: "site-builder-deterministic-quality@1.0.0",
      deterministic: {
        status: passed ? ("passed" as const) : ("failed" as const),
        hardFailures: passed ? [] : [failure],
        findings: [],
      },
      aesthetic: {
        status: "unavailable" as const,
        overallScore: null,
        dimensions: null,
        unavailableReason: "timeout" as const,
        findings: [],
      },
    },
    designEvaluationDigest: String(round + 1)
      .repeat(64)
      .slice(0, 64),
    artifactSet,
    passed,
    artifactRefs: {
      schemaVersion: "site-builder-step-artifact-refs/v1",
      collectionDigest: "d".repeat(64),
      artifacts: [
        {
          artifactId: "screenshot-375",
          objectKey: "verification/screenshot-375.png",
          sha256: "e".repeat(64),
          sizeBytes: 10,
          mimeType: "image/png",
          kind: "screenshot",
        },
      ],
    },
  };
}

const activities = {
  beginRefurbishRun: async () => undefined,
  recordRefurbishProgress: async () => undefined,
  ingestPendingKb: async () => ({ processed: 0, failed: 0 }),
  buildBrandProfile: async () => {
    recordPaidActivity();
    return {
      version: 1,
      factCount: 1,
      gapsCount: 0,
      researchDegraded: false,
      model: "gpt-5.6-terra",
    };
  },
  listImages: async () => ({ assetIds: [], truncated: false }),
  generateDesignBrief: async () => {
    recordPaidActivity();
    return {
      source: "generated",
      designBrief: { digest: BRIEF_DIGEST },
      taskAttemptId: "design-attempt",
    };
  },
  generateCopyBundles: async () => {
    recordPaidActivity();
    return {
      snapshotId: "snapshot-1",
      set: {
        schemaVersion: "site-builder-copy-bundle-set/v1",
        sourceLocale: "en",
        bundles: {},
      },
      degradedLocales: [],
      taskAttemptIds: {},
    };
  },
  assembleQualityCandidate: async (input: Record<string, unknown>) =>
    candidate(input),
  evaluateQualityCandidate: async (
    input: Record<string, unknown> & {
      round: 0 | 1 | 2 | 3;
      qualityCandidate: ReturnType<typeof candidate>;
    },
  ) => {
    const workflowId =
      ActivityContext.current().info.workflowExecution.workflowId;
    const current = state(workflowId);
    current.evaluationStarted = true;
    current.evaluationCalls += 1;
    if (
      scenario(input) === "worker_restart" &&
      !current.workerRestartRequested
    ) {
      current.workerRestartRequested = true;
      throw new Error("injected worker restart before quality retry");
    }
    if (scenario(input) === "cancel_during_quality") {
      const signal = ActivityContext.current().cancellationSignal;
      await new Promise<never>((_resolve, reject) => {
        const rejectCancelled = () =>
          reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
        if (signal.aborted) rejectCancelled();
        signal.addEventListener("abort", rejectCancelled, { once: true });
      });
    }
    const passRound =
      scenario(input) === "round2_pass"
        ? 2
        : scenario(input) === "round3_fail"
          ? -1
          : 0;
    return {
      ...input.qualityCandidate,
      ...quality(
        input.round,
        input.qualityCandidate.candidate.specDigest,
        input.round === passRound,
      ),
    };
  },
  applyQualityRepair: async (
    input: Record<string, unknown> & {
      qualityEvaluation: { evaluation: { round: number } };
      qualityCandidate: ReturnType<typeof candidate>;
    },
  ) => {
    const nextRound = input.qualityEvaluation.evaluation.round + 1;
    return {
      ...candidate(
        input,
        String(nextRound + 1)
          .repeat(64)
          .slice(0, 64),
      ),
      repairCatalogDigest: String(nextRound).padStart(64, "f"),
      selectedRepairOptionId: `blueprint:home:safe-${nextRound}`,
      repairSelectionMode: "deterministic_fallback",
    };
  },
  materializeApprovedRelease: async (input: Record<string, unknown>) => {
    const workflowId =
      ActivityContext.current().info.workflowExecution.workflowId;
    const current = state(workflowId);
    current.materializeCalls += 1;
    current.releases = Math.max(current.releases, 1);
    if (
      scenario(input) === "round0_pass_ack_loss" &&
      current.materializeCalls === 1
    ) {
      throw new Error("injected materialize ACK loss");
    }
    return {
      build: {
        previewSlug: "m1f-verification",
        versionId: "version-1",
        designBrief: { digest: BRIEF_DIGEST },
      },
      artifactRefs: quality(0, "a".repeat(64), true).artifactRefs,
    };
  },
  finalizeRefurbish: async (input: Record<string, unknown>) => {
    const workflowId =
      ActivityContext.current().info.workflowExecution.workflowId;
    const current = state(workflowId);
    current.finalizeCalls += 1;
    if (scenario(input) === "pointer_conflict") {
      throw new Error("injected active pointer conflict");
    }
    current.activePointer = "new";
    return { previewSlug: "m1f-verification" };
  },
  compensateRefurbish: async (
    input: Record<string, unknown> & {
      terminalStatus: "failed" | "cancelled";
    },
  ) => {
    const workflowId =
      ActivityContext.current().info.workflowExecution.workflowId;
    state(workflowId).compensated = input.terminalStatus;
  },
};

const address = process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233";
const namespace = process.env.TEMPORAL_NAMESPACE ?? "default";
const taskQueue = `site-builder-m1f-verification-${randomUUID()}`;
const nativeConnection = await NativeConnection.connect({ address });
const clientConnection = await Connection.connect({ address });
const workerOptions = {
  connection: nativeConnection,
  namespace,
  taskQueue,
  workflowsPath: new URL("../src/temporal/workflows.ts", import.meta.url)
    .pathname,
  activities,
};
let worker = await Worker.create(workerOptions);
let workerRun = worker.run();
const client = new WorkflowClient({
  connection: clientConnection,
  namespace,
});

async function restartWorker(): Promise<void> {
  worker.shutdown();
  await workerRun;
  worker = await Worker.create(workerOptions);
  workerRun = worker.run();
}

async function execute(scenarioName: Scenario) {
  const workflowId = `m1f-${scenarioName}-${randomUUID()}`;
  const handle = await client.start(refurbishWorkflow, {
    workflowId,
    taskQueue,
    args: [
      {
        workspaceId: "00000000-0000-4000-8000-000000000001",
        siteId: "00000000-0000-4000-8000-000000000002",
        buildRunId: "00000000-0000-4000-8000-000000000003",
        verificationScenario: scenarioName,
      } as never,
    ],
  });
  if (scenarioName === "cancel_during_quality") {
    const deadline = Date.now() + 10_000;
    while (!state(workflowId).evaluationStarted) {
      if (Date.now() > deadline)
        throw new Error("cancel scenario did not start");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await handle.cancel();
  }
  if (scenarioName === "worker_restart") {
    const deadline = Date.now() + 10_000;
    while (!state(workflowId).workerRestartRequested) {
      if (Date.now() > deadline) {
        throw new Error("worker restart scenario did not reach quality");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await restartWorker();
  }
  let outcome: "completed" | "failed" | "cancelled" = "completed";
  try {
    await handle.result();
  } catch {
    outcome = scenarioName === "cancel_during_quality" ? "cancelled" : "failed";
  }
  return { workflowId, scenario: scenarioName, outcome, ...state(workflowId) };
}

try {
  const results = [];
  for (const scenarioName of [
    "round0_pass_ack_loss",
    "round2_pass",
    "round3_fail",
    "pointer_conflict",
    "worker_restart",
    "cancel_during_quality",
  ] as const) {
    results.push(await execute(scenarioName));
  }
  const byScenario = new Map(
    results.map((result) => [result.scenario, result]),
  );
  const ack = byScenario.get("round0_pass_ack_loss")!;
  const repair = byScenario.get("round2_pass")!;
  const failed = byScenario.get("round3_fail")!;
  const conflict = byScenario.get("pointer_conflict")!;
  const restarted = byScenario.get("worker_restart")!;
  const cancelled = byScenario.get("cancel_during_quality")!;
  if (
    ack.outcome !== "completed" ||
    ack.buildingVersions !== 1 ||
    ack.releases !== 1 ||
    ack.materializeCalls !== 2 ||
    ack.activePointer !== "new" ||
    ack.paidActivityCalls !== 3 ||
    repair.outcome !== "completed" ||
    repair.releases !== 1 ||
    repair.paidActivityCalls !== 3 ||
    failed.outcome !== "failed" ||
    failed.releases !== 0 ||
    failed.activePointer !== "old" ||
    failed.paidActivityCalls !== 3 ||
    conflict.outcome !== "failed" ||
    conflict.releases !== 1 ||
    conflict.activePointer !== "old" ||
    conflict.compensated !== "failed" ||
    conflict.paidActivityCalls !== 3 ||
    restarted.outcome !== "completed" ||
    restarted.releases !== 1 ||
    restarted.activePointer !== "new" ||
    restarted.evaluationCalls !== 2 ||
    !restarted.workerRestartRequested ||
    restarted.paidActivityCalls !== 3 ||
    cancelled.outcome !== "cancelled" ||
    cancelled.releases !== 0 ||
    cancelled.activePointer !== "old" ||
    cancelled.compensated !== "cancelled" ||
    cancelled.paidActivityCalls !== 3
  ) {
    throw new Error(
      `M1-f Temporal assertions failed: ${JSON.stringify(results)}`,
    );
  }
  console.log(
    JSON.stringify(
      {
        schemaVersion: "site-builder-m1f-temporal-verification/v1",
        temporalSdk: "1.20.3",
        address,
        namespace,
        taskQueue,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  worker.shutdown();
  await workerRun;
  await nativeConnection.close();
  await clientConnection.close();
}
