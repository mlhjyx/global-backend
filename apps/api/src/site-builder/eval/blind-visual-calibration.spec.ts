import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { assertModelOutputSchemaCompiles } from "../../model-gateway/schema-validate";
import {
  ProviderIdentityError,
  ProviderOutputError,
  TaskOutputValidationError,
} from "../../model-gateway/providers/provider-output-error";
import type { VisionReviewImage } from "../../model-gateway/types";
import {
  BLIND_VISUAL_CALIBRATION_HARNESS_VERSION,
  BLIND_VISUAL_CANDIDATES,
  BLIND_VISUAL_EXPECTED_RUNS,
  BLIND_VISUAL_MAX_COST_CENTS,
  BLIND_VISUAL_MAX_TOKENS,
  BLIND_VISUAL_MODEL_COST_BOUND_CENTS,
  BLIND_VISUAL_OUTPUT_SCHEMA,
  BLIND_VISUAL_TIMEOUT_MS,
  assertBlindVisualOutput,
  buildBlindVisualMatrixDefinition,
  buildBlindVisualPairPlans,
  buildBlindVisualProbePlan,
  loadBlindVisualPairs,
  runBlindVisualCalibrationCandidate,
  summarizeBlindVisualCandidate,
  summarizeBlindVisualEnsemble,
  type BlindVisualCallRecord,
  type BlindVisualCandidateConfig,
  type BlindVisualCandidateModel,
  type BlindVisualInvoke,
  type BlindVisualModelReport,
  type BlindVisualOutput,
  type BlindVisualPair,
  type BlindVisualPairDefinition,
  type BlindVisualProviderResult,
} from "./blind-visual-calibration";
import { classifyBlindVisualGatewayFailure } from "./blind-visual-calibration-gateway";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);

const PROVENANCE = {
  commitSha: "a".repeat(40),
  sourceBundleSha256: "b".repeat(64),
};

let pairs: BlindVisualPair[];
let matrixDefinition: BlindVisualPairDefinition[];

beforeAll(async () => {
  pairs = await loadBlindVisualPairs(repositoryRoot);
  matrixDefinition = buildBlindVisualMatrixDefinition(pairs);
});

function candidate(
  model: BlindVisualCandidateModel = "gpt-5.6-terra",
): BlindVisualCandidateConfig {
  return BLIND_VISUAL_CANDIDATES[model];
}

function degradedIndex(images: readonly VisionReviewImage[]): 1 | 2 | 3 {
  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    if (
      pairs.some(
        (pair) =>
          pair.degradedImage.sha256 === image.sha256 &&
          pair.sourceImage.sha256 !== image.sha256,
      )
    ) {
      return (index + 1) as 1 | 2 | 3;
    }
  }
  throw new Error("test could not identify degraded image");
}

function issueForImage(
  image: VisionReviewImage,
): BlindVisualPair["knownIssue"] {
  const pair = pairs.find(
    (candidate) => candidate.degradedImage.sha256 === image.sha256,
  );
  if (!pair) throw new Error("test could not identify known issue");
  return pair.knownIssue;
}

function successfulOutput(
  images: readonly VisionReviewImage[],
): BlindVisualOutput {
  if (images.length === 3) {
    return {
      choice: "tie",
      findings: [
        {
          ruleCode: issueForImage(images[2]),
          severity: "major",
          imageNumber: 3,
        },
      ],
    };
  }
  const imageNumber = degradedIndex(images);
  return {
    choice: imageNumber === 1 ? "left" : "right",
    findings: [
      {
        ruleCode: issueForImage(images[imageNumber - 1]),
        severity: "major",
        imageNumber,
      },
    ],
  };
}

function resultFor(
  request: Parameters<BlindVisualInvoke>[0],
  overrides: Partial<BlindVisualProviderResult> = {},
): BlindVisualProviderResult {
  return {
    data: successfulOutput(request.images),
    requestedModel: request.model,
    reportedModel: request.model,
    resolvedModel: request.model,
    provider: "gateway",
    transport: request.transport,
    elapsedMs: 1_000,
    usage: {
      inputTokens: 100,
      outputTokens: 30,
      costUsd: 0.001,
    },
    finishReason: "stop",
    truncated: false,
    ...overrides,
  };
}

function successfulInvoke(): BlindVisualInvoke {
  return vi.fn(async (request) => resultFor(request));
}

async function passingReport(
  model: BlindVisualCandidateModel = "gpt-5.6-terra",
): Promise<BlindVisualModelReport> {
  return runBlindVisualCalibrationCandidate({
    repositoryRoot,
    candidate: candidate(model),
    provenance: PROVENANCE,
    invoke: successfulInvoke(),
  });
}

function relabelReport(
  source: BlindVisualModelReport,
  model: BlindVisualCandidateModel,
): BlindVisualModelReport {
  const config = candidate(model);
  const reprice = (record: {
    inputTokens: number;
    outputTokens: number;
    reportedCostUsd: number | null;
  }) => {
    const calculatedCostUsd = Number(
      (
        (record.inputTokens * config.price.inputUsdPerMillionTokens +
          record.outputTokens * config.price.outputUsdPerMillionTokens) /
        1_000_000
      ).toFixed(8),
    );
    return {
      calculatedCostUsd,
      accountedCostUsd: Number(
        Math.max(calculatedCostUsd, record.reportedCostUsd ?? 0).toFixed(8),
      ),
    };
  };
  const runs = source.runs.map((run) => ({
    ...structuredClone(run),
    requestedModel: model,
    reportedModel: model,
    resolvedModel: model,
    transport: config.transport,
    ...reprice(run),
  }));
  const probe = source.probe
    ? {
        ...structuredClone(source.probe),
        requestedModel: model,
        reportedModel: model,
        resolvedModel: model,
        transport: config.transport,
        ...reprice(source.probe),
      }
    : null;
  return {
    ...structuredClone(source),
    model,
    upstreamModelFamily: config.upstreamModelFamily,
    transport: config.transport,
    probe,
    runs,
    metrics: summarizeBlindVisualCandidate(
      config,
      runs,
      probe!,
      source.matrixDefinition,
      matrixDefinition,
    ),
  };
}

function makeRunMiss(run: BlindVisualCallRecord): void {
  run.output = { choice: "tie", findings: [] };
  run.semanticChoice = "tie";
  run.canonicalFindings = [];
  run.knownIssueDetected = false;
}

describe("blind visual calibration fixture and invocation plans", () => {
  it("builds six same-breakpoint source/degradation pairs from deterministic render baselines", () => {
    expect(pairs).toHaveLength(6);
    expect(matrixDefinition).toHaveLength(6);
    expect(new Set(pairs.map((pair) => pair.familyId)).size).toBe(6);
    expect(new Set(pairs.map((pair) => pair.pairId)).size).toBe(6);
    for (const pair of pairs) {
      expect(pair.qualification).toBe("deterministic_render_baseline");
      expect(pair.sourceImage.target.breakpoint).toBe(pair.breakpoint);
      expect(pair.degradedImage.target.breakpoint).toBe(pair.breakpoint);
      expect(pair.sourceImage.sha256).not.toBe(pair.degradedImage.sha256);
      expect(pair.sourcePath).toMatch(
        /^apps\/site-renderer\/visual-tests\/__screenshots__\/m1-e-b\/(?:mobile-375|tablet-768|desktop-1440)\/[a-z-]+-rich\.png$/,
      );
    }
  });

  it("uses 18 two-image calls with deterministic fixed random left/right order", () => {
    const plans = buildBlindVisualPairPlans(candidate(), pairs);
    expect(plans).toHaveLength(BLIND_VISUAL_EXPECTED_RUNS);
    for (const pair of pairs) {
      const familyPlans = plans.filter(
        (plan) => plan.familyId === pair.familyId,
      );
      expect(familyPlans.map((plan) => plan.attempt)).toEqual([1, 2, 3]);
      expect(familyPlans[0].assignment).toEqual(familyPlans[2].assignment);
      expect(familyPlans[1].assignment).not.toEqual(familyPlans[0].assignment);
      expect(
        new Set(familyPlans.flatMap((plan) => Object.values(plan.assignment))),
      ).toEqual(new Set(["source", "degraded"]));
      for (const plan of familyPlans) {
        expect(plan.request.images).toHaveLength(2);
        expect(
          plan.request.images.map((image) => image.target.breakpoint),
        ).toEqual([pair.breakpoint, pair.breakpoint]);
      }
    }
  });

  it("uses one three-image probe with identical left/right images and a seeded third image", () => {
    const plan = buildBlindVisualProbePlan(candidate(), pairs);
    expect(plan.request.images).toHaveLength(3);
    expect(plan.request.images[0].sha256).toBe(plan.request.images[1].sha256);
    expect(plan.request.images[0].artifactId).not.toBe(
      plan.request.images[1].artifactId,
    );
    expect(plan.request.images[2].sha256).not.toBe(
      plan.request.images[0].sha256,
    );
  });

  it("does not leak source/degradation labels or family identity to model requests", () => {
    const plans = buildBlindVisualPairPlans(candidate(), pairs);
    for (const plan of plans) {
      const visible = [
        plan.request.opaqueRunId,
        plan.request.prompt,
        ...plan.request.images.flatMap((image) => [
          image.artifactId,
          image.target.pageId,
        ]),
      ].join("\n");
      expect(visible).not.toMatch(
        /\b(?:baseline|degraded|original|knownIssue|familyId)\b/i,
      );
      expect(visible).not.toContain(plan.familyId);
      expect(visible).not.toContain(plan.pairId);
    }
  });
});

describe("blind visual closed output", () => {
  it("compiles a minimal schema with no score, dimension, verdict, repair, or free text", () => {
    expect(() =>
      assertModelOutputSchemaCompiles(BLIND_VISUAL_OUTPUT_SCHEMA),
    ).not.toThrow();
    const accepted = {
      choice: "left",
      findings: [
        {
          ruleCode: "AESTHETIC_SPACING",
          severity: "major",
          imageNumber: 1,
        },
      ],
    };
    expect(assertBlindVisualOutput(accepted, 2)).toEqual(accepted);
    expect(Object.keys(BLIND_VISUAL_OUTPUT_SCHEMA.properties)).toEqual([
      "choice",
      "findings",
    ]);
  });

  it.each([
    ["overallScore", "top"],
    ["dimensions", "top"],
    ["verdict", "top"],
    ["passed", "top"],
    ["repair", "top"],
    ["freeText", "top"],
    ["message", "finding"],
    ["css", "finding"],
    ["suggestedPatch", "finding"],
  ])("rejects unknown or overreaching %s at %s level", (field, level) => {
    const value: Record<string, unknown> = {
      choice: "right",
      findings: [
        {
          ruleCode: "AESTHETIC_CONTRAST",
          severity: "major",
          imageNumber: 2,
        },
      ],
    };
    if (level === "top") value[field] = "forbidden";
    if (level === "finding") {
      (value.findings as Array<Record<string, unknown>>)[0][field] =
        "forbidden";
    }
    expect(() => assertBlindVisualOutput(value, 2)).toThrow(
      "BLIND_VISUAL_OUTPUT_INVALID",
    );
  });

  it("rejects wrong image numbers and more than four findings", () => {
    for (const imageNumber of [0, 3, 4, 1.5]) {
      expect(() =>
        assertBlindVisualOutput(
          {
            choice: "left",
            findings: [
              {
                ruleCode: "AESTHETIC_SPACING",
                severity: "major",
                imageNumber,
              },
            ],
          },
          2,
        ),
      ).toThrow("BLIND_VISUAL_OUTPUT_INVALID");
    }
    expect(() =>
      assertBlindVisualOutput(
        {
          choice: "tie",
          findings: Array.from({ length: 5 }, () => ({
            ruleCode: "AESTHETIC_SPACING",
            severity: "minor",
            imageNumber: 1,
          })),
        },
        2,
      ),
    ).toThrow("BLIND_VISUAL_OUTPUT_INVALID");
  });
});

describe("blind visual candidate runner", () => {
  it.each([
    [
      new ProviderOutputError(
        "VISION_REVIEW_FINISH_REASON_INVALID: incomplete",
      ),
      "truncated",
    ],
    [new ProviderOutputError("VISION_REVIEW_OUTPUT_TRUNCATED"), "truncated"],
    [new ProviderOutputError("VISION_REVIEW_SCHEMA_INVALID"), "schema_invalid"],
    [
      new TaskOutputValidationError("vision review hard gate rejected"),
      "schema_invalid",
    ],
    [
      new ProviderIdentityError("VISION_REVIEW_MODEL_IDENTITY_MISMATCH"),
      "model_identity_mismatch",
    ],
  ] as const)("classifies bounded gateway failure %s", (error, reason) => {
    expect(classifyBlindVisualGatewayFailure(error)).toBe(reason);
  });

  it("freezes the four candidates to 1 probe + 18 calls and the requested budgets", () => {
    expect(Object.keys(BLIND_VISUAL_CANDIDATES)).toEqual([
      "gemini-3.5-flash",
      "claude-sonnet-5",
      "gpt-5.6-terra",
      "gpt-5.6-sol",
    ]);
    for (const config of Object.values(BLIND_VISUAL_CANDIDATES)) {
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.price)).toBe(true);
      expect(config.timeoutMs).toBe(BLIND_VISUAL_TIMEOUT_MS);
      expect(config.maxTokens).toBe(BLIND_VISUAL_MAX_TOKENS);
      expect(config.maxCostCents).toBe(BLIND_VISUAL_MAX_COST_CENTS);
      expect(config.perModelCostBoundCents).toBe(
        BLIND_VISUAL_MODEL_COST_BOUND_CENTS,
      );
      expect((1 + BLIND_VISUAL_EXPECTED_RUNS) * config.maxCostCents).toBe(
        config.perModelCostBoundCents,
      );
    }
    expect(BLIND_VISUAL_CANDIDATES["gpt-5.6-terra"].upstreamModelFamily).toBe(
      BLIND_VISUAL_CANDIDATES["gpt-5.6-sol"].upstreamModelFamily,
    );
  });

  it("maps randomized left/right answers back to the degraded image and passes 18/18", async () => {
    const invoke = successfulInvoke();
    const report = await runBlindVisualCalibrationCandidate({
      repositoryRoot,
      candidate: candidate(),
      provenance: PROVENANCE,
      invoke,
    });
    expect(invoke).toHaveBeenCalledTimes(19);
    expect(report.status).toBe("single_model_gate_passed");
    expect(report.probe?.accepted).toBe(true);
    expect(report.runs).toHaveLength(18);
    expect(report.metrics).toMatchObject({
      actualRuns: 18,
      formatAndProvenanceCorrect: 18,
      knownIssueHits: 18,
      consistentFamilies: 6,
      passed: true,
    });
    expect(new Set(report.runs.map((run) => run.output.choice))).toEqual(
      new Set(["left", "right"]),
    );
    expect(
      report.runs.every(
        (run) =>
          run.semanticChoice === "degraded" &&
          run.canonicalFindings.some(
            (finding) => finding.imageRole === "degraded",
          ),
      ),
    ).toBe(true);
    expect(report.benchmarkQualification).toBe(
      "deterministic_render_baseline_not_aesthetic_gold",
    );
    expect(report.harnessVersion).toBe(
      BLIND_VISUAL_CALIBRATION_HARNESS_VERSION,
    );
  });

  it.each([
    ["requested", { requestedModel: "wrong-requested-model" }],
    ["reported", { reportedModel: "wrong-reported-model" }],
    ["resolved", { resolvedModel: "wrong-resolved-model" }],
  ] as const)(
    "fails closed on %s model identity mismatch and preserves actual provenance",
    async (_field, overrides) => {
      const invoke = vi.fn(async (request) => resultFor(request, overrides));
      const report = await runBlindVisualCalibrationCandidate({
        repositoryRoot,
        candidate: candidate(),
        provenance: PROVENANCE,
        invoke,
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(report).toMatchObject({
        status: "unavailable",
        unavailableReason: "model_identity_mismatch",
        failure: {
          expectedModel: "gpt-5.6-terra",
          requestedModel:
            "requestedModel" in overrides
              ? overrides.requestedModel
              : "gpt-5.6-terra",
          reportedModel:
            "reportedModel" in overrides
              ? overrides.reportedModel
              : "gpt-5.6-terra",
          resolvedModel:
            "resolvedModel" in overrides
              ? overrides.resolvedModel
              : "gpt-5.6-terra",
        },
      });
    },
  );

  it.each([
    [
      "protocol_mismatch",
      (request: Parameters<BlindVisualInvoke>[0]) =>
        resultFor(request, {
          transport:
            request.transport === "openai-responses"
              ? "anthropic-messages"
              : "openai-responses",
        }),
    ],
    [
      "timeout",
      (request: Parameters<BlindVisualInvoke>[0]) =>
        resultFor(request, { elapsedMs: BLIND_VISUAL_TIMEOUT_MS + 1 }),
    ],
    [
      "truncated",
      (request: Parameters<BlindVisualInvoke>[0]) =>
        resultFor(request, { truncated: true, finishReason: "max_tokens" }),
    ],
    [
      "schema_invalid",
      (request: Parameters<BlindVisualInvoke>[0]) =>
        resultFor(request, {
          data: {
            choice: "tie",
            findings: [],
            overallScore: 99,
          },
        }),
    ],
    [
      "provider_provenance_mismatch",
      (request: Parameters<BlindVisualInvoke>[0]) =>
        resultFor(request, { provider: "direct-upstream" }),
    ],
    [
      "cost_bound_exceeded",
      (request: Parameters<BlindVisualInvoke>[0]) =>
        resultFor(request, {
          usage: {
            inputTokens: 100,
            outputTokens: 30,
            costUsd: 0.0501,
          },
        }),
    ],
  ] as const)(
    "marks the model unavailable on %s and stops after the probe",
    async (reason, factory) => {
      const invoke = vi.fn(async (request) => factory(request));
      const report = await runBlindVisualCalibrationCandidate({
        repositoryRoot,
        candidate: candidate(),
        provenance: PROVENANCE,
        invoke,
      });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(report.status).toBe("unavailable");
      expect(report.unavailableReason).toBe(reason);
      expect(report.probe).toBeNull();
      expect(report.runs).toEqual([]);
      expect(report.failure).toMatchObject({
        phase: "probe",
        reason,
        expectedModel: "gpt-5.6-terra",
        inputImages: expect.arrayContaining([
          expect.objectContaining({ imageNumber: 1 }),
          expect.objectContaining({ imageNumber: 2 }),
          expect.objectContaining({ imageNumber: 3 }),
        ]),
      });
    },
  );

  it("marks an exception unavailable without inventing provider evidence", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });
    const report = await runBlindVisualCalibrationCandidate({
      repositoryRoot,
      candidate: candidate(),
      provenance: PROVENANCE,
      invoke,
    });
    expect(report).toMatchObject({
      status: "unavailable",
      unavailableReason: "invocation_failed",
      probe: null,
      runs: [],
      conclusion: "unavailable_no_model_selection_claim",
    });
    expect(report.failure).toMatchObject({
      phase: "probe",
      reason: "invocation_failed",
      reportedModel: null,
      outputSha256: null,
    });
  });

  it("retains safe provider failure provenance supplied by a local adapter", async () => {
    const invoke = vi.fn(async (request) =>
      resultFor(request, {
        data: null,
        failureReason: "truncated",
        reportedModel: request.model,
        resolvedModel: request.model,
        usage: {
          inputTokens: 321,
          outputTokens: 800,
          costUsd: null,
        },
        finishReason: "max_tokens",
        truncated: true,
      }),
    );
    const report = await runBlindVisualCalibrationCandidate({
      repositoryRoot,
      candidate: candidate(),
      provenance: PROVENANCE,
      invoke,
    });
    expect(report).toMatchObject({
      status: "unavailable",
      unavailableReason: "truncated",
      failure: {
        reason: "truncated",
        requestedModel: "gpt-5.6-terra",
        reportedModel: "gpt-5.6-terra",
        resolvedModel: "gpt-5.6-terra",
        provider: "gateway",
        inputTokens: 321,
        outputTokens: 800,
        finishReason: "max_tokens",
      },
    });
    expect(report.failure?.calculatedCostUsd).toBeGreaterThan(0);
  });

  it("aborts a hanging probe at the harness deadline and starts no pair calls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let observedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const invoke = vi.fn((request: Parameters<BlindVisualInvoke>[0]) => {
      observedSignal = request.signal;
      markStarted();
      return new Promise<BlindVisualProviderResult>(() => undefined);
    });
    try {
      const reportPromise = runBlindVisualCalibrationCandidate({
        repositoryRoot,
        candidate: candidate(),
        provenance: PROVENANCE,
        invoke,
      });
      await started;
      expect(observedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(BLIND_VISUAL_TIMEOUT_MS);
      const report = await reportPromise;
      expect(observedSignal?.aborted).toBe(true);
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(report).toMatchObject({
        status: "unavailable",
        unavailableReason: "timeout",
        probe: null,
        runs: [],
        failure: {
          phase: "probe",
          reason: "timeout",
          requestedModel: null,
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops an otherwise valid round when a matrix response truncates", async () => {
    let calls = 0;
    const invoke = vi.fn(async (request) => {
      calls += 1;
      return resultFor(
        request,
        calls === 3 ? { truncated: true, finishReason: "length" } : {},
      );
    });
    const report = await runBlindVisualCalibrationCandidate({
      repositoryRoot,
      candidate: candidate(),
      provenance: PROVENANCE,
      invoke,
    });
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(report.status).toBe("unavailable");
    expect(report.unavailableReason).toBe("truncated");
    expect(report.probe?.accepted).toBe(true);
    expect(report.runs).toHaveLength(1);
    expect(report.failure).toMatchObject({
      phase: "pair",
      reason: "truncated",
      reportedModel: "gpt-5.6-terra",
      actualTransport: "openai-responses",
      elapsedMs: 1_000,
      inputTokens: 100,
      outputTokens: 30,
    });
    expect(report.failure?.outputSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("server-side single and dual model aggregation", () => {
  it("requires 18/18 format/provenance, 17/18 known issues, and five stable families", async () => {
    const report = await passingReport();
    expect(report.metrics?.passed).toBe(true);

    const oneMiss = structuredClone(report.runs);
    makeRunMiss(oneMiss[0]);
    expect(
      summarizeBlindVisualCandidate(
        candidate(),
        oneMiss,
        report.probe!,
        report.matrixDefinition,
        matrixDefinition,
      ),
    ).toMatchObject({
      knownIssueHits: 17,
      consistentFamilies: 5,
      passed: true,
    });

    const twoMisses = structuredClone(oneMiss);
    makeRunMiss(twoMisses[1]);
    expect(
      summarizeBlindVisualCandidate(
        candidate(),
        twoMisses,
        report.probe!,
        report.matrixDefinition,
        matrixDefinition,
      ),
    ).toMatchObject({
      knownIssueHits: 16,
      passed: false,
    });

    const badProvenance = structuredClone(report.runs);
    (
      badProvenance[0] as BlindVisualCallRecord & {
        provenanceExact: boolean;
      }
    ).provenanceExact = false;
    expect(() =>
      summarizeBlindVisualCandidate(
        candidate(),
        badProvenance,
        report.probe!,
        report.matrixDefinition,
        matrixDefinition,
      ),
    ).toThrow("BLIND_VISUAL_STATS_RUN_INVALID");

    const exactBoundRuns = report.runs.map((run) => ({
      ...structuredClone(run),
      reportedCostUsd: 0.05,
      accountedCostUsd: 0.05,
    }));
    const exactBoundProbe = {
      ...structuredClone(report.probe!),
      reportedCostUsd: 0.05,
      accountedCostUsd: 0.05,
    };
    expect(
      summarizeBlindVisualCandidate(
        candidate(),
        exactBoundRuns,
        exactBoundProbe,
        report.matrixDefinition,
        matrixDefinition,
      ),
    ).toMatchObject({
      pairCostUsd: 0.9,
      probeCostUsd: 0.05,
      totalCostUsd: 0.95,
      passed: true,
    });

    const overBoundProbe = {
      ...structuredClone(report.probe!),
      reportedCostUsd: 0.06,
      accountedCostUsd: 0.06,
    };
    expect(() =>
      summarizeBlindVisualCandidate(
        candidate(),
        report.runs,
        overBoundProbe,
        report.matrixDefinition,
        matrixDefinition,
      ),
    ).toThrow("BLIND_VISUAL_STATS_PROBE_INVALID");
  });

  it("rejects duplicate run keys instead of inflating statistics", async () => {
    const report = await passingReport();
    const duplicate = [...report.runs, structuredClone(report.runs[0])];
    expect(() =>
      summarizeBlindVisualCandidate(
        candidate(),
        duplicate,
        report.probe!,
        report.matrixDefinition,
        matrixDefinition,
      ),
    ).toThrow("BLIND_VISUAL_STATS_DUPLICATE_RUN");

    const corruptReport = structuredClone(report);
    corruptReport.runs.push(structuredClone(corruptReport.runs[0]));
    expect(() =>
      summarizeBlindVisualEnsemble([corruptReport], matrixDefinition),
    ).toThrow("BLIND_VISUAL_STATS_DUPLICATE_RUN");
  });

  it("recomputes run semantics from the frozen matrix instead of trusting derived fields", async () => {
    const report = await passingReport();

    const derivedTamper = structuredClone(report.runs);
    derivedTamper[0].output = { choice: "tie", findings: [] };
    expect(() =>
      summarizeBlindVisualCandidate(
        candidate(),
        derivedTamper,
        report.probe!,
        report.matrixDefinition,
        matrixDefinition,
      ),
    ).toThrow("BLIND_VISUAL_STATS_DERIVED_MISMATCH");

    const imageTamper = structuredClone(report.runs);
    imageTamper[0].inputImages[0].sha256 = "f".repeat(64);
    expect(() =>
      summarizeBlindVisualCandidate(
        candidate(),
        imageTamper,
        report.probe!,
        report.matrixDefinition,
        matrixDefinition,
      ),
    ).toThrow("BLIND_VISUAL_STATS_RUN_INVALID");

    expect(() =>
      summarizeBlindVisualCandidate(
        candidate(),
        report.runs.slice(1),
        report.probe!,
        report.matrixDefinition,
        matrixDefinition,
      ),
    ).toThrow("BLIND_VISUAL_STATS_MATRIX_INCOMPLETE");

    const selfConsistentButUntrusted = structuredClone(report.matrixDefinition);
    selfConsistentButUntrusted[0].knownIssue =
      selfConsistentButUntrusted[0].knownIssue === "AESTHETIC_ORIGINALITY"
        ? "AESTHETIC_SPACING"
        : "AESTHETIC_ORIGINALITY";
    expect(() =>
      summarizeBlindVisualCandidate(
        candidate(),
        report.runs,
        report.probe!,
        selfConsistentButUntrusted,
        matrixDefinition,
      ),
    ).toThrow("BLIND_VISUAL_STATS_MATRIX_PROVENANCE_MISMATCH");
  });

  it("computes ranking P95 across the probe and all 18 pair calls", async () => {
    const report = await passingReport();
    const slowProbe = {
      ...structuredClone(report.probe!),
      elapsedMs: 119_000,
    };
    expect(
      summarizeBlindVisualCandidate(
        candidate(),
        report.runs,
        slowProbe,
        report.matrixDefinition,
        matrixDefinition,
      ),
    ).toMatchObject({
      pairP95ElapsedMs: 1_000,
      p95ElapsedMs: 119_000,
    });
  });

  it("ranks by correctness, stability, P95, cost, then model and skips the same upstream family", async () => {
    const terra = await passingReport("gpt-5.6-terra");
    const sol = relabelReport(terra, "gpt-5.6-sol");
    const sonnet = relabelReport(terra, "claude-sonnet-5");
    sol.metrics = {
      ...sol.metrics!,
      p95ElapsedMs: 900,
    };
    sol.runs = sol.runs.map((run) => ({ ...run, elapsedMs: 900 }));
    sol.probe = { ...sol.probe!, elapsedMs: 900 };
    sol.metrics = summarizeBlindVisualCandidate(
      candidate("gpt-5.6-sol"),
      sol.runs,
      sol.probe!,
      sol.matrixDefinition,
      matrixDefinition,
    );
    sonnet.runs = sonnet.runs.map((run) => ({
      ...run,
      elapsedMs: 1_100,
    }));
    sonnet.metrics = summarizeBlindVisualCandidate(
      candidate("claude-sonnet-5"),
      sonnet.runs,
      sonnet.probe!,
      sonnet.matrixDefinition,
      matrixDefinition,
    );

    const summary = summarizeBlindVisualEnsemble(
      [sonnet, sol, terra],
      matrixDefinition,
    );
    expect(summary.rankedPassingModels).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "claude-sonnet-5",
    ]);
    expect(summary.combination).toMatchObject({
      models: ["gpt-5.6-sol", "claude-sonnet-5"],
      upstreamModelFamilies: ["gpt-5.6", "claude"],
      commonKnownIssueHits: 18,
      passed: true,
      conclusion: "eligible_for_aesthetic_gold_calibration",
    });
  });

  it("requires at least 17/18 shared correct code-and-location hits", async () => {
    const terra = await passingReport("gpt-5.6-terra");
    const sonnet = relabelReport(terra, "claude-sonnet-5");
    makeRunMiss(terra.runs[0]);
    makeRunMiss(sonnet.runs[1]);
    terra.metrics = summarizeBlindVisualCandidate(
      candidate("gpt-5.6-terra"),
      terra.runs,
      terra.probe!,
      terra.matrixDefinition,
      matrixDefinition,
    );
    sonnet.metrics = summarizeBlindVisualCandidate(
      candidate("claude-sonnet-5"),
      sonnet.runs,
      sonnet.probe!,
      sonnet.matrixDefinition,
      matrixDefinition,
    );
    const summary = summarizeBlindVisualEnsemble(
      [terra, sonnet],
      matrixDefinition,
    );
    expect(summary.combination).toMatchObject({
      commonKnownIssueHits: 16,
      passed: false,
      conclusion: "dual_model_common_hit_gate_failed",
    });
  });

  it("refuses to combine passing reports from different source bundles or commits", async () => {
    const terra = await passingReport("gpt-5.6-terra");
    const sonnet = relabelReport(terra, "claude-sonnet-5");

    const differentSource = structuredClone(sonnet);
    differentSource.provenance.sourceBundleSha256 = "c".repeat(64);
    expect(() =>
      summarizeBlindVisualEnsemble([terra, differentSource], matrixDefinition),
    ).toThrow("BLIND_VISUAL_STATS_INCOMPATIBLE_REPORTS");

    const differentCommit = structuredClone(sonnet);
    differentCommit.provenance.commitSha = "d".repeat(40);
    expect(() =>
      summarizeBlindVisualEnsemble([terra, differentCommit], matrixDefinition),
    ).toThrow("BLIND_VISUAL_STATS_INCOMPATIBLE_REPORTS");
  });

  it("rejects report protocol and harness envelope mismatches before ranking", async () => {
    const report = await passingReport();
    const wrongProtocol = structuredClone(report);
    wrongProtocol.runs[0].transport = "anthropic-messages";
    expect(() =>
      summarizeBlindVisualEnsemble([wrongProtocol], matrixDefinition),
    ).toThrow("BLIND_VISUAL_STATS_MODEL_PROTOCOL_MISMATCH");

    const wrongHarness = structuredClone(report);
    (
      wrongHarness as BlindVisualModelReport & {
        harnessVersion: string;
      }
    ).harnessVersion = "tampered";
    expect(() =>
      summarizeBlindVisualEnsemble([wrongHarness], matrixDefinition),
    ).toThrow("BLIND_VISUAL_STATS_REPORT_ENVELOPE_INVALID");
  });

  it("produces no combination when two passing models are unavailable or from the same upstream family", async () => {
    const terra = await passingReport("gpt-5.6-terra");
    const sol = relabelReport(terra, "gpt-5.6-sol");
    expect(
      summarizeBlindVisualEnsemble([terra, sol], matrixDefinition).combination,
    ).toBeNull();

    const unavailable = relabelReport(terra, "claude-sonnet-5");
    unavailable.status = "unavailable";
    unavailable.metrics = null;
    unavailable.unavailableReason = "timeout";
    unavailable.conclusion = "unavailable_no_model_selection_claim";
    expect(
      summarizeBlindVisualEnsemble([terra, unavailable], matrixDefinition)
        .combination,
    ).toBeNull();
  });
});
