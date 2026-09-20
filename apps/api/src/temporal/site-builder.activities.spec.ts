import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Context as ActivityContext } from "@temporalio/activity";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import {
  createSiteBuilderActivities as createSiteBuilderActivitiesRaw,
  buildCompensatedSteps,
  controlledAssemblyEffectiveBrief,
  durableCopyTaskCompletion,
  intakeToMarkdown,
  neutralCopyOutput,
  previewBasePath,
  previewOrigin,
  qualitySettlementIsPublishable,
  qualityNarrativePaidGateDecision,
  releaseTaskWithoutMaskingPrimaryFailure,
  runBrandProfilePersistenceWithRetry,
  runNonAuthoritativeQualityNarrative,
  RefurbishActivityInput,
  RefurbishFinalizeInput,
  type RefurbishQualityCandidateInput,
} from "./site-builder.activities";
import { Logger } from "@nestjs/common";
import { ControlledAssemblyService } from "../site-builder/assembly/controlled-assembly.service";
import * as ControlledAssets from "../site-builder/controlled-build-assets";
import * as AssetMaterializer from "../site-builder/controlled-asset-materializer";
import { releaseSpecDigest } from "../site-builder/release-artifact";
import { buildM1ebGoldenAssemblyInputs, buildM1ebGoldenFixtures } from "../site-builder/design/m1eb-golden";
import { PublishableClaimSnapshotService } from "../site-builder/publishable-claim-snapshot.service";
import { PrismaPublishableClaimSnapshotRepository } from "../site-builder/publishable-claim-snapshot.prisma";
import { COPY_GENERATION_CONTRACT_VERSION, buildCopyGenerationContext, copyGenerationContextDigest } from "../site-builder/copy-bundle.service";
import * as AiTasks from "../site-builder/agents/ai-task";
import { DesignBriefProducer } from "../site-builder/design/design-brief-producer";
import type { CopySlotDefinition } from "../site-builder/copy-bundle.service";
import { buildDemoSpec, DEMO_SPEC_VERSION } from "../site-builder/demo-spec";

/**
 * M1-b fast-follow 改动 1（预算门接线）+ 改动 3（补偿路径 steps 回填）。
 * - 预算门：begin 认领成功后 close-then-open（清跨-retry 残留，镜像 discovery resetRunBudget）；
 *   finalize/compensate 各在末尾 force close。open/close 只能在活动里（worker 进程持有 ledger 单例）。
 * - steps 回填：compensate 转 failed 时按 brandProfile / siteVersion DB 探测补 brand_profile、
 *   assemble_build done/aborted，其余步骤 aborted（只报 DB 可核验的完成位）。
 */

const INPUT: RefurbishActivityInput = {
  workspaceId: "ws-1",
  siteId: "site-1",
  buildRunId: "run-1",
};

const REFURBISH_KEYS = [
  "kb_ingest",
  "brand_profile",
  "image_pipeline",
  "design_spec",
  "copy",
  "assemble_build",
  "quality_loop",
];

const PENDING_STEPS = [
  { key: "kb_ingest", status: "pending" },
  { key: "brand_profile", status: "pending" },
  { key: "image_pipeline", status: "pending_m1c" },
  { key: "design_spec", status: "pending_m1eb" },
  { key: "copy", status: "pending_m1d" },
  { key: "assemble_build", status: "pending" },
  { key: "quality_loop", status: "pending_m1f" },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fakePrisma(tx: any): PrismaService {
  const client = { $executeRaw: vi.fn(async () => 0), ...tx };
  return {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: unknown) => unknown) =>
      fn(client),
    ),
  } as unknown as PrismaService;
}

function createSiteBuilderActivities(
  deps: Parameters<typeof createSiteBuilderActivitiesRaw>[0],
) {
  return createSiteBuilderActivitiesRaw({
    ...deps,
    rendererBuildIdentity:
      deps.rendererBuildIdentity ?? "site-renderer@test-sha256",
    costLedger:
      deps.costLedger ??
      ({
        assertAuthorizedBudget: vi.fn(async () => undefined),
        closeAndSummarize: vi.fn(async () => undefined),
      } as never),
  });
}

function spyBudget() {
  const close = vi.fn();
  return {
    open: vi.fn(),
    close,
    costLedger: {
      assertAuthorizedBudget: vi.fn(async () => undefined),
      closeAndSummarize: vi.fn(async (input: { buildRunId: string }) => {
        close(input.buildRunId, { force: true });
        return undefined;
      }),
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("site build cost reconciliation sweep", () => {
  it("enumerates bounded tenant workspaces and appends due observations without another model call", async () => {
    const queryRaw = vi.fn(async () => [
      {
        workspaceId: "00000000-0000-4000-8000-000000000001",
        lastAttempt: new Date("2026-08-18T00:00:00.000Z"),
      },
      {
        workspaceId: "00000000-0000-4000-8000-000000000002",
        lastAttempt: null,
      },
    ]);
    const runReconciliationSweep = vi
      .fn()
      .mockResolvedValueOnce({ attempted: 2, resolved: 0 })
      .mockResolvedValueOnce({ attempted: 1, resolved: 0 });
    const gateway = { generateText: vi.fn() };
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({}),
      ownerDb: { $queryRaw: queryRaw } as unknown as PrismaClient,
      gateway: gateway as never,
      costLedger: {
        assertAuthorizedBudget: vi.fn(async () => undefined),
        closeAndSummarize: vi.fn(async () => undefined),
        runReconciliationSweep,
      } as never,
    });

    const result = await acts.sweepSiteBuildCostReconciliation({ limit: 500 });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    const fairQuery = queryRaw.mock.calls[0]?.[0] as {
      strings: readonly string[];
      values: readonly unknown[];
    };
    const fairSql = fairQuery.strings.join(" ");
    // 公平轮转：按工作区最近一次被尝试时间升序（从未尝试者优先），
    // 避免 `workspace_id ASC` 让 UUID 靠后的租户永久饥饿。
    expect(fairSql).toContain("NULLS FIRST");
    expect(fairSql).toContain("site_build_spend_reconciliation");
    expect(fairSql).toContain("s.status = 'RESERVED'");
    expect(fairSql).toContain("s.status = 'FAILED'");
    expect(fairSql).toContain(
      "s.error_code = 'MODEL_OUTPUT_UNAVAILABLE_AFTER_RECOVERY'",
    );
    expect(fairSql).toContain("s.status = 'RELEASED'");
    expect(fairSql).toContain("s.error_code = 'MODEL_WIRE_NOT_DISPATCHED'");
    expect(fairSql).toContain(
      "s.cost_basis IN ('estimated_upper_bound', 'unknown')",
    );
    expect(fairSql).toContain(
      "'OBSERVED', 'UNKNOWN', 'NOT_DISPATCHED'",
    );
    expect(fairSql).toContain("w.state = 'DISPATCH_STARTED'");
    expect(fairSql).toContain("interval '1 millisecond'");
    expect(fairSql).toContain("w.state = 'ALLOCATED'");
    expect(fairSql).toContain("interval '24 hours'");
    expect(fairSql).not.toContain("wr.wire_attempt_id = w.id");
    expect(fairQuery.values).toEqual([600_000, 10]);
    expect(runReconciliationSweep).toHaveBeenCalledTimes(2);
    expect(runReconciliationSweep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        workspaceId: "00000000-0000-4000-8000-000000000001",
        limit: 1,
        resolve: expect.any(Function),
      }),
    );
    expect(gateway.generateText).not.toHaveBeenCalled();
    expect(result).toEqual({
      workspaces: 2,
      attempted: 3,
      resolved: 0,
      nextCursor: {
        lastAttempt: null,
        workspaceId: "00000000-0000-4000-8000-000000000002",
      },
    });
  });

  it("fails closed when the owner scan or durable ledger is unavailable", async () => {
    const noOwner = createSiteBuilderActivities({ prisma: fakePrisma({}) });
    await expect(
      noOwner.sweepSiteBuildCostReconciliation({ limit: 10 }),
    ).rejects.toThrow("SITE_BUILD_RECONCILIATION_UNAVAILABLE");
  });

  it("uses the injected request-bound resolver for due candidates", async () => {
    const resolve = vi.fn(async () => ({
      status: "RESOLVED" as const,
      resolverId: "new-api-request-bound-reconciliation-v1",
      requestId: "req-cost-reconcile-001",
      receiptDigest: "a".repeat(64),
      costBasis: "token_pricing" as const,
      exactCostMicrousd: "540",
      observedAt: new Date(),
    }));
    const runReconciliationSweep = vi.fn(
      async (input: {
        resolve: (candidate: {
          spendId: string;
          operationKey: string;
          meta: Record<string, unknown> | null;
        }) => Promise<{ status: string }>;
      }) => {
        const observation = await input.resolve({
          spendId: "spend-1",
          operationKey: "b".repeat(64),
          meta: { settlementPreflight: {} },
        });
        return {
          attempted: 1,
          resolved: observation.status === "RESOLVED" ? 1 : 0,
        };
      },
    );
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({}),
      ownerDb: {
        $queryRaw: vi.fn(async () => [
          { workspaceId: "00000000-0000-4000-8000-000000000001" },
        ]),
      } as unknown as PrismaClient,
      costReconciliationResolver: { resolve },
      costLedger: {
        assertAuthorizedBudget: vi.fn(async () => undefined),
        closeAndSummarize: vi.fn(async () => undefined),
        runReconciliationSweep,
      } as never,
    });

    await expect(
      acts.sweepSiteBuildCostReconciliation({ limit: 10 }),
    ).resolves.toEqual({
      workspaces: 1,
      attempted: 1,
      resolved: 1,
      nextCursor: {
        lastAttempt: null,
        workspaceId: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(resolve).toHaveBeenCalledWith(
      expect.objectContaining({ spendId: "spend-1" }),
    );
  });

  it("accepts cursor input and returns the next keyset cursor", async () => {
    const queryRaw = vi.fn(async () => [
      {
        workspaceId: "00000000-0000-4000-8000-000000000002",
        lastAttempt: null,
      },
    ]);
    const runReconciliationSweep = vi.fn(async () => ({
      attempted: 1,
      resolved: 1,
    }));
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({}),
      ownerDb: { $queryRaw: queryRaw } as unknown as PrismaClient,
      costLedger: {
        assertAuthorizedBudget: vi.fn(async () => undefined),
        closeAndSummarize: vi.fn(async () => undefined),
        runReconciliationSweep,
      } as never,
    });

    const first = await acts.sweepSiteBuildCostReconciliation({
      limit: 1,
      cursor: {
        lastAttempt: "2026-08-18T01:00:00.000Z",
        workspaceId: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(first).toEqual({
      workspaces: 1,
      attempted: 1,
      resolved: 1,
      nextCursor: {
        workspaceId: "00000000-0000-4000-8000-000000000002",
        lastAttempt: null,
      },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(runReconciliationSweep).toHaveBeenCalledTimes(1);
    const queryWithCursor = queryRaw.mock.calls[0]?.[0] as {
      strings: readonly string[];
      values: readonly unknown[];
    };
    expect(queryWithCursor.strings.join(" ")).toContain("COALESCE");
  });

  it("rejects malformed cursor input", async () => {
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({}),
      ownerDb: {
        $queryRaw: vi.fn(async () => []),
      } as unknown as PrismaClient,
      costLedger: {
        assertAuthorizedBudget: vi.fn(async () => undefined),
        closeAndSummarize: vi.fn(async () => undefined),
        runReconciliationSweep: vi.fn(async () => ({
          attempted: 0,
          resolved: 0,
        })),
      } as never,
    });
    await expect(
      acts.sweepSiteBuildCostReconciliation({
        limit: 10,
        cursor: { workspaceId: "not-a-uuid", lastAttempt: "bad-time" },
      } as never),
    ).rejects.toThrow("SITE_BUILD_RECONCILIATION_CURSOR_INVALID");
  });
});

describe("M1-g non-authoritative quality narrative failure boundaries", () => {
  it("does not authorize a narrative dispatch while any spend is unresolved", () => {
    expect(
      qualityNarrativePaidGateDecision({
        paidCallsEnabled: true,
        unresolvedSpends: 1,
      }),
    ).toBe("prior_settlement_unknown");
    expect(
      qualityNarrativePaidGateDecision({
        paidCallsEnabled: true,
        unresolvedSpends: 0,
      }),
    ).toBe("allowed");
    expect(
      qualityNarrativePaidGateDecision({
        paidCallsEnabled: false,
        unresolvedSpends: 0,
      }),
    ).toBe("paid_gate_denied");
  });

  it("omits a failed private sidecar without changing the deterministic activity result", async () => {
    const failure = new Error("transient object storage failure");
    const observed = vi.fn();
    await expect(
      runNonAuthoritativeQualityNarrative(
        async () => {
          throw failure;
        },
        undefined,
        observed,
      ),
    ).resolves.toBeUndefined();
    expect(observed).toHaveBeenCalledWith(failure);
  });

  it("keeps cancellation terminal instead of downgrading it to an omitted sidecar", async () => {
    const controller = new AbortController();
    const cancellation = new Error("activity cancelled");
    controller.abort(cancellation);
    await expect(
      runNonAuthoritativeQualityNarrative(async () => {
        throw new Error("storage aborted");
      }, controller.signal),
    ).rejects.toBe(cancellation);
  });

  it("preserves the paid settlement error when task release also fails", async () => {
    const releaseFailure = new Error("lease release failed");
    const observed = vi.fn();
    await expect(
      releaseTaskWithoutMaskingPrimaryFailure(
        async () => {
          throw releaseFailure;
        },
        true,
        observed,
      ),
    ).resolves.toBeUndefined();
    expect(observed).toHaveBeenCalledWith(releaseFailure);
  });

  it("still surfaces a standalone task-release failure", async () => {
    const releaseFailure = new Error("lease release failed");
    await expect(
      releaseTaskWithoutMaskingPrimaryFailure(async () => {
        throw releaseFailure;
      }, false),
    ).rejects.toBe(releaseFailure);
  });
});

describe("neutralCopyOutput — M1-d empty fact snapshot", () => {
  const slots: CopySlotDefinition[] = [
    {
      key: "home.hero.headline",
      type: "plain",
      required: true,
      factual: true,
      maxGraphemes: 80,
    },
    {
      key: "home.hero.cta",
      type: "cta",
      required: true,
      factual: false,
      maxGraphemes: 30,
    },
  ];

  it("emits deterministic neutral copy without Claim refs for every launch locale", () => {
    expect(neutralCopyOutput(slots, "en")).toEqual({
      slots: {
        "home.hero.headline": {
          content: "Practical solutions",
          claimRefs: [],
        },
        "home.hero.cta": { content: "Get in touch", claimRefs: [] },
      },
    });
    expect(neutralCopyOutput(slots, "de-DE")).toEqual({
      slots: {
        "home.hero.headline": {
          content: "Praktische Lösungen",
          claimRefs: [],
        },
        "home.hero.cta": { content: "Kontakt aufnehmen", claimRefs: [] },
      },
    });
  });

  it("validates the complete locale bundle before marking its task attempt succeeded", async () => {
    const source = await readFile(
      new URL("./site-builder.activities.ts", import.meta.url),
      "utf8",
    );
    const activity = source.indexOf("async generateCopyBundles(");
    const validation = source.indexOf(
      "await new CopyBundleService(generator).generate",
      activity,
    );
    const completion = source.indexOf(
      "await costLedger.completeTask",
      activity,
    );

    expect(activity).toBeGreaterThanOrEqual(0);
    expect(validation).toBeGreaterThan(activity);
    expect(completion).toBeGreaterThan(validation);
  });

  it("persists rich-text Copy output in the original task wire shape", () => {
    const durable = durableCopyTaskCompletion({
      taskAttemptId: "attempt-copy-en",
      contextDigest: "a".repeat(64),
      taskOutput: {
        slots: {
          "home.about.body": {
            content: "Engineering details for confident decisions",
            claimRefs: [],
          },
        },
      },
    });

    expect(durable.storedOutput.slots["home.about.body"]!.content).toBe(
      "Engineering details for confident decisions",
    );
    expect(durable.completionResult.slots["home.about.body"]!.content).toBe(
      "Engineering details for confident decisions",
    );
    expect(durable.storedOutput).not.toBe(durable.completionResult);
  });

  it("rejects a canonical rich-text AST at the durable replay boundary", () => {
    expect(() =>
      durableCopyTaskCompletion({
        taskAttemptId: "attempt-copy-en",
        contextDigest: "a".repeat(64),
        taskOutput: {
          slots: {
            "home.about.body": {
              content: {
                type: "doc",
                content: [],
              },
              claimRefs: [],
            },
          },
        },
      }),
    ).toThrow("COPY_DURABLE_REPLAY_WIRE_SHAPE_INVALID");
  });

  it("freezes Copy v2 context and reuses partial-build copy without a model call", async () => {
    const source = await readFile(
      new URL("./site-builder.activities.ts", import.meta.url),
      "utf8",
    );
    const activity = source.indexOf("async generateCopyBundles(");
    const brandTone = source.indexOf(
      "select: { id: true, version: true, tone: true }",
      activity,
    );
    const partialReuse = source.indexOf("if (baseCopySet)", activity);
    const gatewayGuard = source.indexOf(
      'if (!gateway) throw new Error("copy: model gateway unavailable")',
      activity,
    );
    const contextDigest = source.indexOf(
      "copyGenerationContextDigest(context)",
      activity,
    );
    const freeze = source.indexOf("costLedger.freezeTaskInput", activity);
    const contractMismatch = source.indexOf(
      'throw new Error("COPY_FROZEN_INPUT_CONTRACT_MISMATCH")',
      activity,
    );
    const versionedTaskKey = source.indexOf(
      "`${COPY_TASK.id}:${COPY_GENERATION_CONTRACT_VERSION}:${locale}`",
      activity,
    );
    const activityEnd = source.indexOf(
      "async assembleQualityCandidate(",
      activity,
    );

    expect(brandTone).toBeGreaterThan(activity);
    expect(partialReuse).toBeGreaterThan(brandTone);
    expect(gatewayGuard).toBeGreaterThan(partialReuse);
    expect(contextDigest).toBeGreaterThan(gatewayGuard);
    expect(freeze).toBeGreaterThan(contextDigest);
    expect(contractMismatch).toBeGreaterThan(freeze);
    expect(versionedTaskKey).toBeGreaterThan(contextDigest);
    expect(source.slice(activity, activityEnd)).not.toContain(
      "snapshot.items.length === 0",
    );
  });
});

describe("runBrandProfilePersistenceWithRetry", () => {
  it("retries a deadlocked P2034 transaction and preserves the P2002 retry path", async () => {
    const deadlock = new Prisma.PrismaClientKnownRequestError("deadlock", {
      code: "P2034",
      clientVersion: "test",
    });
    const uniqueClash = new Prisma.PrismaClientKnownRequestError("unique", {
      code: "P2002",
      clientVersion: "test",
    });
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(deadlock)
      .mockRejectedValueOnce(uniqueClash)
      .mockResolvedValueOnce("persisted");

    await expect(runBrandProfilePersistenceWithRetry(operation)).resolves.toBe(
      "persisted",
    );
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("bounds repeated P2034 retries and rethrows the final database error", async () => {
    const deadlock = new Prisma.PrismaClientKnownRequestError("deadlock", {
      code: "P2034",
      clientVersion: "test",
    });
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(deadlock);

    await expect(
      runBrandProfilePersistenceWithRetry(operation, 3),
    ).rejects.toBe(deadlock);
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("does not retry an unrelated persistence failure", async () => {
    const failure = new Error("validation failed");
    const operation = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(runBrandProfilePersistenceWithRetry(operation)).rejects.toBe(
      failure,
    );
    expect(operation).toHaveBeenCalledOnce();
  });
});

describe("controlledAssemblyEffectiveBrief", () => {
  const requested = {
    familyId: "oem-capability",
    stylePresetId: "oem-industrial-power",
    digest: "a".repeat(64),
  } as never;
  const fallback = {
    familyId: "oem-capability",
    stylePresetId: "oem-industrial-power",
    digest: "b".repeat(64),
  } as never;

  it("uses the same-family fallback Brief for a full build", () => {
    expect(
      controlledAssemblyEffectiveBrief(
        requested,
        fallback,
        "oem-capability",
        false,
      ),
    ).toBe(fallback);
  });

  it("keeps a partial build pinned to its frozen base Brief", () => {
    expect(() =>
      controlledAssemblyEffectiveBrief(
        requested,
        fallback,
        "oem-capability",
        true,
      ),
    ).toThrow("PARTIAL_BUILD_DESIGN_BRIEF_DRIFT");
  });
});

describe("processKbAsset — Temporal heartbeat/cancellation", () => {
  it("worker Activity context 的取消信号与阶段 heartbeat 会传入单素材处理器", async () => {
    const controller = new AbortController();
    const heartbeat = vi.fn();
    vi.spyOn(ActivityContext, "current").mockReturnValue({
      heartbeat,
      cancellationSignal: controller.signal,
    } as never);
    const processAsset = vi.fn(async (...args: unknown[]) => {
      const options = args[3] as {
        signal?: AbortSignal;
        heartbeat?: (stage: string) => void;
      };
      expect(options.signal).toBe(controller.signal);
      options.heartbeat?.("parsed");
      return { assetId: "asset-1", outcome: "ready" as const };
    });
    const acts = createSiteBuilderActivities({
      prisma: {} as PrismaService,
      kb: {
        ingestText: vi.fn() as never,
        processQueued: vi.fn() as never,
        processAsset: processAsset as never,
      },
    });

    await expect(
      acts.processKbAsset({
        workspaceId: "ws-1",
        siteId: "site-1",
        assetId: "asset-1",
      }),
    ).resolves.toMatchObject({ outcome: "ready" });

    expect(heartbeat).toHaveBeenCalledWith({
      assetId: "asset-1",
      stage: "claim",
    });
    expect(heartbeat).toHaveBeenCalledWith({
      assetId: "asset-1",
      stage: "parsed",
    });
  });

  it("refurbish ingestPendingKb 同样把 Activity 取消信号传给站点队列处理器", async () => {
    const controller = new AbortController();
    const heartbeat = vi.fn();
    vi.spyOn(ActivityContext, "current").mockReturnValue({
      heartbeat,
      cancellationSignal: controller.signal,
    } as never);
    const processQueued = vi.fn(async (...args: unknown[]) => {
      const options = args[2] as {
        signal?: AbortSignal;
        heartbeat?: (stage: string) => void;
      };
      expect(options.signal).toBe(controller.signal);
      options.heartbeat?.("queued:asset-1");
      return { processed: 1, failed: 0 };
    });
    const acts = createSiteBuilderActivities({
      prisma: {} as PrismaService,
      kb: {
        ingestText: vi.fn() as never,
        processQueued: processQueued as never,
        processAsset: vi.fn() as never,
      },
    });

    await expect(acts.ingestPendingKb(INPUT)).resolves.toEqual({
      processed: 1,
      failed: 0,
    });
    expect(heartbeat).toHaveBeenCalledWith({
      siteId: "site-1",
      stage: "list-queued",
    });
    expect(heartbeat).toHaveBeenCalledWith({
      siteId: "site-1",
      stage: "queued:asset-1",
    });
  });
});

describe("listKbRecoveryCandidates — expired lease fairness", () => {
  it("sorts expired processing leases ahead of queued backlog before applying the batch limit", async () => {
    const findMany = vi.fn(async () => []);
    const acts = createSiteBuilderActivities({
      prisma: {} as PrismaService,
      ownerDb: { asset: { findMany } } as unknown as PrismaClient,
    });

    await acts.listKbRecoveryCandidates({ limit: 10 });

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 10,
        orderBy: expect.arrayContaining([
          { processingStatus: "asc" },
          { leaseUntil: { sort: "asc", nulls: "last" } },
        ]),
      }),
    );
  });
});

describe("beginRefurbishRun — 预算门接线（改动 1）", () => {
  it("R4-B: a claimed run verifies the pre-authorized Grant and budget before returning", async () => {
    const assertAuthorizedBudget = vi.fn(async () => undefined);
    const tx = {
      site: {
        findUnique: vi.fn(async () => ({ id: "site-1" })),
        update: vi.fn(async () => ({})),
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "queued" })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      costLedger: { assertAuthorizedBudget } as never,
    });

    await acts.beginRefurbishRun(INPUT);

    expect(assertAuthorizedBudget).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      siteId: "site-1",
      buildRunId: "run-1",
    });
  });

  it("认领失败（count=0）→ 抛错且不验证预算（失败 claim 先抛）", async () => {
    const assertAuthorizedBudget = vi.fn(async () => undefined);
    const tx = {
      site: {
        findUnique: vi.fn(async () => ({ id: "site-1" })),
        update: vi.fn(),
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "failed" })),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      costLedger: { assertAuthorizedBudget } as never,
    });
    await expect(acts.beginRefurbishRun(INPUT)).rejects.toThrow(
      /not claimable/,
    );
    expect(assertAuthorizedBudget).not.toHaveBeenCalled();
  });

  it("running activity retry does not reset startedAt, phase, progress or steps", async () => {
    const assertAuthorizedBudget = vi.fn(async () => undefined);
    const updateMany = vi.fn();
    const tx = {
      site: {
        findUnique: vi.fn(async () => ({ id: "site-1" })),
        update: vi.fn(async () => ({})),
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "running" })),
        updateMany,
      },
    };
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      costLedger: { assertAuthorizedBudget } as never,
    });
    await acts.beginRefurbishRun(INPUT);
    expect(updateMany).not.toHaveBeenCalled();
    expect(assertAuthorizedBudget).toHaveBeenCalledTimes(1);
  });
});

describe("finalizeRefurbish — 末尾 force close（改动 1）", () => {
  it("R1 promotes a READY Release with the DB pointer only and never calls the local symlink seam", async () => {
    const { close, costLedger } = spyBudget();
    const releaseUpdateMany = vi.fn(async () => ({ count: 1 }));
    const siteUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "running", scope: {} })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      site: {
        findUnique: vi.fn(async () => ({ activeVersionId: null })),
        updateMany: siteUpdateMany,
      },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: "1.0.0", assets: {}, pages: [] },
          artifactKey: "release:release-1",
        })),
      },
      siteRelease: { updateMany: releaseUpdateMany },
    };
    const promotePreview = vi.fn();
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      promotePreview,
      costLedger: costLedger as never,
    });

    await expect(
      acts.finalizeRefurbish({
        ...INPUT,
        progressV1: true,
        kb: { processed: 0, failed: 0, degraded: false },
        profile: { status: "done", gaps: 0 },
        build: { previewSlug: "acme", versionId: "version-1" },
      }),
    ).resolves.toEqual({ previewSlug: "acme" });

    expect(siteUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "site-1",
        OR: [{ activeVersionId: null }, { activeVersionId: "version-1" }],
      },
      data: { activeVersionId: "version-1", status: "ready" },
    });
    expect(releaseUpdateMany).toHaveBeenCalledWith({
      where: {
        siteVersionId: "version-1",
        siteId: "site-1",
        status: "ready",
      },
      data: { lastActivatedAt: expect.any(Date) },
    });
    expect(promotePreview).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith("run-1", { force: true });
  });

  it("R4-B: persists the stable terminal cost summary on the succeeded BuildRun", async () => {
    spyBudget();
    const costSummary = {
      schemaVersion: "site-builder-cost-summary/v1",
      currency: "USD",
      unit: "microusd",
    };
    const closeAndSummarize = vi.fn(async () => costSummary);
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "running", scope: {} })),
        updateMany,
      },
      site: {
        findUnique: vi.fn(async () => ({ activeVersionId: null })),
        update: vi.fn(async () => ({})),
      },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: "1.0.0", assets: {}, pages: [] },
        })),
      },
    };
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      costLedger: {
        assertAuthorizedBudget: vi.fn(async () => undefined),
        closeAndSummarize,
      } as never,
    });

    await acts.finalizeRefurbish({
      ...INPUT,
      kb: { processed: 1, failed: 0, degraded: false },
      profile: { status: "done", gaps: 0 },
      build: { previewSlug: "acme", versionId: "v-1" },
    });

    expect(closeAndSummarize).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      siteId: "site-1",
      buildRunId: "run-1",
      reason: "run_succeeded",
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ costSummary }),
      }),
    );
  });

  it("发布成功 → close(buildRunId, {force:true})", async () => {
    const { close, costLedger } = spyBudget();
    const tx = {
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "running", scope: {} })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      site: {
        findUnique: vi.fn(async () => ({ activeVersionId: null })),
        update: vi.fn(async () => ({})),
      },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: "1.0.0", assets: {}, pages: [] },
        })),
      },
    };
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      costLedger: costLedger as never,
    });
    const input: RefurbishFinalizeInput = {
      ...INPUT,
      kb: { processed: 1, failed: 0, degraded: false },
      profile: { status: "done", gaps: 0 },
      images: { status: "done", processed: 2, failed: 0, variants: 30 },
      build: { previewSlug: "acme", versionId: "v-1" },
    };
    await acts.finalizeRefurbish(input);
    expect(close).toHaveBeenCalledWith("run-1", { force: true });
  });

  it("兼容升级前已调度且没有 images 字段的 activity payload", async () => {
    const { close, costLedger } = spyBudget();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "running", scope: {} })),
        updateMany,
      },
      site: {
        findUnique: vi.fn(async () => ({ activeVersionId: null })),
        update: vi.fn(async () => ({})),
      },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: "1.0.0", assets: {}, pages: [] },
        })),
      },
    };
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      costLedger: costLedger as never,
    });
    await expect(
      acts.finalizeRefurbish({
        ...INPUT,
        kb: { processed: 1, failed: 0, degraded: false },
        profile: { status: "done", gaps: 0 },
        build: { previewSlug: "acme", versionId: "v-legacy" },
      }),
    ).resolves.toEqual({ previewSlug: "acme" });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          steps: expect.arrayContaining([
            expect.objectContaining({
              key: "image_pipeline",
              status: "skipped_m1c",
            }),
          ]),
        }),
      }),
    );
    expect(close).toHaveBeenCalledWith("run-1", { force: true });
  });

  it("局部构建发布时 active pointer 已变化则 CAS 失败且不覆盖新版本", async () => {
    spyBudget();
    const root = await mkdtemp(path.join(tmpdir(), "r3b2-cas-preview-"));
    vi.stubEnv("PREVIEW_DIR", root);
    const live = path.join(root, "acme");
    const staging = path.join(root, ".staging", "run-1");
    await Promise.all([
      mkdir(live, { recursive: true }),
      mkdir(staging, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(live, "index.html"), "active-preview"),
      writeFile(path.join(staging, "index.html"), "candidate-preview"),
    ]);
    const update = vi.fn(async () => ({}));
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const tx = {
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "running", scope: {} })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      site: {
        findUnique: vi.fn(async () => ({ activeVersionId: "changed-version" })),
        update,
        updateMany,
      },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: "1.0.0", assets: {}, pages: [] },
          artifactKey: `local:${staging}`,
        })),
      },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    try {
      await expect(
        acts.finalizeRefurbish({
          ...INPUT,
          progressV1: true,
          scope: {
            scope: "page",
            targetId: "products",
            baseVersionId: "base-version",
          },
          kb: { processed: 0, failed: 0, degraded: false },
          profile: { status: "done", gaps: 0 },
          build: { previewSlug: "acme", versionId: "candidate-version" },
        }),
      ).rejects.toThrow("active SiteVersion changed");
      expect(updateMany).toHaveBeenCalledWith({
        where: {
          id: "site-1",
          OR: [
            { activeVersionId: "base-version" },
            { activeVersionId: "candidate-version" },
          ],
        },
        data: { activeVersionId: "candidate-version", status: "ready" },
      });
      expect(update).not.toHaveBeenCalled();
      expect(await readFile(path.join(live, "index.html"), "utf8")).toBe(
        "active-preview",
      );
      expect(await readFile(path.join(staging, "index.html"), "utf8")).toBe(
        "candidate-preview",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("预览提升后的事务写入失败会恢复原 live 目录", async () => {
    spyBudget();
    const root = await mkdtemp(path.join(tmpdir(), "r3b2-tx-preview-"));
    vi.stubEnv("PREVIEW_DIR", root);
    const live = path.join(root, "acme");
    const staging = path.join(root, ".staging", "run-1");
    await Promise.all([
      mkdir(live, { recursive: true }),
      mkdir(staging, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(live, "index.html"), "active-preview"),
      writeFile(path.join(staging, "index.html"), "candidate-preview"),
    ]);
    const tx = {
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "running", scope: {} })),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      site: {
        findUnique: vi.fn(async () => ({ activeVersionId: "base-version" })),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: "1.0.0", assets: {}, pages: [] },
          artifactKey: `local:${staging}`,
        })),
        update: vi.fn(async () => {
          throw new Error("artifact DB write failed");
        }),
      },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    try {
      await expect(
        acts.finalizeRefurbish({
          ...INPUT,
          progressV1: true,
          kb: { processed: 0, failed: 0, degraded: false },
          profile: { status: "done", gaps: 0 },
          build: { previewSlug: "acme", versionId: "candidate-version" },
        }),
      ).rejects.toThrow("artifact DB write failed");
      expect(await readFile(path.join(live, "index.html"), "utf8")).toBe(
        "active-preview",
      );
      await expect(
        readFile(path.join(root, ".rollback", "run-1", "index.html")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("pointer commit 持续失败时以持久 publication base 回滚 DB 并标记候选失败", async () => {
    spyBudget();
    const root = await mkdtemp(path.join(tmpdir(), "r3b2-pointer-fail-"));
    vi.stubEnv("PREVIEW_DIR", root);
    const staging = path.join(root, ".staging", "run-1");
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "index.html"), "candidate-preview");
    const runUpdateMany = vi.fn(async () => ({ count: 1 }));
    const siteUpdateMany = vi.fn(async () => ({ count: 1 }));
    const versionUpdateMany = vi.fn(async () => ({ count: 1 }));
    const siteFindUnique = vi
      .fn()
      .mockResolvedValueOnce({ activeVersionId: "base-version" })
      .mockResolvedValueOnce({ activeVersionId: "candidate-version" });
    const runFindUnique = vi
      .fn()
      .mockResolvedValueOnce({ status: "running", scope: {} })
      .mockResolvedValueOnce({ status: "succeeded" });
    const tx = {
      siteBuildRun: {
        findUnique: runFindUnique,
        updateMany: runUpdateMany,
      },
      site: {
        findUnique: siteFindUnique,
        updateMany: siteUpdateMany,
      },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: "1.0.0", assets: {}, pages: [] },
          artifactKey: `local:${staging}`,
        })),
        findUnique: vi.fn(async () => ({
          buildStatus: "succeeded",
          artifactKey: `local:${path.join(root, ".versions", "run-1")}`,
        })),
        update: vi.fn(async () => ({})),
        updateMany: versionUpdateMany,
      },
    };
    const pointerFailure = new Error("pointer rename unavailable");
    const promotePreview = vi.fn(async () => ({
      commit: async () => {
        throw pointerFailure;
      },
      rollback: async () => undefined,
      abandon: async () => undefined,
    }));
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      promotePreview,
    });
    try {
      await expect(
        acts.finalizeRefurbish({
          ...INPUT,
          progressV1: true,
          kb: { processed: 0, failed: 0, degraded: false },
          profile: { status: "done", gaps: 0 },
          build: { previewSlug: "acme", versionId: "candidate-version" },
        }),
      ).rejects.toBe(pointerFailure);
      expect(siteUpdateMany).toHaveBeenNthCalledWith(2, {
        where: { id: "site-1", activeVersionId: "candidate-version" },
        data: { activeVersionId: "base-version", status: "ready" },
      });
      expect(runUpdateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            status: "succeeded",
            scope: expect.objectContaining({
              publicationBaseVersionId: "base-version",
            }),
          }),
        }),
      );
      expect(runUpdateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: { id: "run-1", status: "succeeded" },
          data: expect.objectContaining({
            status: "failed",
            error: "preview pointer promotion failed",
          }),
        }),
      );
      expect(versionUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "candidate-version",
          buildRunId: "run-1",
          buildStatus: "succeeded",
        },
        data: { buildStatus: "failed" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("旧 finalize retry 发现更新 build 已接管时不覆盖新的 served pointer", async () => {
    const { close, costLedger } = spyBudget();
    const root = await mkdtemp(path.join(tmpdir(), "r3b2-stale-publish-"));
    vi.stubEnv("PREVIEW_DIR", root);
    const staging = path.join(root, ".staging", "run-1");
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "index.html"), "candidate-preview");
    const siteFindUnique = vi
      .fn()
      .mockResolvedValueOnce({ activeVersionId: "base-version" })
      .mockResolvedValueOnce({ activeVersionId: "newer-version" });
    const runFindUnique = vi
      .fn()
      .mockResolvedValueOnce({ status: "running", scope: {} })
      .mockResolvedValueOnce({ status: "succeeded" });
    const tx = {
      siteBuildRun: {
        findUnique: runFindUnique,
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      site: {
        findUnique: siteFindUnique,
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      siteVersion: {
        findFirst: vi.fn(async () => ({
          spec: { specVersion: "1.0.0", assets: {}, pages: [] },
          artifactKey: `local:${staging}`,
        })),
        findUnique: vi.fn(async () => ({
          buildStatus: "succeeded",
          artifactKey: `local:${path.join(root, ".versions", "run-1")}`,
        })),
        update: vi.fn(async () => ({})),
      },
    };
    const commit = vi.fn(async () => undefined);
    const abandon = vi.fn(async () => undefined);
    const promotePreview = vi.fn(async () => ({
      commit,
      rollback: async () => undefined,
      abandon,
    }));
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      promotePreview,
      costLedger: costLedger as never,
    });
    try {
      await expect(
        acts.finalizeRefurbish({
          ...INPUT,
          progressV1: true,
          kb: { processed: 0, failed: 0, degraded: false },
          profile: { status: "done", gaps: 0 },
          build: { previewSlug: "acme", versionId: "candidate-version" },
        }),
      ).resolves.toEqual({ previewSlug: "acme" });
      expect(abandon).toHaveBeenCalledOnce();
      expect(commit).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledWith("run-1", { force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// FIX A/B 用最小 intake（buildDemoSpec/polishCopy 只取 company/products/targetMarkets）。
const INTAKE = {
  company: { nameZh: "安可", nameEn: "Acme" },
  industry: "pumps",
  products: ["pumps"],
  targetMarkets: ["DE"],
  hasWebsite: false,
  businessEmail: "sales@acme.com",
};

/** assembleAndBuild 用 prisma 桩：首个 withWorkspace 返回站点（existing=null），
 *  第二个（写版本行）抛错——停在 runAstroBuild 之前，令用例只覆盖 polishCopy/入口逻辑。 */
function assembleStopAfterPolishPrisma(site: unknown): PrismaService {
  let call = 0;
  return {
    withWorkspace: vi.fn(async (_ws: string, fn: (t: unknown) => unknown) => {
      call += 1;
      if (call === 1) {
        return fn({
          siteBuildRun: { updateMany: vi.fn(async () => ({ count: 1 })) },
          site: { findUnique: vi.fn(async () => site) },
          siteVersion: { findFirst: vi.fn(async () => null) },
        });
      }
      throw new Error("stop-after-polish");
    }),
  } as unknown as PrismaService;
}

describe("assembleAndBuild — deterministic demo compatibility", () => {
  it("does not dispatch a model even when a gateway is configured", async () => {
    spyBudget();
    const gateway = { generateStructured: vi.fn() };
    const site = {
      id: "site-1",
      name: "Acme",
      slug: "acme",
      stylePreset: "clean",
      intake: INTAKE,
    };
    const acts = createSiteBuilderActivities({
      prisma: assembleStopAfterPolishPrisma(site),
      gateway: gateway as never,
      costLedger: {
        assertAuthorizedBudget: vi.fn(async () => undefined),
      } as never,
    });
    await expect(acts.assembleAndBuild(INPUT)).rejects.toThrow(
      "stop-after-polish",
    );
    expect(gateway.generateStructured).not.toHaveBeenCalled();
  });
});

describe("活动入口只接受持久 Grant + Budget 授权", () => {
  it("assembleAndBuild 在任何数据读取前验证授权预算", async () => {
    const assertAuthorizedBudget = vi.fn(async () => undefined);
    const prisma = {
      withWorkspace: vi.fn(async () => {
        throw new Error("stop");
      }),
    } as unknown as PrismaService;
    const acts = createSiteBuilderActivities({
      prisma,
      costLedger: { assertAuthorizedBudget } as never,
    });
    await expect(acts.assembleAndBuild(INPUT)).rejects.toThrow("stop");
    expect(assertAuthorizedBudget).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      siteId: "site-1",
      buildRunId: "run-1",
    });
  });

  it("R3-B2 assemble 入口不把已记录的 0.65 进度写回旧 0.5", async () => {
    spyBudget();
    const updateMany = vi.fn(async () => ({ count: 1 }));
    let call = 0;
    const prisma = {
      withWorkspace: vi.fn(
        async (_workspaceId: string, fn: (tx: unknown) => unknown) => {
          call += 1;
          if (call > 1) throw new Error("stop-after-read");
          return fn({
            siteBuildRun: { updateMany },
            site: {
              findUnique: vi.fn(async () => ({
                id: "site-1",
                name: "Acme",
                slug: "acme",
                intake: INTAKE,
                stylePreset: "modern-industrial",
                activeVersionId: null,
              })),
            },
            siteVersion: { findFirst: vi.fn(async () => null) },
          });
        },
      ),
    } as unknown as PrismaService;
    const acts = createSiteBuilderActivities({ prisma });
    await expect(
      acts.assembleAndBuild({ ...INPUT, progressV1: true }),
    ).rejects.toThrow("stop-after-read");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: "running" },
      data: { phase: "P3_assembly", progress: 0.65 },
    });
  });

  it("renderer 期间取消后不把迟到候选写 succeeded，并清理 run staging", async () => {
    spyBudget();
    const root = await mkdtemp(path.join(tmpdir(), "r3b2-render-cancel-"));
    vi.stubEnv("PREVIEW_DIR", root);
    let runStatus = "running";
    const versionUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      siteBuildRun: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({ status: runStatus })),
      },
      site: {
        findUnique: vi.fn(async () => ({
          id: "site-1",
          name: "Acme",
          slug: "acme",
          intake: INTAKE,
          stylePreset: "modern-industrial",
          activeVersionId: null,
        })),
      },
      siteVersion: {
        findFirst: vi.fn(async () => null),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        aggregate: vi.fn(async () => ({ _max: { version: null } })),
        create: vi.fn(async () => ({ id: "version-1" })),
        updateMany: versionUpdateMany,
      },
    };
    const renderSiteSpec = vi.fn(
      async (_spec: unknown, output: { outDir: string; basePath: string }) => {
        await writeFile(path.join(output.outDir, "index.html"), "candidate");
        runStatus = "cancelled";
      },
    );
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      renderSiteSpec,
    });
    try {
      await expect(
        acts.assembleAndBuild({ ...INPUT, progressV1: true }),
      ).rejects.toThrow("rendered candidate discarded");
      expect(versionUpdateMany).toHaveBeenCalledWith({
        where: { id: "version-1", buildStatus: "building" },
        data: { buildStatus: "failed" },
      });
      await expect(
        readFile(path.join(root, ".staging", "run-1", "index.html")),
      ).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("R1 assembles into a durable Release instead of succeeding a local artifact", async () => {
    spyBudget();
    const root = await mkdtemp(path.join(tmpdir(), "r1-release-assemble-"));
    vi.stubEnv("PREVIEW_DIR", root);
    const versionUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      siteBuildRun: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({ status: "running" })),
      },
      site: {
        findUnique: vi.fn(async () => ({
          id: "site-1",
          name: "Acme",
          slug: "acme",
          intake: INTAKE,
          stylePreset: "modern-industrial",
          activeVersionId: null,
        })),
      },
      siteVersion: {
        findFirst: vi.fn(async () => null),
        deleteMany: vi.fn(async () => ({ count: 0 })),
        aggregate: vi.fn(async () => ({ _max: { version: null } })),
        create: vi.fn(async () => ({ id: "version-1" })),
        updateMany: versionUpdateMany,
      },
    };
    const renderSiteSpec = vi.fn(
      async (_spec: unknown, output: { outDir: string }) => {
        await writeFile(path.join(output.outDir, "index.html"), "candidate");
      },
    );
    const materialize = vi.fn(async () => ({
      releaseId: "release-1",
      artifactKey: "release:release-1",
      artifactPrefix: "sites/site-1/releases/release-1",
      artifactDigest: "a".repeat(64),
      manifestDigest: "b".repeat(64),
      producerToken: "producer-1",
    }));
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      renderSiteSpec,
      releaseService: { materialize } as never,
    });
    try {
      await expect(
        acts.assembleAndBuild({ ...INPUT, progressV1: true }),
      ).resolves.toEqual({ previewSlug: "acme", versionId: "version-1" });
      expect(materialize).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "ws-1",
          siteId: "site-1",
          siteVersionId: "version-1",
          buildRunId: "run-1",
          storedSpecVersion: "1.0.0",
          root: path.join(root, ".staging", "run-1"),
        }),
      );
      expect(versionUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            artifactKey: expect.stringMatching(/^local:/),
          }),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("R1 retry reuses the run-scoped building SiteVersion instead of invalidating its candidate Release", async () => {
    const source = await readFile(
      new URL("./site-builder.activities.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("async assembleAndBuild(");
    const end = source.indexOf("async finalizeRefurbish(", start);
    const assemble = source.slice(start, end);
    expect(assemble).not.toMatch(/siteVersion\.deleteMany\(/);
    expect(assemble).toMatch(
      /siteVersion\.findFirst\(\{\s*where: \{ buildRunId \}/,
    );
  });

  it("buildBrandProfile 在 gateway 缺席时仍先验证持久授权", async () => {
    const assertAuthorizedBudget = vi.fn(async () => undefined);
    const acts = createSiteBuilderActivities({
      prisma: {} as PrismaService,
      costLedger: { assertAuthorizedBudget } as never,
    });
    await expect(acts.buildBrandProfile(INPUT)).rejects.toThrow(
      /gateway unavailable/,
    );
    expect(assertAuthorizedBudget).toHaveBeenCalledTimes(1);
  });

  it("R4-B: BrandProfile fails closed before I/O when no durable ledger is installed", async () => {
    spyBudget();
    const gateway = { generateStructured: vi.fn() };
    const prisma = {
      withWorkspace: vi.fn(async () => {
        throw new Error("database must not be reached");
      }),
    } as unknown as PrismaService;
    const acts = createSiteBuilderActivitiesRaw({
      prisma,
      gateway: gateway as never,
      rendererBuildIdentity: "site-renderer@test-sha256",
    });

    await expect(acts.buildBrandProfile(INPUT)).rejects.toThrow(
      "PERSISTENT_LEDGER_UNAVAILABLE",
    );
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(gateway.generateStructured).not.toHaveBeenCalled();
  });

  it("R4-B: completed logical BrandProfile attempts replay without database, research or model I/O", async () => {
    spyBudget();
    const summary = {
      version: 4,
      factCount: 3,
      gapsCount: 1,
      researchDegraded: false,
      model: "gpt-5.6-terra",
    };
    const claimTaskAttempt = vi.fn(async () => ({
      kind: "completed" as const,
      result: summary,
    }));
    const prisma = {
      withWorkspace: vi.fn(async () => {
        throw new Error("database must not be reached after replay");
      }),
    } as unknown as PrismaService;
    const gateway = { generateStructured: vi.fn() };
    const broker = { invoke: vi.fn() };
    const acts = createSiteBuilderActivities({
      prisma,
      gateway: gateway as never,
      broker: broker as never,
      costLedger: {
        assertAuthorizedBudget: vi.fn(async () => undefined),
        claimTaskAttempt,
      } as never,
    });

    await expect(acts.buildBrandProfile(INPUT)).resolves.toEqual(summary);
    expect(claimTaskAttempt).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      siteId: "site-1",
      buildRunId: "run-1",
      taskId: "site_builder.brand_profile",
    });
    expect(prisma.withWorkspace).not.toHaveBeenCalled();
    expect(broker.invoke).not.toHaveBeenCalled();
    expect(gateway.generateStructured).not.toHaveBeenCalled();
  });

  it("buildBrandProfile 对旧的未关联 CompanyProfile Site 在任何模型/研究调用前 fail-closed", async () => {
    const gateway = { generateStructured: vi.fn() };
    const broker = { execute: vi.fn() };
    const prisma = fakePrisma({
      site: {
        findUnique: vi.fn(async () => ({
          id: "site-1",
          companyProfileId: null,
          intake: INTAKE,
          profile: null,
          profileVersionId: null,
        })),
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "running" })),
      },
    });
    const acts = createSiteBuilderActivities({
      prisma,
      gateway: gateway as never,
      broker: broker as never,
      costLedger: {
        assertAuthorizedBudget: vi.fn(async () => undefined),
        claimTaskAttempt: vi.fn(async () => ({
          kind: "claimed",
          attempt: {
            id: "attempt-1",
            fenceToken: "fence-1",
          },
        })),
        releaseTask: vi.fn(async () => undefined),
      } as never,
    });

    await expect(acts.buildBrandProfile(INPUT)).rejects.toThrow(
      "SITE_COMPANY_PROFILE_LINK_REQUIRED",
    );
    expect(gateway.generateStructured).not.toHaveBeenCalled();
    expect(broker.execute).not.toHaveBeenCalled();
  });
});

describe("R4-B BrandProfile paid attempt recovery", () => {
  it("freezes input, stores model output, and atomically commits profile plus task success", async () => {
    spyBudget();
    const snapshot = {
      id: "snapshot-1",
      sourceKey: "intake",
      sourceType: "intake",
      sourceRole: "fact_candidate",
      contentHash: "a".repeat(64),
      upstreamContentHash: null,
      normalizationVersion: "brand-evidence-normalization/v1",
      snapshotText: "Company name: Acme",
      displayUrl: null,
      fetchedAt: null,
      provenance: {},
      dedupeKey: "dedupe-1",
    };
    const brandProfileCreate = vi.fn(async () => ({ id: "profile-1" }));
    const attemptUpdate = vi.fn(async () => ({ count: 1 }));
    const tx = {
      site: {
        findUnique: vi.fn(async () => ({
          id: "site-1",
          companyProfileId: "company-profile-1",
          profileVersionId: null,
          intake: INTAKE,
          profile: null,
        })),
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: "running" })),
      },
      siteEvidenceSourceSnapshot: {
        createMany: vi.fn(async () => ({ count: 1 })),
        findMany: vi.fn(
          async (args: { where: { dedupeKey?: { in: string[] } } }) => [
            {
              ...snapshot,
              dedupeKey: args.where.dedupeKey?.in[0] ?? snapshot.dedupeKey,
            },
          ],
        ),
      },
      brandProfile: {
        aggregate: vi.fn(async () => ({ _max: { version: null } })),
        create: brandProfileCreate,
      },
      brandProfileEvidenceRef: { createMany: vi.fn() },
      siteBuildTaskAttempt: { updateMany: attemptUpdate },
    };
    const gateway = {
      generateStructured: vi.fn(async (_input, ctx) => {
        const durableReplayResult = ctx.paidCost?.durableReplayResult;
        expect(durableReplayResult).toBeTypeOf("function");
        expect(() =>
          durableReplayResult?.({
            data: {
              valueProps: ["Contact Jane Doe at jane@example.com"],
              keywords: [],
              glossary: [],
              differentiators: [],
              competitors: [],
              factSheet: [],
              gaps: [],
            },
            provider: "new-api",
            model: "gpt-5.6-terra",
          }),
        ).toThrow(/BrandProfile output hard gate rejected/);
        return {
          data: {
            valueProps: [],
            keywords: [],
            glossary: [],
            differentiators: [],
            competitors: [],
            factSheet: [],
            gaps: [],
          },
          provider: "new-api",
          model: "gpt-5.6-terra",
          reportedModel: "gpt-5.6-terra",
          modelResolutionSource: "upstream_response",
          usage: {
            inputTokens: 11,
            outputTokens: 7,
            gatewaySettlements: [
              {
                status: "settled",
                requestId: ["request", "fixture"].join("-"),
                resolverId: "fixture-resolver",
                alias: "gpt-5.6-terra",
                protocol: "openai-responses",
                channelId: 1,
                basis: "openox_catalog_token_pricing",
                quota: 1,
                costMicrousd: 1,
                inputTokens: 11,
                outputTokens: 7,
              },
            ],
          },
        };
      }),
    };
    const freezeTaskInput = vi.fn(async (_fence, candidate) => ({
      inputHash: "b".repeat(64),
      input: candidate,
      replayed: false,
    }));
    const storeTaskOutput = vi.fn(async () => undefined);
    const completeTask = vi.fn(async () => undefined);
    const releaseTask = vi.fn(async () => undefined);
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      gateway: gateway as never,
      costLedger: {
        assertAuthorizedBudget: vi.fn(async () => undefined),
        claimTaskAttempt: vi.fn(async () => ({
          kind: "claimed",
          attempt: {
            id: "attempt-1",
            status: "CLAIMED",
            fenceToken: "fence-1",
          },
        })),
        freezeTaskInput,
        storeTaskOutput,
        completeTask,
        releaseTask,
      } as never,
    });

    await expect(acts.buildBrandProfile(INPUT)).resolves.toEqual({
      version: 1,
      factCount: 0,
      gapsCount: 0,
      researchDegraded: true,
      model: "gpt-5.6-terra",
    });
    expect(freezeTaskInput).toHaveBeenCalledWith(
      {
        workspaceId: "ws-1",
        attemptId: "attempt-1",
        fenceToken: "fence-1",
      },
      expect.objectContaining({
        taskInput: expect.objectContaining({ companyName: "Acme" }),
        researchDegraded: true,
      }),
    );
    expect(gateway.generateStructured).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        paidCost: {
          siteId: "site-1",
          taskAttemptId: "attempt-1",
          fenceToken: "fence-1",
          scopeKey: expect.stringContaining("attempt-1:model:0:"),
          durableReplayResult: expect.any(Function),
        },
      }),
    );
    expect(storeTaskOutput).toHaveBeenCalledBefore(brandProfileCreate);
    expect(brandProfileCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ taskAttemptId: "attempt-1" }),
      }),
    );
    expect(attemptUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "attempt-1",
          fenceToken: "fence-1",
          status: "MODEL_SUCCEEDED",
        }),
        data: expect.objectContaining({
          status: "SUCCEEDED",
          resultJson: expect.objectContaining({ version: 1 }),
        }),
      }),
    );
    expect(completeTask).not.toHaveBeenCalled();
    expect(releaseTask).not.toHaveBeenCalled();
  });
});

describe("compensateRefurbish — 末尾 force close + steps 回填（改动 1+3）", () => {
  function compensateTx(over: {
    runStatus?: string;
    startedAt?: Date | null;
    brandProfile?: unknown;
    siteVersion?: unknown;
    siteReleaseStatus?: string | null;
    steps?: unknown;
    transitionCount?: number;
  }) {
    const runUpdate = vi.fn(async () => ({ count: over.transitionCount ?? 1 }));
    const siteUpdate = vi.fn(async () => ({}));
    const findFirst = vi.fn(async () => over.brandProfile ?? null);
    const svFindFirst = vi.fn(async () => over.siteVersion ?? null);
    const tx = {
      siteVersion: {
        updateMany: vi.fn(async () => ({ count: 0 })),
        findFirst: svFindFirst,
      },
      siteRelease: {
        findUnique: vi.fn(async () =>
          over.siteReleaseStatus
            ? { id: "release-1", status: over.siteReleaseStatus }
            : null,
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      site: {
        findUnique: vi.fn(async () => ({
          id: "site-1",
          activeVersionId: null,
        })),
        update: siteUpdate,
      },
      siteBuildRun: {
        findUnique: vi.fn(async () => ({
          status: over.runStatus ?? "running",
          startedAt:
            over.startedAt === undefined
              ? new Date("2026-07-14T00:00:00.000Z")
              : over.startedAt,
          error: null,
          finishedAt: null,
          steps: over.steps ?? PENDING_STEPS,
        })),
        updateMany: runUpdate,
      },
      brandProfile: { findFirst },
    };
    return { tx, runUpdate, siteUpdate, findFirst, svFindFirst };
  }

  it("转 failed 时 always force close", async () => {
    const { close, costLedger } = spyBudget();
    const { tx } = compensateTx({});
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      costLedger: costLedger as never,
    });
    await acts.compensateRefurbish(INPUT);
    expect(close).toHaveBeenCalledWith("run-1", { force: true });
  });

  it("R4-B: failed compensation closes paid calls and persists the same versioned summary", async () => {
    spyBudget();
    const { tx, runUpdate } = compensateTx({});
    const costSummary = {
      schemaVersion: "site-builder-cost-summary/v1",
      currency: "USD",
      unit: "microusd",
    };
    const closeAndSummarize = vi.fn(async () => costSummary);
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      costLedger: {
        assertAuthorizedBudget: vi.fn(async () => undefined),
        closeAndSummarize,
      } as never,
    });

    await acts.compensateRefurbish(INPUT);

    expect(closeAndSummarize).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      siteId: "site-1",
      buildRunId: "run-1",
      reason: "run_failed",
    });
    expect(runUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ costSummary }),
      }),
    );
  });

  it("DB 补偿失败会传播，交给 Temporal 重试且绝不伪装成功", async () => {
    const { close, costLedger } = spyBudget();
    const failure = new Error("database unavailable");
    const acts = createSiteBuilderActivities({
      prisma: {
        withWorkspace: vi.fn().mockRejectedValue(failure),
      } as unknown as PrismaService,
      costLedger: costLedger as never,
    });
    await expect(acts.compensateRefurbish(INPUT)).rejects.toBe(failure);
    expect(close).toHaveBeenCalledWith("run-1", { force: true });
  });

  it("brandProfile 存在 + siteVersion succeeded 存在 → brand_profile+assemble_build 均 done，其余 aborted，保留 7 步键序", async () => {
    spyBudget();
    const { tx, runUpdate, findFirst, svFindFirst } = compensateTx({
      brandProfile: { id: "bp-1" },
      siteVersion: { id: "sv-1" },
    });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        siteId: "site-1",
        createdAt: { gte: new Date("2026-07-14T00:00:00.000Z") },
      },
    });
    // assemble_build 完成靠 siteVersion 行核验（buildRunId 唯一定位，无需 startedAt）
    expect(svFindFirst).toHaveBeenCalledWith({
      where: { buildRunId: "run-1", buildStatus: "succeeded" },
    });
    const data = runUpdate.mock.calls[0][0].data as {
      status: string;
      steps: { key: string; status: string }[];
    };
    expect(data.status).toBe("failed");
    expect(data.steps.map((s) => s.key)).toEqual(REFURBISH_KEYS);
    expect(data.steps.find((s) => s.key === "brand_profile")?.status).toBe(
      "done",
    );
    expect(data.steps.find((s) => s.key === "assemble_build")?.status).toBe(
      "done",
    );
    expect(
      data.steps
        .filter((s) => s.key !== "brand_profile" && s.key !== "assemble_build")
        .every((s) => s.status === "aborted"),
    ).toBe(true);
  });

  it("brandProfile 存在 + 无 succeeded siteVersion → brand_profile done、assemble_build aborted（其余 aborted）", async () => {
    spyBudget();
    const { tx, runUpdate } = compensateTx({
      brandProfile: { id: "bp-1" },
      siteVersion: null,
    });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    const data = runUpdate.mock.calls[0][0].data as {
      steps: { key: string; status: string }[];
    };
    expect(data.steps.find((s) => s.key === "brand_profile")?.status).toBe(
      "done",
    );
    expect(data.steps.find((s) => s.key === "assemble_build")?.status).toBe(
      "aborted",
    );
    expect(
      data.steps
        .filter((s) => s.key !== "brand_profile")
        .every((s) => s.status === "aborted"),
    ).toBe(true);
  });

  it("brandProfile 缺席 → brand_profile:aborted（全部 aborted）", async () => {
    spyBudget();
    const { tx, runUpdate } = compensateTx({ brandProfile: null });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    const data = runUpdate.mock.calls[0][0].data as {
      steps: { key: string; status: string }[];
    };
    expect(data.steps.find((s) => s.key === "brand_profile")?.status).toBe(
      "aborted",
    );
    expect(data.steps.every((s) => s.status === "aborted")).toBe(true);
  });

  it("run 已 succeeded → 不改状态、不写 steps、不查 brandProfile/siteVersion（守卫），但仍 force close", async () => {
    const { close, costLedger } = spyBudget();
    const { tx, runUpdate, findFirst, svFindFirst } = compensateTx({
      runStatus: "succeeded",
    });
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      costLedger: costLedger as never,
    });
    await acts.compensateRefurbish(INPUT);
    expect(runUpdate).not.toHaveBeenCalled();
    expect(findFirst).not.toHaveBeenCalled();
    expect(svFindFirst).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith("run-1", { force: true });
  });

  it("取消补偿 CAS 为 cancelled，且不记录 failure error", async () => {
    spyBudget();
    const { tx, runUpdate, siteUpdate } = compensateTx({});
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish({ ...INPUT, terminalStatus: "cancelled" });
    expect(runUpdate.mock.calls[0][0].data).toMatchObject({
      status: "cancelled",
      error: null,
    });
    expect(siteUpdate).toHaveBeenCalledOnce();
  });

  it("terminal CAS 丢失时不回写 Site，防止旧补偿覆盖新 run", async () => {
    spyBudget();
    const { tx, runUpdate, siteUpdate } = compensateTx({ transitionCount: 0 });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(runUpdate).toHaveBeenCalledOnce();
    expect(siteUpdate).not.toHaveBeenCalled();
  });

  it("terminal CAS 赢时把本 run 的 building/succeeded 未发布候选统一标 failed", async () => {
    spyBudget();
    const { tx } = compensateTx({ siteVersion: { id: "candidate" } });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(tx.siteVersion.updateMany).toHaveBeenCalledWith({
      where: {
        buildRunId: "run-1",
        buildStatus: { in: ["building", "succeeded"] },
      },
      data: { buildStatus: "failed" },
    });
  });

  it("M1-f pointer CAS 失败时保留 READY inactive Release 与 succeeded SiteVersion", async () => {
    spyBudget();
    const { tx } = compensateTx({
      siteVersion: { id: "candidate" },
      siteReleaseStatus: "ready",
    });
    const deletePrefix = vi.fn(async () => 3);
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      storage: { deletePrefix } as never,
    });

    await acts.compensateRefurbish({ ...INPUT, qualityV1: true });

    expect(tx.siteRelease.findUnique).toHaveBeenCalledWith({
      where: { buildRunId: "run-1" },
      select: { id: true, status: true },
    });
    expect(tx.siteRelease.updateMany).not.toHaveBeenCalled();
    expect(tx.siteVersion.updateMany).not.toHaveBeenCalled();
    expect(deletePrefix).toHaveBeenCalledWith(
      "sites/site-1/quality-candidates/run-1/",
    );
  });

  it("M1-f 未完成 candidate Release 会标 failed，且候选版本与临时证据一并收口", async () => {
    spyBudget();
    const { tx } = compensateTx({
      siteVersion: { id: "candidate" },
      siteReleaseStatus: "candidate",
    });
    const deletePrefix = vi.fn(async () => 3);
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      storage: { deletePrefix } as never,
    });

    await acts.compensateRefurbish({ ...INPUT, qualityV1: true });

    expect(tx.siteRelease.updateMany).toHaveBeenCalledWith({
      where: { id: "release-1", status: "candidate" },
      data: {
        status: "failed",
        error: "quality materialization did not complete",
      },
    });
    expect(tx.siteVersion.updateMany).toHaveBeenCalledWith({
      where: {
        buildRunId: "run-1",
        buildStatus: { in: ["building", "succeeded"] },
      },
      data: { buildStatus: "failed" },
    });
    expect(deletePrefix).toHaveBeenCalledOnce();
  });

  it("startedAt 为 null（无从归属）→ brand_profile:aborted，不发探测查询", async () => {
    spyBudget();
    const { tx, runUpdate, findFirst } = compensateTx({
      startedAt: null,
      brandProfile: { id: "stale" },
    });
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.compensateRefurbish(INPUT);
    expect(findFirst).not.toHaveBeenCalled(); // startedAt 缺失不查（不误认领旧版本）
    const data = runUpdate.mock.calls[0][0].data as {
      steps: { key: string; status: string }[];
    };
    expect(data.steps.find((s) => s.key === "brand_profile")?.status).toBe(
      "aborted",
    );
  });
});

describe("buildCompensatedSteps — 纯函数（两个 DB 可核验完成位）", () => {
  it("(true,true) → brand_profile+assemble_build done，其余 aborted，键序不变", () => {
    const steps = buildCompensatedSteps(true, true);
    expect(steps.map((s) => s.key)).toEqual(REFURBISH_KEYS);
    expect(steps.find((s) => s.key === "brand_profile")?.status).toBe("done");
    expect(steps.find((s) => s.key === "assemble_build")?.status).toBe("done");
    expect(
      steps
        .filter((s) => s.key !== "brand_profile" && s.key !== "assemble_build")
        .every((s) => s.status === "aborted"),
    ).toBe(true);
  });

  it("(true,false) → brand_profile done、assemble_build aborted，其余 aborted", () => {
    const steps = buildCompensatedSteps(true, false);
    expect(steps.find((s) => s.key === "brand_profile")?.status).toBe("done");
    expect(steps.find((s) => s.key === "assemble_build")?.status).toBe(
      "aborted",
    );
    expect(
      steps
        .filter((s) => s.key !== "brand_profile")
        .every((s) => s.status === "aborted"),
    ).toBe(true);
  });

  it("(false,true) → assemble_build done、brand_profile aborted，其余 aborted", () => {
    const steps = buildCompensatedSteps(false, true);
    expect(steps.find((s) => s.key === "assemble_build")?.status).toBe("done");
    expect(steps.find((s) => s.key === "brand_profile")?.status).toBe(
      "aborted",
    );
    expect(
      steps
        .filter((s) => s.key !== "assemble_build")
        .every((s) => s.status === "aborted"),
    ).toBe(true);
  });

  it("(false,false) → 7 步全 aborted，键序不变", () => {
    const steps = buildCompensatedSteps(false, false);
    expect(steps.map((s) => s.key)).toEqual(REFURBISH_KEYS);
    expect(steps.every((s) => s.status === "aborted")).toBe(true);
  });
});

describe("R0-4 intakeToMarkdown — businessEmail 不进 KB（隐私红线，与 ADR-010 存储侧同源）", () => {
  const intake = {
    company: { nameZh: "安可", nameEn: "Acme" },
    industry: "pumps",
    products: ["pumps"],
    targetMarkets: ["DE"],
    hasWebsite: false,
    websiteUrl: null,
    businessEmail: "sales@acme.com",
  };
  it("KB markdown 不含 businessEmail / email 字样，但保留公司名/产品/市场事实", () => {
    const md = intakeToMarkdown(intake as never);
    expect(md).not.toContain("sales@acme.com");
    expect(md.toLowerCase()).not.toContain("email");
    // 去联系信息 ≠ 去事实
    expect(md).toContain("Acme");
    expect(md).toContain("pumps");
    expect(md).toContain("DE");
  });
});

describe("generateDemoV0 — R1 immutable Release publication", () => {
  function retryingDemoTx(options?: {
    cancelDuringRender?: boolean;
    renderError?: Error;
  }) {
    let runStatus = "running";
    const spec = buildDemoSpec({
      siteName: "Acme",
      intake: INTAKE,
      stylePreset: "clean",
    });
    const version = {
      id: "version-1",
      workspaceId: "ws-1",
      siteId: "site-1",
      buildRunId: "run-1",
      source: "demo_v0",
      spec,
      specVersion: DEMO_SPEC_VERSION,
      buildStatus: "building",
      artifactKey: null as string | null,
    };
    const siteUpdateMany = vi.fn(async () => ({ count: 1 }));
    const releaseUpdateMany = vi.fn(async () => ({ count: 1 }));
    const runUpdateMany = vi.fn(
      async ({ data }: { data: Record<string, unknown> }) => {
        if (typeof data.status === "string") runStatus = data.status;
        return { count: 1 };
      },
    );
    const tx = {
      $executeRaw: vi.fn(async () => 0),
      siteBuildRun: {
        findUnique: vi.fn(async () => ({ status: runStatus })),
        update: vi.fn(async () => ({})),
        updateMany: runUpdateMany,
      },
      site: {
        findUnique: vi.fn(async () => ({
          id: "site-1",
          name: "Acme",
          slug: "acme",
          stylePreset: "clean",
          intake: INTAKE,
          activeVersionId: "old-version",
        })),
        update: vi.fn(async () => ({})),
        updateMany: siteUpdateMany,
      },
      siteVersion: {
        findFirst: vi.fn(async () => version),
        deleteMany: vi.fn(async () => ({ count: 1 })),
        aggregate: vi.fn(async () => ({ _max: { version: 1 } })),
        create: vi.fn(async () => {
          throw new Error("demo retry must reuse its durable SiteVersion");
        }),
        update: vi.fn(async () => ({})),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      siteRelease: { updateMany: releaseUpdateMany },
    };
    const renderSiteSpec = vi.fn(
      async (_doc: unknown, output: { outDir: string }) => {
        await mkdir(output.outDir, { recursive: true });
        await writeFile(path.join(output.outDir, "index.html"), "candidate");
        if (options?.cancelDuringRender) runStatus = "cancelled";
        if (options?.renderError) throw options.renderError;
      },
    );
    return {
      tx,
      version,
      renderSiteSpec,
      siteUpdateMany,
      releaseUpdateMany,
      runUpdateMany,
    };
  }

  it("reuses the run-scoped version, materializes one Release, then atomically advances the pointer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "r1-demo-release-"));
    vi.stubEnv("PREVIEW_DIR", root);
    const state = retryingDemoTx();
    const materialize = vi.fn(async () => {
      state.version.buildStatus = "succeeded";
      state.version.artifactKey = "release:release-1";
      return {
        releaseId: "release-1",
        artifactKey: "release:release-1",
        artifactPrefix: "sites/site-1/releases/release-1",
        artifactDigest: "a".repeat(64),
        manifestDigest: "b".repeat(64),
        producerToken: "producer-1",
      };
    });
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(state.tx),
      renderSiteSpec: state.renderSiteSpec,
      releaseService: { materialize } as never,
    });
    try {
      await expect(acts.generateDemoV0(INPUT)).resolves.toEqual({
        previewSlug: "acme",
      });
      expect(state.tx.siteVersion.deleteMany).not.toHaveBeenCalled();
      expect(state.tx.siteVersion.create).not.toHaveBeenCalled();
      expect(materialize).toHaveBeenCalledWith(
        expect.objectContaining({
          siteVersionId: "version-1",
          buildRunId: "run-1",
          storedSpecVersion: DEMO_SPEC_VERSION,
          root: path.join(root, ".staging", "run-1"),
        }),
      );
      expect(state.siteUpdateMany).toHaveBeenCalledWith({
        where: {
          id: "site-1",
          OR: [
            { activeVersionId: "old-version" },
            { activeVersionId: "version-1" },
          ],
        },
        data: { activeVersionId: "version-1", status: "ready" },
      });
      expect(state.releaseUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "release-1", status: "ready" },
          data: { lastActivatedAt: expect.any(Date) },
        }),
      );
      expect(state.runUpdateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "run-1", status: "running" },
          data: expect.objectContaining({ status: "succeeded", progress: 1 }),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets cancellation win after rendering and never uploads or advances the old pointer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "r1-demo-cancel-"));
    vi.stubEnv("PREVIEW_DIR", root);
    const state = retryingDemoTx({ cancelDuringRender: true });
    const materialize = vi.fn();
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(state.tx),
      renderSiteSpec: state.renderSiteSpec,
      releaseService: { materialize } as never,
    });
    try {
      await expect(acts.generateDemoV0(INPUT)).rejects.toThrow(
        "rendered candidate discarded",
      );
      expect(materialize).not.toHaveBeenCalled();
      expect(state.siteUpdateMany).not.toHaveBeenCalled();
      expect(state.releaseUpdateMany).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("leaves transient activity failures retryable until the workflow exhausts its attempts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "r1-demo-retryable-"));
    vi.stubEnv("PREVIEW_DIR", root);
    const transient = new Error("renderer node restarted");
    const state = retryingDemoTx({ renderError: transient });
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(state.tx),
      renderSiteSpec: state.renderSiteSpec,
      releaseService: { materialize: vi.fn() } as never,
    });
    try {
      await expect(acts.generateDemoV0(INPUT)).rejects.toBe(transient);
      expect(state.tx.site.update).not.toHaveBeenCalled();
      expect(state.runUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "failed" }),
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("cleanupFailedDemo — R0-6 不删站、置 setup_failed（保留用户数据、可原地重试）", () => {
  it("本 run 仍最新 → 保留 site 置 setup_failed + 清本 run building 孤儿版本，绝不 site.delete", async () => {
    const del = vi.fn(async () => ({}));
    const update = vi.fn(async () => ({}));
    const runUpdateMany = vi.fn(async () => ({ count: 1 }));
    const versionUpdateMany = vi.fn(async () => ({ count: 1 }));
    const tx = {
      siteBuildRun: {
        findFirst: async () => ({ id: "run-1" }),
        updateMany: runUpdateMany,
      }, // 最新 demo_v0 run = 本 run
      siteVersion: { updateMany: versionUpdateMany },
      site: { delete: del, update },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.cleanupFailedDemo(INPUT);
    expect(del).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith({
      where: { id: "site-1" },
      data: { status: "setup_failed" },
    });
    expect(versionUpdateMany).toHaveBeenCalledWith({
      where: { buildRunId: "run-1", buildStatus: "building" },
      data: { buildStatus: "failed" },
    });
    expect(runUpdateMany).toHaveBeenCalledWith({
      where: { id: "run-1", status: "running" },
      data: {
        status: "failed",
        error: "demo v0 workflow failed after retries",
        finishedAt: expect.any(Date),
      },
    });
  });

  it("P1 迟到重试守卫：有更新的 demo_v0 run 已接管（re-intake 后）→ cleanup 作废，不 clobber 成功站", async () => {
    const update = vi.fn(async () => ({}));
    const versionUpdateMany = vi.fn(async () => ({ count: 0 }));
    const tx = {
      siteBuildRun: { findFirst: async () => ({ id: "run-2" }) }, // 更新的 run 已接管（run-2 ≠ run-1）
      siteVersion: { updateMany: versionUpdateMany },
      site: { update, delete: vi.fn() },
    };
    const acts = createSiteBuilderActivities({ prisma: fakePrisma(tx) });
    await acts.cleanupFailedDemo(INPUT); // INPUT.buildRunId = 'run-1'
    expect(update).not.toHaveBeenCalled(); // 不动 site
    expect(versionUpdateMany).not.toHaveBeenCalled(); // 也不动版本
  });
});

describe("activity dependency and heartbeat boundaries", () => {
  it("rejects composition without an exact renderer identity", () => {
    expect(() =>
      createSiteBuilderActivitiesRaw({ prisma: fakePrisma({}) }),
    ).toThrow("RENDERER_BUILD_IDENTITY_REQUIRED");
  });
  it("reports unavailable optional image and KB work without dispatch", async () => {
    const acts = createSiteBuilderActivities({ prisma: fakePrisma({}) });
    await expect(acts.listImages(INPUT)).rejects.toThrow(
      "image pipeline unavailable",
    );
    expect(await acts.processImages(INPUT)).toMatchObject({
      status: "degraded",
      processed: 0,
    });
    expect(await acts.ingestPendingKb(INPUT)).toEqual({
      processed: 0,
      failed: 0,
    });
    expect(await acts.processQueuedKbDocs(INPUT)).toEqual({
      processed: 0,
      failed: 0,
    });
    expect(await acts.processKbAsset({ ...INPUT, assetId: "asset-1" })).toEqual(
      { assetId: "asset-1", outcome: "not_due" },
    );
    expect(await acts.listKbRecoveryCandidates({ limit: 1 })).toEqual([]);
  });
  it("delegates image membership freeze with exact workspace and site", async () => {
    const listSiteImageIds = vi
      .fn()
      .mockResolvedValue({ assetIds: ["a"], truncated: false });
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({}),
      imagePipeline: { listSiteImageIds } as never,
    });
    expect(await acts.listImages(INPUT)).toEqual({
      assetIds: ["a"],
      truncated: false,
    });
    expect(listSiteImageIds).toHaveBeenCalledWith({
      workspaceId: INPUT.workspaceId,
      siteId: INPUT.siteId,
    });
  });
  it.each(["images", "queued", "asset"] as const)(
    "propagates cancellation and heartbeats during %s work and clears the timer",
    async (kind) => {
      vi.useFakeTimers();
      const heartbeat = vi.fn();
      const abort = new AbortController();
      vi.spyOn(ActivityContext, "current").mockReturnValue({
        heartbeat,
        cancellationSignal: abort.signal,
      } as never);
      let finish!: () => void;
      const work = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const processSiteImages = vi.fn(async (_input, signal) => {
        expect(signal).toBe(abort.signal);
        await work;
        return { status: "done" };
      });
      const processQueued = vi.fn(async (_ctx, _site, options) => {
        expect(options.signal).toBe(abort.signal);
        options.heartbeat("parsing");
        await work;
        return { processed: 1, failed: 0 };
      });
      const processAsset = vi.fn(async (_ctx, _site, _asset, options) => {
        expect(options.signal).toBe(abort.signal);
        options.heartbeat("embedding");
        await work;
        return { outcome: "ready" };
      });
      const acts = createSiteBuilderActivities({
        prisma: fakePrisma({}),
        imagePipeline: { processSiteImages } as never,
        kb: { processQueued, processAsset } as never,
      });
      try {
        const pending =
          kind === "images"
            ? acts.processImages(INPUT)
            : kind === "queued"
              ? acts.processQueuedKbDocs(INPUT)
              : acts.processKbAsset({ ...INPUT, assetId: "a" });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(heartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
        finish();
        await pending;
        const count = heartbeat.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(heartbeat).toHaveBeenCalledTimes(count);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  it("propagates KB failure while releasing the heartbeat interval", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn();
    vi.spyOn(ActivityContext, "current").mockReturnValue({
      heartbeat,
      cancellationSignal: new AbortController().signal,
    } as never);
    const failure = new Error("synthetic parser failure");
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({}),
      kb: { processAsset: vi.fn().mockRejectedValue(failure) } as never,
    });
    try {
      await expect(
        acts.processKbAsset({ ...INPUT, assetId: "a" }),
      ).rejects.toBe(failure);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("alerts on old or repeatedly retried KB work without writing through owner DB", async () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);
    const rows = [
      {
        id: "a",
        workspaceId: "ws",
        siteId: "site",
        processingStatus: "processing",
        processingAttempt: 5,
        createdAt: new Date(),
        retryAt: new Date(0),
        leaseUntil: new Date(0),
        processingErrorCode: "DEPENDENCY_UNAVAILABLE",
      },
      {
        id: "b",
        workspaceId: "ws",
        siteId: "site",
        processingStatus: "queued",
        processingAttempt: 0,
        createdAt: new Date(0),
        retryAt: null,
        leaseUntil: null,
        processingErrorCode: null,
      },
      {
        id: "c",
        workspaceId: "ws",
        siteId: "site",
        processingStatus: "queued",
        processingAttempt: 0,
        createdAt: new Date(),
        retryAt: null,
        leaseUntil: null,
        processingErrorCode: null,
      },
    ];
    const findMany = vi.fn().mockResolvedValue(rows);
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({}),
      ownerDb: { asset: { findMany } } as never,
    });
    expect(await acts.listKbRecoveryCandidates({ limit: 999 })).toEqual(
      rows.map((r) => ({
        workspaceId: r.workspaceId,
        siteId: r.siteId,
        assetId: r.id,
      })),
    );
    expect(findMany.mock.calls[0][0].take).toBe(500);
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

describe("reconciliation cursor and terminal settlement boundaries", () => {
  it.each([undefined, NaN, -5, 2.9])(
    "bounds requested page size %s",
    async (limit) => {
      const query = vi.fn().mockResolvedValue([]);
      const acts = createSiteBuilderActivities({
        prisma: fakePrisma({}),
        ownerDb: { $queryRaw: query } as never,
      });
      expect(await acts.sweepSiteBuildCostReconciliation({ limit })).toEqual({
        workspaces: 0,
        attempted: 0,
        resolved: 0,
        nextCursor: null,
      });
      expect(query.mock.calls[0][0].values.at(-1)).toBe(
        limit === -5 ? 1 : limit === 2.9 ? 2 : 10,
      );
    },
  );
  it.each([
    { workspaceId: 3, lastAttempt: null },
    { workspaceId: "not-an-id", lastAttempt: null },
    { workspaceId: "a".repeat(32), lastAttempt: "invalid-date" },
    { workspaceId: "a".repeat(32), lastAttempt: 5 },
  ])(
    "rejects malformed cursor before tenant enumeration %j",
    async (cursor) => {
      const query = vi.fn();
      const acts = createSiteBuilderActivities({
        prisma: fakePrisma({}),
        ownerDb: { $queryRaw: query } as never,
      });
      await expect(
        acts.sweepSiteBuildCostReconciliation({ cursor: cursor as never }),
      ).rejects.toThrow("CURSOR_INVALID");
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("fails closed without an owner enumerator", async () => {
    await expect(
      createSiteBuilderActivities({
        prisma: fakePrisma({}),
      }).sweepSiteBuildCostReconciliation({}),
    ).rejects.toThrow("RECONCILIATION_UNAVAILABLE");
  });
  it("rejects a broken returned cursor instead of permitting repeated enumeration", async () => {
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({}),
      ownerDb: {
        $queryRaw: vi
          .fn()
          .mockResolvedValue([{ workspaceId: "", lastAttempt: null }]),
      } as never,
      costLedger: {
        assertAuthorizedBudget: vi.fn(),
        closeAndSummarize: vi.fn(),
        runReconciliationSweep: vi
          .fn()
          .mockResolvedValue({ attempted: 0, resolved: 0 }),
      } as never,
    });
    await expect(acts.sweepSiteBuildCostReconciliation({})).rejects.toThrow(
      "CURSOR_BROKEN",
    );
  });
  it.each([
    "summary",
    "unknown",
    "summary-paid",
    "summary-reason",
    "budget",
    "budget-paid",
    "budget-reason",
  ])("does not publish when %s settlement gate is absent", (gap) => {
    const summary = {
      totals: { unknownOperations: gap === "unknown" ? 1 : 0 },
      budget: {
        paidCallsEnabled: gap === "summary-paid",
        disabledReason: gap === "summary-reason" ? "manual" : "run_succeeded",
      },
    };
    const budget = {
      paidCallsEnabled: gap === "budget-paid",
      disabledReason: gap === "budget-reason" ? null : "run_succeeded",
    };
    expect(
      qualitySettlementIsPublishable(
        gap === "summary" ? undefined : (summary as never),
        gap === "budget" ? undefined : budget,
      ),
    ).toBe(false);
  });
  it("uses the documented preview origin fallback for an invalid operator URL pattern", () => {
    vi.stubEnv("PREVIEW_URL_PATTERN", "not-a-url");
    expect(previewOrigin("demo")).toBe("http://localhost:3000");
    expect(previewBasePath("demo")).toBe("/preview/demo/");
  });
});

describe("design brief activity freezes only supported capability facts", () => {
  it.each([false, true])(
    "projects optional BrandProfile/locales consistently, populated=%s",
    async (populated) => {
      const produce = vi
        .spyOn(DesignBriefProducer.prototype, "produce")
        .mockResolvedValue({ designBrief: {} } as never);
      const site = {
        id: INPUT.siteId,
        intake: populated ? { company: { nameEn: "Synthetic" } } : [],
        locales: populated ? ["en-us", 1] : null,
        stylePreset: populated ? "industrial" : "unrecognized",
        brandProfiles: populated
          ? [
              {
                keywords: [" pump ", 1],
                valueProps: { a: "Quality", nested: [null, "Quality"] },
                differentiators: null,
                factSheet: false,
                _count: { evidenceRefs: 2 },
              },
            ]
          : [],
        assets: ["ready", "failed", "queued", "rejected", "deleted"]
          .map((processingStatus, i) => ({
            id: `a-${i}`,
            kind: "product_image",
            processingStatus,
          }))
          .concat([
            { id: "ignored", kind: "unsupported", processingStatus: "ready" },
          ]),
      };
      const acts = createSiteBuilderActivities({
        prisma: fakePrisma({
          site: { findFirst: vi.fn().mockResolvedValue(site) },
        }),
      });
      expect(await acts.generateDesignBrief(INPUT)).toMatchObject({
        source: "generated",
      });
      const input = produce.mock.calls[0][0];
      expect(input.locales).toEqual(populated ? ["en-US"] : ["en"]);
      expect(input.assetCapabilities.assets.map((a) => a.status)).toEqual([
        "ready",
        "failed",
        "pending",
        "failed",
        "failed",
      ]);
      if (populated)
        expect(input.brandProfile?.industryTags).toEqual(["pump", "Quality"]);
      else expect(input.brandProfile).toBeUndefined();
    },
  );
  it("rejects missing Site before producer invocation", async () => {
    const produce = vi.spyOn(DesignBriefProducer.prototype, "produce");
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({
        site: { findFirst: vi.fn().mockResolvedValue(null) },
      }),
    });
    await expect(acts.generateDesignBrief(INPUT)).rejects.toThrow("not found");
    expect(produce).not.toHaveBeenCalled();
  });
});

function copyActivityFixture() {
  const golden = buildM1ebGoldenAssemblyInputs(
    ControlledAssets.resolveRepositoryRoot(),
  )[0].assembly;
  const site = {
    name: "Synthetic Company",
    intake: INTAKE,
    stylePreset: null,
    brandProfiles: [],
  };
  const snapshot = {
    ...golden.claimSnapshot,
    siteId: INPUT.siteId,
    workspaceId: INPUT.workspaceId,
    buildRunId: INPUT.buildRunId,
  };
  vi.spyOn(
    PublishableClaimSnapshotService.prototype,
    "capture",
  ).mockResolvedValue(snapshot);
  const tx = {
    site: { findFirst: vi.fn().mockResolvedValue(site) },
    sitePublishableClaimSnapshot: {
      findUnique: vi.fn().mockResolvedValue({ id: "snapshot-copy" }),
    },
  };
  const ledger = {
    assertAuthorizedBudget: vi.fn().mockResolvedValue(undefined),
    closeAndSummarize: vi.fn(),
    claimTaskAttempt: vi
      .fn()
      .mockResolvedValue({
        kind: "claimed",
        attempt: { id: "attempt-copy", fenceToken: "synthetic-fence" },
      }),
    freezeTaskInput: vi.fn(async (_fence, input) => ({ input })),
    storeTaskOutput: vi.fn().mockResolvedValue(undefined),
    completeTask: vi.fn().mockResolvedValue(undefined),
    releaseTask: vi.fn().mockResolvedValue(undefined),
  };
  const run = vi
    .spyOn(AiTasks, "runAiTask")
    .mockImplementation(
      async (_task, input) =>
        ({
          data: neutralCopyOutput(
            (input as { slots: CopySlotDefinition[] }).slots,
            (input as { locale: string }).locale,
          ),
        }) as never,
    );
  const gateway = {
    generateStructured: vi.fn(() => {
      throw new Error("unexpected external gateway dispatch");
    }),
  };
  const acts = createSiteBuilderActivities({
    prisma: fakePrisma(tx),
    costLedger: ledger as never,
    gateway: gateway as never,
  });
  return { acts, tx, ledger, run, site, gateway, golden };
}
describe("copy activity input freezing and paid-task settlement", () => {
  it("freezes one locale task and persists controlled output before marking it complete", async () => {
    const f = copyActivityFixture();
    const order: string[] = [];
    f.ledger.storeTaskOutput.mockImplementation(async () => {
      order.push("store");
    });
    f.ledger.completeTask.mockImplementation(async () => {
      order.push("complete");
    });
    const result = await f.acts.generateCopyBundles(INPUT);
    expect(result.taskAttemptIds).toEqual({ en: "attempt-copy" });
    expect(f.ledger.claimTaskAttempt).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
    expect(order).toEqual(["store", "complete"]);
    expect(f.ledger.releaseTask).not.toHaveBeenCalled();
    expect(f.gateway.generateStructured).not.toHaveBeenCalled();
  });
  it.each(["snapshot", "site"])(
    "rejects vanished %s after snapshot capture",
    async (missing) => {
      const f = copyActivityFixture();
      if (missing === "snapshot")
        f.tx.sitePublishableClaimSnapshot.findUnique.mockResolvedValue(null);
      else f.tx.site.findFirst.mockResolvedValue(null);
      await expect(f.acts.generateCopyBundles(INPUT)).rejects.toThrow(
        "disappeared",
      );
      expect(f.ledger.claimTaskAttempt).not.toHaveBeenCalled();
    },
  );
  it("rejects a malformed frozen envelope and releases the task without dispatch", async () => {
    const f = copyActivityFixture();
    f.ledger.freezeTaskInput.mockResolvedValue({ input: { invalid: true } });
    await expect(f.acts.generateCopyBundles(INPUT)).rejects.toThrow();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.ledger.releaseTask).toHaveBeenCalled();
  });
  it.each(["attempt", "version", "context", "slots"])(
    "rejects completed task %s drift instead of reusing unbound output",
    async (field) => {
      const f = copyActivityFixture();
      const contextDigest = copyGenerationContextDigest(
        buildCopyGenerationContext({
          locale: "en",
          intake: f.site.intake,
          brandProfile: null,
        }),
      );
      const replay: Record<string, unknown> = {
        taskAttemptId: "attempt-copy",
        contractVersion: COPY_GENERATION_CONTRACT_VERSION,
        contextDigest,
        slots: {},
      };
      if (field === "attempt") delete replay.taskAttemptId;
      if (field === "version") replay.contractVersion = "old";
      if (field === "context") replay.contextDigest = "other";
      if (field === "slots") delete replay.slots;
      f.ledger.claimTaskAttempt.mockResolvedValue({
        kind: "completed",
        result: replay,
      } as never);
      await expect(f.acts.generateCopyBundles(INPUT)).rejects.toThrow();
      expect(f.run).not.toHaveBeenCalled();
      expect(f.ledger.freezeTaskInput).not.toHaveBeenCalled();
    },
  );
  it.each(["store", "complete"])(
    "releases unsettled tasks after durable %s failure",
    async (stage) => {
      const f = copyActivityFixture();
      const failure = new Error("synthetic persistence failure");
      (stage === "store"
        ? f.ledger.storeTaskOutput
        : f.ledger.completeTask
      ).mockRejectedValue(failure);
      await expect(f.acts.generateCopyBundles(INPUT)).rejects.toBe(failure);
      expect(f.ledger.releaseTask).toHaveBeenCalledOnce();
    },
  );
});

let activityGoldenFixtures: Awaited<ReturnType<typeof buildM1ebGoldenFixtures>>;
let activityAssemblyInputs: ReturnType<typeof buildM1ebGoldenAssemblyInputs>;
beforeAll(async () => {
  const root = ControlledAssets.resolveRepositoryRoot();
  activityAssemblyInputs = buildM1ebGoldenAssemblyInputs(root);
  activityGoldenFixtures = await buildM1ebGoldenFixtures(root);
});
async function controlledActivityFixture() {
  const golden = activityGoldenFixtures[0];
  const assembly = activityAssemblyInputs.find(
    (entry) => entry.id === golden.id,
  )!.assembly;
  const root = await mkdtemp(
    path.join(tmpdir(), "activity-coverage-candidate-"),
  );
  vi.stubEnv("PREVIEW_DIR", root);
  const snapshot = { ...assembly.claimSnapshot, siteId: INPUT.siteId };
  const snapshotId = Object.values(assembly.copyBundleSet.bundles)[0]
    .claimSnapshot.id;
  const input = {
    ...INPUT,
    designBrief: { source: "generated", designBrief: golden.designBrief },
    copy: {
      snapshotId,
      set: assembly.copyBundleSet,
      degradedLocales: [],
      taskAttemptIds: Object.fromEntries(
        Object.keys(assembly.copyBundleSet.bundles).map((locale) => [
          locale,
          "attempt-copy",
        ]),
      ),
    },
  } as RefurbishQualityCandidateInput;
  const tx = {
    siteBuildRun: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
    },
    site: {
      findFirst: vi
        .fn()
        .mockResolvedValue({
          id: INPUT.siteId,
          name: assembly.siteName,
          slug: "synthetic",
        }),
    },
    siteVersion: {
      findFirst: vi.fn().mockResolvedValue(null),
      aggregate: vi.fn().mockResolvedValue({ _max: { version: 1 } }),
      create: vi
        .fn()
        .mockResolvedValue({
          id: "version-candidate",
          buildStatus: "building",
        }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    siteCopyBundle: { createMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
  const snapshotRead = vi
    .spyOn(PrismaPublishableClaimSnapshotRepository.prototype, "findById")
    .mockResolvedValue(snapshot);
  vi.spyOn(ControlledAssets, "buildControlledAssetManifest").mockResolvedValue(
    assembly.assets,
  );
  const assemble = vi
    .spyOn(ControlledAssemblyService.prototype, "assemble")
    .mockResolvedValue({
      spec: golden.spec,
      designBrief: golden.designBrief,
    } as never);
  const cleanup = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(
    AssetMaterializer,
    "materializeControlledAssetOverlay",
  ).mockResolvedValue({ publicDir: root, cleanup } as never);
  const render = vi.fn().mockResolvedValue({ treeDigest: "a".repeat(64) });
  const materialize = vi.fn().mockResolvedValue({});
  const deps = {
    prisma: fakePrisma(tx),
    releaseService: { materialize } as never,
    qualityCandidateService: {} as never,
    renderSiteSpec: render as never,
  };
  const acts = createSiteBuilderActivities(deps);
  return {
    acts,
    deps,
    tx,
    input,
    snapshotRead,
    assemble,
    render,
    cleanup,
    materialize,
    root,
    golden,
    snapshot,
  };
}
describe("controlled assembly activity fencing", () => {
  it.each(["input", "release", "quality"])(
    "requires %s dependencies before rendering",
    async (missing) => {
      const f = await controlledActivityFixture();
      try {
        const acts = createSiteBuilderActivities({
          ...f.deps,
          ...(missing === "release" ? { releaseService: undefined } : {}),
          ...(missing === "quality"
            ? { qualityCandidateService: undefined }
            : {}),
        });
        await expect(
          acts.assembleQualityCandidate(
            (missing === "input"
              ? INPUT
              : f.input) as RefurbishQualityCandidateInput,
          ),
        ).rejects.toThrow(
          missing === "input"
            ? "INPUT_MISSING"
            : missing === "release"
              ? "RELEASE_SERVICE_UNAVAILABLE"
              : "CANDIDATE_SERVICE_UNAVAILABLE",
        );
        expect(f.render).not.toHaveBeenCalled();
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
  it.each([
    "run",
    "site",
    "snapshot",
    "snapshot-site",
    "bundle-id",
    "bundle-digest",
  ])("rejects %s drift before assembly", async (field) => {
    const f = await controlledActivityFixture();
    try {
      if (field === "run")
        f.tx.siteBuildRun.updateMany.mockResolvedValue({ count: 0 });
      if (field === "site") f.tx.site.findFirst.mockResolvedValue(null);
      if (field === "snapshot") f.snapshotRead.mockResolvedValue(null);
      if (field === "snapshot-site")
        f.snapshotRead.mockResolvedValue({ ...f.snapshot, siteId: "other" });
      const input = structuredClone(f.input);
      if (field.startsWith("bundle")) {
        const bundle = Object.values(input.copy!.set.bundles)[0];
        if (field === "bundle-id") bundle.claimSnapshot.id = "other";
        else bundle.claimSnapshot.digest = "other";
      }
      await expect(f.acts.assembleQualityCandidate(input)).rejects.toThrow();
      expect(f.assemble).not.toHaveBeenCalled();
      expect(f.render).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it.each(["succeeded", "failed"])(
    "does not reuse a %s version as a mutable quality candidate",
    async (buildStatus) => {
      const f = await controlledActivityFixture();
      try {
        f.tx.siteVersion.findFirst.mockResolvedValue({
          id: "old",
          buildStatus,
        });
        await expect(
          f.acts.assembleQualityCandidate(f.input),
        ).rejects.toThrow();
        expect(f.render).not.toHaveBeenCalled();
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
  it("requires a durable ready Release before legacy successful-version replay", async () => {
    const f = await controlledActivityFixture();
    try {
      f.tx.siteVersion.findFirst.mockResolvedValue({
        id: "old",
        buildStatus: "succeeded",
        spec: f.golden.spec,
        release: null,
      });
      await expect(f.acts.assembleAndBuild(f.input)).rejects.toThrow(
        "REPLAY_INVALID",
      );
      expect(f.render).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("materializes a validated legacy candidate only after render and active-run recheck", async () => {
    const f = await controlledActivityFixture();
    try {
      expect(await f.acts.assembleAndBuild(f.input)).toMatchObject({
        previewSlug: "synthetic",
        versionId: "version-candidate",
      });
      expect(f.tx.siteVersion.create).toHaveBeenCalledOnce();
      expect(f.tx.siteCopyBundle.createMany).toHaveBeenCalledOnce();
      expect(f.render).toHaveBeenCalledOnce();
      expect(f.cleanup).toHaveBeenCalledOnce();
      expect(f.materialize).toHaveBeenCalledOnce();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("reuses a building version instead of allocating another version on retry", async () => {
    const f = await controlledActivityFixture();
    try {
      f.tx.siteVersion.findFirst.mockResolvedValue({
        id: "existing",
        buildStatus: "building",
        spec: f.golden.spec,
      });
      expect(await f.acts.assembleAndBuild(f.input)).toMatchObject({
        versionId: "existing",
      });
      expect(f.tx.siteVersion.create).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it.each(["cancelled", "missing"])(
    "discards rendered output when the run becomes %s",
    async (status) => {
      const f = await controlledActivityFixture();
      try {
        f.tx.siteBuildRun.findUnique.mockResolvedValue(
          status === "missing" ? null : { status },
        );
        await expect(f.acts.assembleAndBuild(f.input)).rejects.toThrow(
          "discarded",
        );
        expect(f.tx.siteVersion.updateMany).toHaveBeenCalledWith({
          where: { id: "version-candidate", buildStatus: "building" },
          data: { buildStatus: "failed" },
        });
        expect(f.materialize).not.toHaveBeenCalled();
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
  it("retains the copy task ownership requirement when allocating the candidate", async () => {
    const f = await controlledActivityFixture();
    try {
      const input = structuredClone(f.input);
      input.copy!.taskAttemptIds = {};
      await expect(f.acts.assembleAndBuild(input)).rejects.toThrow(
        "copy task attempt missing",
      );
      expect(f.render).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("cleans the overlay if renderer fails, before propagating the error", async () => {
    const f = await controlledActivityFixture();
    const failure = new Error("synthetic render failure");
    try {
      f.render.mockRejectedValue(failure);
      await expect(f.acts.assembleAndBuild(f.input)).rejects.toBe(failure);
      expect(f.cleanup).toHaveBeenCalledOnce();
      expect(f.materialize).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("does not emit a new quality history without immutable artifact storage", async () => {
    const f = await controlledActivityFixture();
    try {
      await expect(f.acts.assembleQualityCandidate(f.input)).rejects.toThrow(
        "ARTIFACT_UNAVAILABLE",
      );
      expect(f.render).toHaveBeenCalledOnce();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

async function qualityActivityFixture() {
  const f = await controlledActivityFixture();
  const candidate = {
    workspaceId: INPUT.workspaceId,
    siteId: INPUT.siteId,
    buildRunId: INPUT.buildRunId,
    siteVersionId: "version-candidate",
    specDigest: releaseSpecDigest(f.golden.spec),
    designBriefDigest: f.golden.designBrief.digest,
    rendererOutputDigest: "b".repeat(64),
    basePath: "/preview/synthetic/",
    siteOrigin: "http://localhost:3000",
    root: path.join(f.root, "staging", INPUT.buildRunId),
  };
  const version = {
    buildStatus: "building",
    specVersion: f.golden.spec.specVersion,
    spec: f.golden.spec,
  };
  f.tx.siteVersion.findFirst.mockResolvedValue(version);
  const budget = {
    findUnique: vi.fn().mockResolvedValue({ paidCallsEnabled: true }),
  };
  const spend = { count: vi.fn().mockResolvedValue(0) };
  const qualityCandidateService = {
    evaluateQualityCandidate: vi
      .fn()
      .mockRejectedValue(new Error("synthetic evaluator reached")),
    applyQualityRepair: vi.fn(),
    materializeApprovedRelease: vi.fn(),
  };
  const closedRepairService = {
    generateCatalog: vi.fn().mockReturnValue({ catalog: { options: [] } }),
  };
  const deps = {
    ...f.deps,
    prisma: fakePrisma({
      ...f.tx,
      siteBuildBudget: budget,
      siteBuildSpend: spend,
    }),
    qualityCandidateService: qualityCandidateService as never,
    closedRepairService: closedRepairService as never,
  };
  const acts = createSiteBuilderActivities(deps);
  const input = {
    ...f.input,
    qualityCandidate: {
      previewSlug: "synthetic",
      versionId: "version-candidate",
      designBrief: f.golden.designBrief,
      candidateSpec: f.golden.spec,
      candidate,
    },
    round: 0,
    qualityEvaluation: {
      passed: true,
      evaluation: { round: 0 },
      artifactSet: {},
    },
    rounds: [],
  };
  return {
    ...f,
    acts,
    deps,
    input,
    version,
    budget,
    spend,
    qualityCandidateService,
    closedRepairService,
  };
}
describe("quality activity run and paid-state fencing", () => {
  it.each([
    "evaluateQualityCandidate",
    "applyQualityRepair",
    "materializeApprovedRelease",
  ] as const)("requires the candidate service for %s", async (method) => {
    const acts = createSiteBuilderActivities({ prisma: fakePrisma({}) });
    await expect(acts[method](INPUT as never)).rejects.toThrow(
      "CANDIDATE_SERVICE_UNAVAILABLE",
    );
  });
  it.each(["missing", "cancelled"])(
    "rejects deterministic evaluation for a %s run",
    async (status) => {
      const f = await qualityActivityFixture();
      try {
        f.tx.siteBuildRun.findUnique.mockResolvedValue(
          status === "missing" ? null : { status },
        );
        await expect(
          f.acts.evaluateQualityCandidate(f.input as never),
        ).rejects.toThrow("build run is not running");
        expect(
          f.qualityCandidateService.evaluateQualityCandidate,
        ).not.toHaveBeenCalled();
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
  it.each([
    "run",
    "site",
    "version",
    "spec-version",
    "build-status",
    "spec-digest",
    "brief-digest",
    "snapshot",
    "snapshot-site",
  ])("refuses candidate %s drift before evaluator work", async (gap) => {
    const f = await qualityActivityFixture();
    try {
      if (gap === "run")
        f.tx.siteBuildRun.findUnique
          .mockResolvedValueOnce({ status: "running" })
          .mockResolvedValue({ status: "cancelled" });
      if (gap === "site") f.tx.site.findFirst.mockResolvedValue(null);
      if (gap === "version") f.tx.siteVersion.findFirst.mockResolvedValue(null);
      if (gap === "spec-version")
        f.tx.siteVersion.findFirst.mockResolvedValue({
          ...f.version,
          specVersion: "old",
        });
      if (gap === "build-status")
        f.tx.siteVersion.findFirst.mockResolvedValue({
          ...f.version,
          buildStatus: "failed",
        });
      if (gap === "spec-digest")
        f.input.qualityCandidate.candidate.specDigest = "wrong";
      if (gap === "brief-digest")
        f.input.qualityCandidate.candidate.designBriefDigest = "wrong";
      if (gap === "snapshot") f.snapshotRead.mockResolvedValue(null);
      if (gap === "snapshot-site")
        f.snapshotRead.mockResolvedValue({ ...f.snapshot, siteId: "other" });
      await expect(
        f.acts.evaluateQualityCandidate(f.input as never),
      ).rejects.toThrow(
        gap.startsWith("snapshot") ? "SNAPSHOT_MISSING" : "FENCE_LOST",
      );
      expect(
        f.qualityCandidateService.evaluateQualityCandidate,
      ).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it.each(["missing", "different"])(
    "refuses %s legacy root outside exact run staging",
    async (root) => {
      const f = await qualityActivityFixture();
      try {
        f.input.qualityCandidate.candidate.root =
          root === "missing" ? "" : path.join(f.root, "other");
        await expect(
          f.acts.evaluateQualityCandidate(f.input as never),
        ).rejects.toThrow("ARTIFACT_INVALID");
      } finally {
        await rm(f.root, { recursive: true, force: true });
      }
    },
  );
  it.each([
    "missing-run",
    "cancelled",
    "missing-budget",
    "disabled",
    "unknown",
  ])("blocks paid repair when %s authority is unresolved", async (gap) => {
    const f = await qualityActivityFixture();
    try {
      if (gap === "missing-run")
        f.tx.siteBuildRun.findUnique.mockResolvedValue(null);
      if (gap === "cancelled")
        f.tx.siteBuildRun.findUnique.mockResolvedValue({ status: "cancelled" });
      if (gap === "missing-budget") f.budget.findUnique.mockResolvedValue(null);
      if (gap === "disabled")
        f.budget.findUnique.mockResolvedValue({ paidCallsEnabled: false });
      if (gap === "unknown") f.spend.count.mockResolvedValue(1);
      await expect(f.acts.applyQualityRepair(f.input as never)).rejects.toThrow(
        "paid execution gate is closed",
      );
      expect(f.closedRepairService.generateCatalog).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("refuses repair after the bounded round limit", async () => {
    const f = await qualityActivityFixture();
    try {
      f.input.qualityEvaluation.evaluation.round = 3;
      await expect(f.acts.applyQualityRepair(f.input as never)).rejects.toThrow(
        "QUALITY_GATE_FAILED",
      );
      expect(f.spend.count).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("does not invent a repair when the closed catalog has no options", async () => {
    const f = await qualityActivityFixture();
    try {
      await expect(f.acts.applyQualityRepair(f.input as never)).rejects.toThrow(
        "REPAIR_OPTION_UNAVAILABLE",
      );
      expect(
        f.qualityCandidateService.applyQualityRepair,
      ).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("cannot materialize a failed quality evaluation", async () => {
    const f = await qualityActivityFixture();
    try {
      f.input.qualityEvaluation.passed = false;
      await expect(
        f.acts.materializeApprovedRelease(f.input as never),
      ).rejects.toThrow("QUALITY_GATE_FAILED");
      expect(
        f.qualityCandidateService.materializeApprovedRelease,
      ).not.toHaveBeenCalled();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

function brandActivityFixture() {
  const sourceRows: Array<Record<string, unknown>> = [];
  const tx = {
    site: {
      findUnique: vi
        .fn()
        .mockResolvedValue({
          id: INPUT.siteId,
          companyProfileId: "company-profile",
          profileVersionId: null,
          intake: INTAKE,
          profile: null,
        }),
    },
    siteBuildRun: {
      findUnique: vi.fn().mockResolvedValue({ status: "running" }),
    },
    siteEvidenceSourceSnapshot: {
      createMany: vi.fn(
        async ({ data }: { data: Array<Record<string, unknown>> }) => {
          sourceRows.push(
            ...data.map((row, i) => ({
              ...row,
              id: `snapshot-${i}`,
              fetchedAt: row.fetchedAt ?? null,
            })),
          );
          return { count: data.length };
        },
      ),
      findMany: vi.fn(async () => sourceRows),
    },
    brandProfile: {
      aggregate: vi.fn().mockResolvedValue({ _max: { version: 2 } }),
      create: vi.fn().mockResolvedValue({}),
    },
    brandProfileEvidenceRef: {
      createMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    siteBuildTaskAttempt: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const claim = {
    kind: "claimed",
    attempt: {
      id: "attempt-brand",
      fenceToken: "synthetic-fence",
      status: "RUNNING",
      outputJson: null as unknown,
    },
  };
  const ledger = {
    assertAuthorizedBudget: vi.fn().mockResolvedValue(undefined),
    closeAndSummarize: vi.fn(),
    claimTaskAttempt: vi.fn().mockResolvedValue(claim),
    freezeTaskInput: vi.fn(async (_fence, input) => ({ input })),
    storeTaskOutput: vi.fn().mockResolvedValue(undefined),
    releaseTask: vi.fn().mockResolvedValue(undefined),
  };
  const output = { data: {}, model: "synthetic-model" };
  const run = vi.spyOn(AiTasks, "runAiTask").mockResolvedValue(output as never);
  const deps = {
    prisma: fakePrisma(tx),
    gateway: {} as never,
    costLedger: ledger as never,
  };
  const acts = createSiteBuilderActivities(deps);
  return { tx, claim, ledger, run, deps, acts, output };
}
describe("BrandProfile activity recovery and durable failure guards", () => {
  it.each([
    "site",
    "run",
    "cancelled",
    "snapshot-run",
    "snapshot-missing",
    "frozen-missing",
    "persist-run",
    "task-cas",
  ])(
    "releases its task without reporting success after %s loss",
    async (stage) => {
      const f = brandActivityFixture();
      if (stage === "site") f.tx.site.findUnique.mockResolvedValue(null);
      if (stage === "run") f.tx.siteBuildRun.findUnique.mockResolvedValue(null);
      if (stage === "cancelled")
        f.tx.siteBuildRun.findUnique.mockResolvedValue({ status: "cancelled" });
      if (stage === "snapshot-run")
        f.tx.siteBuildRun.findUnique
          .mockResolvedValueOnce({ status: "running" })
          .mockResolvedValue(null);
      if (stage === "snapshot-missing")
        f.tx.siteEvidenceSourceSnapshot.findMany.mockResolvedValue([]);
      if (stage === "frozen-missing")
        f.ledger.freezeTaskInput.mockImplementation(async (_fence, input) => {
          f.tx.siteEvidenceSourceSnapshot.findMany.mockResolvedValue([]);
          return { input };
        });
      if (stage === "persist-run")
        f.tx.siteBuildRun.findUnique
          .mockResolvedValueOnce({ status: "running" })
          .mockResolvedValueOnce({ status: "running" })
          .mockResolvedValue(null);
      if (stage === "task-cas")
        f.tx.siteBuildTaskAttempt.updateMany.mockResolvedValue({ count: 0 });
      await expect(f.acts.buildBrandProfile(INPUT)).rejects.toThrow();
      expect(f.ledger.releaseTask).toHaveBeenCalledOnce();
    },
  );
  it("replays a stored model result without issuing another paid task", async () => {
    const f = brandActivityFixture();
    f.claim.attempt.status = "MODEL_SUCCEEDED";
    f.claim.attempt.outputJson = f.output;
    expect(await f.acts.buildBrandProfile(INPUT)).toMatchObject({
      version: 3,
      factCount: 0,
      gapsCount: 0,
      researchDegraded: true,
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.ledger.storeTaskOutput).not.toHaveBeenCalled();
    expect(f.ledger.releaseTask).not.toHaveBeenCalled();
  });
  it("rejects non-object durable replay data at the gateway persistence boundary", async () => {
    const f = brandActivityFixture();
    f.run.mockImplementation(async (_task, _input, options) => {
      const ctx = options as {
        ctx: {
          paidCost: {
            durableReplayResult: (data: Record<string, unknown>) => unknown;
          };
        };
      };
      for (const data of [null, "text", []])
        expect(() => ctx.ctx.paidCost.durableReplayResult({ data })).toThrow(
          "no object data",
        );
      return f.output as never;
    });
    expect(await f.acts.buildBrandProfile(INPUT)).toMatchObject({
      factCount: 0,
    });
  });
  it("preserves optional structured tone and gaps through the controlled projection", async () => {
    const f = brandActivityFixture();
    f.run.mockResolvedValue({
      data: {
        tone: { voice: "professional" },
        gaps: [{ field: "capacity", question: "Provide workspace evidence" }],
      },
      model: "synthetic-model",
    } as never);
    expect(await f.acts.buildBrandProfile(INPUT)).toMatchObject({
      gapsCount: 1,
    });
    expect(f.tx.brandProfile.create.mock.calls[0][0].data.tone).toMatchObject({
      voice: "professional",
      style: [],
    });
  });
});

describe("demo activity replay and claim fencing", () => {
  function demoFixture() {
    const run = {
      status: "running",
      siteId: INPUT.siteId,
      scope: {} as unknown,
    };
    const site = {
      id: INPUT.siteId,
      name: "Synthetic",
      slug: "synthetic",
      intake: INTAKE,
      activeVersionId: "version-1",
      stylePreset: null,
    };
    const version = {
      id: "version-1",
      workspaceId: INPUT.workspaceId,
      siteId: INPUT.siteId,
      source: "demo_v0",
      buildStatus: "succeeded",
      artifactKey: "release:r1",
      spec: {},
    };
    const tx = {
      siteBuildRun: {
        findUnique: vi.fn().mockResolvedValue(run),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      site: { findUnique: vi.fn().mockResolvedValue(site) },
      siteVersion: { findFirst: vi.fn().mockResolvedValue(version) },
    };
    const render = vi.fn();
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(tx),
      renderSiteSpec: render as never,
    });
    return { run, site, version, tx, render, acts };
  }
  it.each([
    "run",
    "site",
    "site-id",
    "workspace",
    "version-site",
    "source",
    "cancelled",
    "base",
    "cas",
  ])("rejects %s mismatch before rendering", async (field) => {
    const f = demoFixture();
    if (field === "run") f.tx.siteBuildRun.findUnique.mockResolvedValue(null);
    if (field === "site") f.tx.site.findUnique.mockResolvedValue(null);
    if (field === "site-id") f.run.siteId = "other";
    if (field === "workspace") f.version.workspaceId = "other";
    if (field === "version-site") f.version.siteId = "other";
    if (field === "source") f.version.source = "build";
    if (field === "cancelled") f.run.status = "cancelled";
    if (field === "base") f.run.scope = { publicationBaseVersionId: 3 };
    if (field === "cas")
      f.tx.siteBuildRun.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.acts.generateDemoV0(INPUT)).rejects.toThrow();
    expect(f.render).not.toHaveBeenCalled();
  });
  it("replays only the active succeeded release without rendering", async () => {
    const f = demoFixture();
    f.run.status = "succeeded";
    expect(await f.acts.generateDemoV0(INPUT)).toEqual({
      previewSlug: "synthetic",
    });
    expect(f.render).not.toHaveBeenCalled();
    expect(f.tx.siteBuildRun.updateMany).not.toHaveBeenCalled();
  });
  it.each(["missing", "status", "artifact", "pointer"])(
    "rejects terminal %s mismatch rather than manufacturing success",
    async (field) => {
      const f = demoFixture();
      f.run.status = "succeeded";
      if (field === "missing")
        f.tx.siteVersion.findFirst.mockResolvedValue(null);
      if (field === "status") f.version.buildStatus = "failed";
      if (field === "artifact") f.version.artifactKey = "local:old";
      if (field === "pointer") f.site.activeVersionId = "other";
      await expect(f.acts.generateDemoV0(INPUT)).rejects.toThrow(
        "TERMINAL_STATE_MISMATCH",
      );
      expect(f.render).not.toHaveBeenCalled();
    },
  );
});

function publicationActivityFixture() {
  const run = { status: "running", scope: {} as unknown };
  const site = { activeVersionId: null as string | null };
  const target = {
    spec: { specVersion: "1.0.0", assets: {}, pages: [] },
    artifactKey: "release:r1",
    copyBundles: [],
  };
  const tx = {
    $queryRaw: vi
      .fn()
      .mockResolvedValue([
        { paid_calls_enabled: false, disabled_reason: "run_succeeded" },
      ]),
    siteBuildRun: {
      findUnique: vi.fn().mockResolvedValue(run),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    site: {
      findUnique: vi.fn().mockResolvedValue(site),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    siteVersion: { findFirst: vi.fn().mockResolvedValue(target) },
    siteRelease: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    sitePublishableClaimSnapshot: {
      findUnique: vi
        .fn()
        .mockResolvedValue({ id: "snapshot-copy", siteId: INPUT.siteId }),
    },
  };
  const summary = {
    totals: { unknownOperations: 0 },
    budget: { paidCallsEnabled: false, disabledReason: "run_succeeded" },
  };
  const costLedger = {
    assertAuthorizedBudget: vi.fn().mockResolvedValue(undefined),
    closeAndSummarize: vi.fn().mockResolvedValue(summary),
  };
  const acts = createSiteBuilderActivities({
    prisma: fakePrisma(tx),
    costLedger: costLedger as never,
  });
  const input: RefurbishFinalizeInput = {
    ...INPUT,
    progressV1: true,
    kb: { processed: 0, failed: 0, degraded: false },
    profile: { status: "done", gaps: 0 },
    build: { previewSlug: "synthetic", versionId: "version-1" },
  };
  return { acts, tx, run, site, target, summary, input, costLedger };
}
describe("final publication authority and snapshot gates", () => {
  it.each([
    "run",
    "site",
    "corrupt-base",
    "cancelled-cas",
    "target",
    "release-cas",
    "pointer-cas",
  ])("does not activate after %s loss", async (failure) => {
    const f = publicationActivityFixture();
    if (failure === "run") f.tx.siteBuildRun.findUnique.mockResolvedValue(null);
    if (failure === "site") f.tx.site.findUnique.mockResolvedValue(null);
    if (failure === "corrupt-base")
      f.run.scope = { publicationBaseVersionId: 99 };
    if (failure === "cancelled-cas")
      f.tx.siteBuildRun.updateMany.mockResolvedValue({ count: 0 });
    if (failure === "target")
      f.tx.siteVersion.findFirst.mockResolvedValue(null);
    if (failure === "release-cas")
      f.tx.siteRelease.updateMany.mockResolvedValue({ count: 0 });
    if (failure === "pointer-cas")
      f.tx.site.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.acts.finalizeRefurbish(f.input)).rejects.toThrow();
    if (
      ["run", "site", "corrupt-base", "cancelled-cas", "target"].includes(
        failure,
      )
    )
      expect(f.tx.siteRelease.updateMany).not.toHaveBeenCalled();
  });
  it.each(["missing-budget", "paid", "reason", "unknown"])(
    "blocks quality publication when settlement %s remains unresolved",
    async (gap) => {
      const f = publicationActivityFixture();
      f.input.qualityV1 = true;
      if (gap === "missing-budget") f.tx.$queryRaw.mockResolvedValue([]);
      if (gap === "paid")
        f.tx.$queryRaw.mockResolvedValue([
          { paid_calls_enabled: true, disabled_reason: "run_succeeded" },
        ]);
      if (gap === "reason")
        f.tx.$queryRaw.mockResolvedValue([
          { paid_calls_enabled: false, disabled_reason: "manual" },
        ]);
      if (gap === "unknown") f.summary.totals.unknownOperations = 1;
      await expect(f.acts.finalizeRefurbish(f.input)).rejects.toThrow(
        "budget settlement is not publishable",
      );
      expect(f.tx.siteBuildRun.updateMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    null,
    [],
    { publicationBaseVersionId: null },
    { publicationBaseVersionId: "base-v1" },
  ])("preserves the durable publication base from %j", async (scope) => {
    const f = publicationActivityFixture();
    f.run.scope = scope;
    expect(await f.acts.finalizeRefurbish(f.input)).toEqual({
      previewSlug: "synthetic",
    });
    expect(f.tx.site.updateMany).toHaveBeenCalledOnce();
    if (scope && !Array.isArray(scope))
      expect(
        f.tx.siteBuildRun.updateMany.mock.calls[0][0].data.scope,
      ).toBeUndefined();
  });
  it.each(["frozen", "stored", "site", "id"])(
    "requires the current copy %s snapshot before publication",
    async (gap) => {
      const f = publicationActivityFixture();
      const snapshot = { siteId: INPUT.siteId };
      vi.spyOn(
        PrismaPublishableClaimSnapshotRepository.prototype,
        "findById",
      ).mockResolvedValue(gap === "frozen" ? null : (snapshot as never));
      f.tx.sitePublishableClaimSnapshot.findUnique.mockResolvedValue(
        gap === "stored"
          ? null
          : {
              id: gap === "id" ? "other" : "snapshot-copy",
              siteId: gap === "site" ? "other" : INPUT.siteId,
            },
      );
      f.input.copy = {
        snapshotId: "snapshot-copy",
        set: { bundles: {} },
        taskAttemptIds: {},
        degradedLocales: [],
      } as never;
      await expect(f.acts.finalizeRefurbish(f.input)).rejects.toThrow(
        "COPY_CLAIM_SNAPSHOT_MISSING",
      );
      expect(f.tx.siteBuildRun.updateMany).not.toHaveBeenCalled();
    },
  );
  it("refuses mismatched persisted locale bundle digests at activation", async () => {
    const f = publicationActivityFixture();
    vi.spyOn(
      PrismaPublishableClaimSnapshotRepository.prototype,
      "findById",
    ).mockResolvedValue({ siteId: INPUT.siteId } as never);
    vi.spyOn(
      PublishableClaimSnapshotService.prototype,
      "assertCurrent",
    ).mockResolvedValue(undefined);
    f.input.copy = {
      snapshotId: "snapshot-copy",
      set: {
        bundles: { en: { digest: "expected" }, de: { digest: "expected-de" } },
      },
      taskAttemptIds: {},
      degradedLocales: [],
    } as never;
    await expect(f.acts.finalizeRefurbish(f.input)).rejects.toThrow(
      "COPY_BUNDLE_ACTIVATION_MISMATCH",
    );
    expect(f.tx.site.updateMany).not.toHaveBeenCalled();
  });
});

describe("activity bounded fallbacks and explicit input preservation", () => {
  it.each([0, 1.5])(
    "rejects invalid persistence retry budget %s",
    async (maxAttempts) => {
      const operation = vi.fn();
      await expect(
        runBrandProfilePersistenceWithRetry(operation, maxAttempts),
      ).rejects.toThrow("positive integer");
      expect(operation).not.toHaveBeenCalled();
    },
  );
  it("refuses a style-preset drift even within the selected family", () => {
    const requested = activityGoldenFixtures[0].designBrief;
    expect(() =>
      controlledAssemblyEffectiveBrief(
        requested,
        { ...requested, stylePresetId: "other" },
        requested.familyId,
        false,
      ),
    ).toThrow("IDENTITY_DRIFT");
  });
  it("preserves a stable cancellation error for narrative cancellation with a non-Error reason", async () => {
    const abort = new AbortController();
    abort.abort("cancelled");
    await expect(
      runNonAuthoritativeQualityNarrative(async () => {
        throw new Error("narrative failed");
      }, abort.signal),
    ).rejects.toThrow("QUALITY_NARRATIVE_CANCELLED");
  });
  it("refuses beginning a deleted Site before budget access", async () => {
    const assertAuthorizedBudget = vi.fn();
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({
        site: { findUnique: vi.fn().mockResolvedValue(null) },
      }),
      costLedger: { assertAuthorizedBudget } as never,
    });
    await expect(acts.beginRefurbishRun(INPUT)).rejects.toThrow("not found");
    expect(assertAuthorizedBudget).not.toHaveBeenCalled();
  });
  it("runs direct KB work without a Temporal context and forwards stage callbacks safely", async () => {
    const processQueued = vi.fn(async (_ctx, _site, options) => {
      options.heartbeat("parse");
      expect(options.signal).toBeUndefined();
      return { processed: 1, failed: 0 };
    });
    const processAsset = vi.fn(async (_ctx, _site, _asset, options) => {
      options.heartbeat("embed");
      expect(options.signal).toBeUndefined();
      return { outcome: "ready" };
    });
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({}),
      kb: { processQueued, processAsset } as never,
    });
    expect(await acts.ingestPendingKb(INPUT)).toEqual({
      processed: 1,
      failed: 0,
    });
    expect(await acts.processKbAsset({ ...INPUT, assetId: "a" })).toEqual({
      outcome: "ready",
    });
  });
  it("honors explicit design locales and a supported preset with a configured fake gateway", async () => {
    const produce = vi
      .spyOn(DesignBriefProducer.prototype, "produce")
      .mockResolvedValue({ designBrief: {} } as never);
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({
        site: {
          findFirst: vi
            .fn()
            .mockResolvedValue({
              id: INPUT.siteId,
              intake: {},
              locales: ["en"],
              stylePreset: null,
              brandProfiles: [],
              assets: [],
            }),
        },
      }),
      gateway: {} as never,
    });
    await acts.generateDesignBrief({
      ...INPUT,
      scope: {
        scope: "site",
        options: { locales: ["de"], stylePreset: "modern-industrial" },
      },
    });
    expect(produce.mock.calls[0][0]).toMatchObject({
      locales: ["de"],
      stylePreset: "modern-industrial",
    });
  });
  it("uses the committed preset when no run-specific preset is requested", async () => {
    const produce = vi
      .spyOn(DesignBriefProducer.prototype, "produce")
      .mockResolvedValue({ designBrief: {} } as never);
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma({
        site: {
          findFirst: vi
            .fn()
            .mockResolvedValue({
              id: INPUT.siteId,
              intake: {},
              locales: ["en"],
              stylePreset: "precision-light",
              brandProfiles: [],
              assets: [],
            }),
        },
      }),
    });
    await acts.generateDesignBrief(INPUT);
    expect(produce.mock.calls[0][0].stylePreset).toBe("precision-light");
  });
  it("rejects immutable candidate evidence when the artifact reader is absent", async () => {
    const f = await qualityActivityFixture();
    try {
      Object.assign(f.input.qualityCandidate.candidate, {
        artifact: { objectKey: "candidate" },
      });
      await expect(
        f.acts.evaluateQualityCandidate(f.input as never),
      ).rejects.toThrow("ARTIFACT_UNAVAILABLE");
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
  it("keeps optional intake fields absent without inserting undefined in KB markdown", () => {
    const intake = {
      ...INTAKE,
      company: { nameZh: "Synthetic Company" },
      websiteUrl: undefined,
    };
    const text = intakeToMarkdown(intake as never);
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("Existing website");
  });
  it("does not drop a copy task's exact completed replay identity", async () => {
    const f = copyActivityFixture();
    const contexts = new Map<string, Record<string, unknown>>();
    const first = await f.acts.generateCopyBundles(INPUT);
    const frozen = f.ledger.freezeTaskInput.mock.calls[0][1];
    contexts.set("en", {
      taskAttemptId: "attempt-copy",
      contractVersion: COPY_GENERATION_CONTRACT_VERSION,
      contextDigest: frozen.contextDigest,
      slots: neutralCopyOutput(frozen.slots, "en").slots,
    });
    f.ledger.claimTaskAttempt.mockResolvedValue({
      kind: "completed",
      result: contexts.get("en"),
    } as never);
    f.run.mockClear();
    const replay = await f.acts.generateCopyBundles(INPUT);
    expect(replay.set).toEqual(first.set);
    expect(f.run).not.toHaveBeenCalled();
  });
});

describe("generation capability absence after durable authorization", () => {
  it("fails BrandProfile when its configured model gateway is absent", async () => {
    const f = brandActivityFixture();
    const acts = createSiteBuilderActivities({ ...f.deps, gateway: undefined });
    await expect(acts.buildBrandProfile(INPUT)).rejects.toThrow(
      "model gateway unavailable",
    );
    expect(f.ledger.assertAuthorizedBudget).toHaveBeenCalledOnce();
    expect(f.ledger.claimTaskAttempt).not.toHaveBeenCalled();
  });
  it("fails copy after snapshot capture when its configured model gateway is absent", async () => {
    const f = copyActivityFixture();
    const acts = createSiteBuilderActivities({
      prisma: fakePrisma(f.tx),
      costLedger: f.ledger as never,
    });
    await expect(acts.generateCopyBundles(INPUT)).rejects.toThrow(
      "model gateway unavailable",
    );
    expect(f.ledger.assertAuthorizedBudget).toHaveBeenCalledOnce();
    expect(f.ledger.claimTaskAttempt).not.toHaveBeenCalled();
  });
});

describe("approved quality evidence materialization acknowledgement", () => {
  it("refuses a service success that never produced the required artifact references", async () => {
    const f = await qualityActivityFixture();
    try {
      f.input.qualityCandidate.candidate.root = path.join(f.root, ".staging", INPUT.buildRunId);
      Object.assign(f.tx.siteVersion, { findUnique: vi.fn().mockResolvedValue({ spec: f.golden.spec }) });
      f.qualityCandidateService.materializeApprovedRelease.mockResolvedValue(undefined);
      await expect(f.acts.materializeApprovedRelease(f.input as never)).rejects.toThrow("QUALITY_ARTIFACT_INVALID");
      expect(f.qualityCandidateService.materializeApprovedRelease).toHaveBeenCalledOnce();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
