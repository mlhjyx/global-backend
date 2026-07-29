import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  PaidCallDeniedError,
  PaidOperationUnknownError,
} from "../site-build-cost-ledger";
import {
  deterministicQualityNarrativeOutput,
  type QualityNarrativeSetV1,
} from "./quality-narrative";
import {
  QualityNarrativeService,
  type QualityNarrativeStorage,
} from "./quality-narrative.service";
import { qualityNarrativeFixture } from "./quality-narrative.test-fixture";

class MemoryStorage implements QualityNarrativeStorage {
  constructor(readonly objects = new Map<string, Buffer>()) {}

  async head(key: string) {
    const bytes = this.objects.get(key);
    return bytes
      ? { size: bytes.length, contentType: "application/json" }
      : null;
  }

  async getBufferBounded(key: string, maxBytes: number): Promise<Buffer> {
    const bytes = this.objects.get(key);
    if (!bytes || bytes.length > maxBytes) throw new Error("missing object");
    return Buffer.from(bytes);
  }

  async putBufferImmutable(
    key: string,
    data: Buffer,
    _contentType: string,
    digest: string,
  ): Promise<"created" | "exists"> {
    expect(createHash("sha256").update(data).digest("hex")).toBe(digest);
    if (this.objects.has(key)) return "exists";
    this.objects.set(key, Buffer.from(data));
    return "created";
  }

  async hashObject(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) throw new Error("missing object");
    return {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
    };
  }
}

function storedSet(storage: MemoryStorage): QualityNarrativeSetV1 {
  const entry = [...storage.objects.entries()].find(([key]) =>
    key.endsWith("/quality-narrative-set.json"),
  );
  if (!entry) throw new Error("narrative set missing");
  return JSON.parse(entry[1].toString("utf8")) as QualityNarrativeSetV1;
}

describe("QualityNarrativeService", () => {
  it("runs both real consumer seams and persists only a private closed evidence set", async () => {
    const fixture = qualityNarrativeFixture();
    const storage = new MemoryStorage(fixture.objects);
    const execute = vi.fn(async (input) => ({
      output: deterministicQualityNarrativeOutput(input),
      provenance: {
        taskAttemptId: `attempt-${input.taskId}`,
        model: "candidate",
        provider: "fake-wire",
        reportedModel: "candidate",
        modelResolutionSource: "provider_reported",
        fallbackIndex: 0,
        usage: { inputTokens: 10, outputTokens: 5, calls: 1 },
        routePolicy: {
          policyVersion: "test",
          profile: "text.summary",
          routeState: "currentRoute",
          lifecycle: "active",
          source: "registry",
          dataPolicy: {
            allowedDataClasses: ["public"],
            personalData: "forbidden",
            retention: "none",
          },
          maxCostCents: 20,
          route: { primary: "candidate", fallbacks: [] },
        },
      },
    }));
    const ref = await new QualityNarrativeService(storage).build({
      siteId: "site-1",
      buildRunId: "run-1",
      evaluation: fixture.evaluation,
      artifactSet: fixture.artifactSet,
      execute,
    });
    expect(ref.objectKey).toContain(
      "sites/site-1/quality-narratives/run-1/round-0/",
    );
    expect(execute).toHaveBeenCalledTimes(2);
    const [qaInput, seoInput] = execute.mock.calls.map(([input]) => input);
    expect(qaInput.findings.map((finding) => finding.ruleCode)).toEqual([
      "OUTBOUND_REQUEST_FORBIDDEN",
    ]);
    expect(qaInput.seoReports).toEqual([]);
    expect(seoInput.findings.map((finding) => finding.ruleCode)).toEqual([
      "H1_COUNT_INVALID",
    ]);
    expect(seoInput.seoReports[0]?.checks).toEqual({
      h1Count: 2,
      canonicalPresent: false,
      hreflangCount: 0,
      previewNoindex: false,
      robotsTxtOk: false,
      sitemapOk: false,
      jsonLdValid: false,
      jsonLdUnsupportedFacts: true,
    });
    const set = storedSet(storage);
    expect(set.qa.mode).toBe("model");
    expect(set.seo.mode).toBe("model");
    expect(JSON.stringify(set)).not.toContain("outside.invalid");
  });

  it("stops later paid work on unknown settlement and replays the immutable checkpoint", async () => {
    const fixture = qualityNarrativeFixture();
    const storage = new MemoryStorage(fixture.objects);
    const execute = vi.fn(async () => {
      throw new PaidOperationUnknownError("qa-call");
    });
    const service = new QualityNarrativeService(storage);
    const input = {
      siteId: "site-1",
      buildRunId: "run-unknown",
      evaluation: fixture.evaluation,
      artifactSet: fixture.artifactSet,
      execute,
    };
    const first = await service.build(input);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(storedSet(storage).qa.fallbackReason).toBe("settlement_unknown");
    expect(storedSet(storage).seo.fallbackReason).toBe(
      "prior_settlement_unknown",
    );
    execute.mockClear();
    expect(await service.build(input)).toEqual(first);
    expect(execute).not.toHaveBeenCalled();
  });

  it("records an explicit deterministic fallback when paid dispatch is denied", async () => {
    const fixture = qualityNarrativeFixture();
    const storage = new MemoryStorage(fixture.objects);
    const execute = vi.fn(async () => {
      throw new PaidCallDeniedError("DENIED_KILL_SWITCH");
    });
    await new QualityNarrativeService(storage).build({
      siteId: "site-1",
      buildRunId: "run-denied",
      evaluation: fixture.evaluation,
      artifactSet: fixture.artifactSet,
      execute,
    });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(storedSet(storage).qa.fallbackReason).toBe("paid_gate_denied");
    expect(storedSet(storage).seo.fallbackReason).toBe("paid_gate_denied");
  });

  it("marks invalid model output without changing any deterministic finding", async () => {
    const fixture = qualityNarrativeFixture();
    const storage = new MemoryStorage(fixture.objects);
    const execute = vi.fn(async () => ({
      output: { groups: [] },
      provenance: {} as never,
    }));
    await new QualityNarrativeService(storage).build({
      siteId: "site-1",
      buildRunId: "run-invalid",
      evaluation: fixture.evaluation,
      artifactSet: fixture.artifactSet,
      execute,
    });
    const set = storedSet(storage);
    expect(set.qa.fallbackReason).toBe("output_invalid");
    expect(set.seo.fallbackReason).toBe("output_invalid");
    expect(set.findings).toHaveLength(2);
    expect(
      set.findings.map(({ severity, ruleCode }) => ({ severity, ruleCode })),
    ).toEqual([
      {
        severity: "blocker",
        ruleCode: "H1_COUNT_INVALID",
      },
      {
        severity: "blocker",
        ruleCode: "OUTBOUND_REQUEST_FORBIDDEN",
      },
    ]);
  });

  it("does not invoke a consumer when its frozen finding slice is empty", async () => {
    const fixture = qualityNarrativeFixture();
    fixture.evaluation.deterministic = {
      status: "passed",
      hardFailures: [],
      findings: [],
    };
    const storage = new MemoryStorage(fixture.objects);
    const execute = vi.fn();
    await new QualityNarrativeService(storage).build({
      siteId: "site-1",
      buildRunId: "run-clean",
      evaluation: fixture.evaluation,
      artifactSet: fixture.artifactSet,
      execute,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(storedSet(storage).qa.fallbackReason).toBe("empty_findings");
    expect(storedSet(storage).seo.fallbackReason).toBe("empty_findings");
  });

  it("treats cancellation as terminal and writes no fallback checkpoint", async () => {
    const fixture = qualityNarrativeFixture();
    const storage = new MemoryStorage(fixture.objects);
    const controller = new AbortController();
    const execute = vi.fn(async () => {
      controller.abort(new Error("activity cancelled"));
      throw new Error("wire aborted");
    });
    await expect(
      new QualityNarrativeService(storage).build({
        siteId: "site-1",
        buildRunId: "run-cancelled",
        evaluation: fixture.evaluation,
        artifactSet: fixture.artifactSet,
        execute,
        signal: controller.signal,
      }),
    ).rejects.toThrow("activity cancelled");
    expect(
      [...storage.objects.keys()].some((key) =>
        key.endsWith("/quality-narrative-set.json"),
      ),
    ).toBe(false);
  });
});
