import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const files = vi.hoisted(() => new Map<string, string>());
const flags = vi.hoisted(() => ({ uid: 0, mode: 0o444, nlink: 1 }));
vi.mock("node:fs/promises", async (actual) => ({
  ...(await actual<typeof import("node:fs/promises")>()),
  lstat: vi.fn(async (path: string) => {
    if (!files.has(path))
      throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
    return { isFile: () => true };
  }),
  open: vi.fn(async (path: string) => {
    const contents = files.get(path);
    if (contents === undefined)
      throw Object.assign(new Error("missing fixture"), { code: "ENOENT" });
    return {
      stat: async () => ({
        ...flags,
        isFile: () => true,
        size: Buffer.byteLength(contents),
        mtimeMs: 1,
      }),
      readFile: async () => Buffer.from(contents),
      close: async () => undefined,
    };
  }),
}));
const WS = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
];
const NOW = Date.parse("2026-11-15T14:00:00.000Z");
const EXPIRY = NOW + 60_000;
const build = {
  build_sha: "a".repeat(40),
  artifact_digest: `sha256:${"d".repeat(64)}`,
  source_tree_digest: `sha256:${"e".repeat(64)}`,
};
const instance = {
  apiOrigin: "http://127.0.0.1:13010",
  database: {
    host: "127.0.0.1",
    port: 15432,
    name: "global_candidate_pump_ab",
  },
  temporal: {
    address: "127.0.0.1:27233",
    tlsServerName: "candidate.temporal.local",
    configurationRevision: "9".repeat(64),
  },
  controlPlane: {
    issuer: "https://127.0.0.1:28446",
    jwks: "https://127.0.0.1:28446/jwks",
    machineSubjects: ["candidate-api", "candidate-worker"],
  },
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const marker = {
  schemaVersion: "development-candidate-marker/v1",
  candidateCommit: build.build_sha,
  trustedWorkflowCommit: "b".repeat(40),
  authorizationSha256: "c".repeat(64),
  instanceManifestSha256: createHash("sha256")
    .update(canonical(instance))
    .digest("hex"),
  instanceId: "pump-ab",
  workspaceIds: WS,
  validUntil: new Date(EXPIRY).toISOString(),
};
const receipt = {
  ...marker,
  schemaVersion: "development-candidate-admission/v1",
  imageReference: `ghcr.io/mlhjyx/global-backend-development-candidate@sha256:${"a".repeat(64)}`,
  artifactDigest: build.artifact_digest,
  sourceTreeDigest: build.source_tree_digest,
  verificationKind: "github-attestation-and-owner-ssh",
  instance,
};
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  files.clear();
  Object.assign(flags, { uid: 0, mode: 0o444, nlink: 1 });
  files.set("/artifact/runtime-candidate.json", JSON.stringify(marker));
  files.set(
    "/run/secrets/development-candidate/admission.json",
    JSON.stringify(receipt),
  );
  for (const [key, value] of Object.entries({
    APP_ENVIRONMENT: "development",
    NODE_ENV: "production",
    RUNTIME_IMAGE_REFERENCE: receipt.imageReference,
    RUNTIME_CANDIDATE_INSTANCE_ID: "pump-ab",
    RUNTIME_CANDIDATE_ADMISSION_FILE:
      "/run/secrets/development-candidate/admission.json",
    APP_DATABASE_URL:
      "postgresql://app_user@127.0.0.1:15432/global_candidate_pump_ab",
    DATABASE_URL: "",
    RUNTIME_API_LEASE_DATABASE_URL:
      "postgresql://runtime_api@127.0.0.1:15432/global_candidate_pump_ab",
    TEMPORAL_ADDRESS: instance.temporal.address,
    TEMPORAL_TLS_SERVER_NAME: instance.temporal.tlsServerName,
    MACHINE_BOOTSTRAP_CONFIGURATION_REVISION:
      instance.temporal.configurationRevision,
    TEMPORAL_MACHINE_SUBJECT: "candidate-api",
    AUTH_ISSUER: instance.controlPlane.issuer,
    AUTH_JWKS_URI: instance.controlPlane.jwks,
    PORT: "13010",
    SWEEP_SCHEDULER_ENABLED: "off",
    RUNTIME_DEV_FAST_LANE_WORKSPACE_ID: "",
    RUNTIME_DEV_FAST_LANE_TEMPORAL_ADDRESS: "",
  }))
    vi.stubEnv(key, value);
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("candidate lifecycle with simulated root-owned verification mounts (no live services)", () => {
  function installProductGrantAuthorization() {
    const productMarker = {
      ...marker,
      schemaVersion: "development-candidate-marker/v2",
      budgetPolicy: "product_grants",
    };
    const productReceipt = {
      ...receipt,
      schemaVersion: "development-candidate-admission/v2",
      budgetPolicy: "product_grants",
    };
    files.set(
      "/artifact/runtime-candidate.json",
      JSON.stringify(productMarker),
    );
    files.set(
      "/run/secrets/development-candidate/admission.json",
      JSON.stringify(productReceipt),
    );
  }

  it("v2 reaches the ordinary model and tool budget paths without an experimental allocation", async () => {
    installProductGrantAuthorization();
    const candidate = await import("./development-candidate");
    await candidate.prepareRuntimeCandidate("/artifact", process.env);
    expect(() => candidate.assertCandidatePhysicalExecutionAllowed()).toThrow();
    await candidate.admitRuntimeCandidate("/artifact", build, process.env);
    expect(candidate.runtimeCandidateContext()?.budgetPolicy).toBe(
      "product_grants",
    );
    expect(() =>
      candidate.assertCandidatePhysicalExecutionAllowed(),
    ).not.toThrow();
    const budget = await import("./development-candidate-budget");
    await expect(
      budget.assertCandidateAccountAllocated(WS[0]!, "normal-account"),
    ).resolves.toBeUndefined();
    await expect(
      budget.assertCandidateAccountAllocated(
        "other-workspace",
        "normal-account",
      ),
    ).rejects.toThrow();
    const { RouterModelGateway } =
      await import("../model-gateway/router-model-gateway");
    const generateText = vi.fn();
    const route = vi.fn(() => [
      {
        name: "fixture",
        model: "fixture",
        protocol: "openai-chat",
        modelId: "fixture",
        protocolId: "openai-chat",
        generateText,
      },
    ]);
    const modelReserve = vi.fn(async () => {
      throw new Error("normal-model-budget-refused");
    });
    const gateway = new RouterModelGateway({ route } as never, undefined, {
      reserve: modelReserve,
    } as never);
    await expect(
      gateway.generateText(
        { task: "icp.design", prompt: "fixture", maxCostCents: 5 },
        { workspaceId: WS[0]! },
      ),
    ).rejects.toThrow("normal-model-budget-refused");
    expect(route).toHaveBeenCalledOnce();
    expect(modelReserve).toHaveBeenCalledOnce();
    expect(generateText).not.toHaveBeenCalled();
    const { ToolBroker } = await import("../tools/tool-broker");
    const { ToolRegistry } = await import("../tools/tool-registry");
    const registry = new ToolRegistry();
    const execute = vi.fn();
    const reserve = vi.fn(async () => {
      throw new Error("normal-product-budget-refused");
    });
    registry.register({
      id: "fixture.external",
      version: "1",
      category: "search",
      cost: { external: true, estimatedCents: 0, unit: "call" },
      rateLimit: { rps: 1, concurrency: 1 },
      compliance: { sourcePolicy: "none" },
      capabilities: { produces: [], accepts: [] },
      idempotencyKey: () => "fixture",
      durableResultStrategy: {
        kind: "typed_projection",
        schema: "searxng-search/v1",
      },
      execute,
    } as never);
    const broker = new ToolBroker({
      registry,
      budgetStore: { reserve },
      limiter: { configure: vi.fn() },
    } as never);
    await expect(
      broker.invoke("fixture.external", {}, { workspaceId: WS[0]! }),
    ).rejects.toThrow("normal-product-budget-refused");
    expect(reserve).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("v2 still consumes its normal verified Grant through the SQL authority", async () => {
    installProductGrantAuthorization();
    const candidate = await import("./development-candidate");
    await candidate.prepareRuntimeCandidate("/artifact", process.env);
    await candidate.admitRuntimeCandidate("/artifact", build, process.env);
    const { ExecutionBudgetAuthorityService } =
      await import("../execution-budget/execution-budget-authority.service");
    const consumeWorkspaceAndOpen = vi.fn(async () => {
      throw new Error("normal-sql-budget-denied");
    });
    const service = new ExecutionBudgetAuthorityService(
      {} as never,
      { consumeWorkspaceAndOpen } as never,
    );
    const grant = {
      authorityKind: "WORKSPACE_GRANT",
      workspaceId: WS[0],
      purpose: "icp.design",
      subjectType: "company",
      subjectId: "20000000-0000-4000-8000-000000000001",
      requestSha256: "f".repeat(64),
      tokenSha256: "e".repeat(64),
      capMicrousd: 1_000_000n,
    };
    await expect(
      service.consumeVerifiedWorkspaceGrant(grant as never),
    ).rejects.toThrow("normal-sql-budget-denied");
    expect(consumeWorkspaceAndOpen).toHaveBeenCalledOnce();
  });

  it.each(["expired", "denied"])(
    "v2 %s contexts cannot dispatch after admission",
    async (state) => {
      installProductGrantAuthorization();
      const candidate = await import("./development-candidate");
      await candidate.prepareRuntimeCandidate("/artifact", process.env);
      await candidate.admitRuntimeCandidate("/artifact", build, process.env);
      if (state === "expired") vi.setSystemTime(EXPIRY + 1);
      else candidate.denyRuntimeCandidate();
      expect(() => candidate.assertCandidatePhysicalExecutionAllowed()).toThrow(
        "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
      );
      expect(() =>
        candidate.assertCandidateToolExecutionAllowed({
          cost: { external: true, estimatedCents: 0 },
          durableResultStrategy: { kind: "typed_projection" },
        }),
      ).toThrow();
    },
  );

  it.each([
    { markerVersion: "v1", receiptVersion: "v1", mode: "product_grants" },
    { markerVersion: "v2", receiptVersion: "v1", mode: "product_grants" },
    { markerVersion: "v1", receiptVersion: "v2", mode: "product_grants" },
    { markerVersion: "v2", receiptVersion: "v2", mode: "unlimited" },
    { markerVersion: "v2", receiptVersion: "v2", mode: undefined },
  ])(
    "rejects mismatched version and cost mode %j",
    async ({ markerVersion, receiptVersion, mode }) => {
      files.set(
        "/artifact/runtime-candidate.json",
        JSON.stringify({
          ...marker,
          schemaVersion: `development-candidate-marker/${markerVersion}`,
          budgetPolicy: mode,
        }),
      );
      files.set(
        "/run/secrets/development-candidate/admission.json",
        JSON.stringify({
          ...receipt,
          schemaVersion: `development-candidate-admission/${receiptVersion}`,
          budgetPolicy: mode,
        }),
      );
      const candidate = await import("./development-candidate");
      await candidate.prepareRuntimeCandidate("/artifact", process.env);
      await expect(
        candidate.admitRuntimeCandidate("/artifact", build, process.env),
      ).rejects.toThrow();
      expect(candidate.candidateWorkspaceAllowed(WS[0]!)).toBe(false);
    },
  );

  it("holds model and external-tool dispatch even with an admitted workspace and a zero estimate", async () => {
    const candidate = await import("./development-candidate");
    await candidate.prepareRuntimeCandidate("/artifact", process.env);
    expect(() => candidate.assertCandidatePhysicalExecutionAllowed()).toThrow(
      "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
    );
    await candidate.admitRuntimeCandidate("/artifact", build, process.env);
    const { RouterModelGateway } =
      await import("../model-gateway/router-model-gateway");
    const generateText = vi.fn(async () => ({
      data: "unexpected",
      model: "fixture",
      provider: "fixture",
    }));
    const route = vi.fn(() => [{ generateText }]);
    const reserve = vi.fn();
    const gateway = new RouterModelGateway({ route } as never, undefined, {
      reserve,
    } as never);
    await expect(
      gateway.generateText(
        { task: "icp.design", prompt: "fixture" },
        { workspaceId: WS[0]! },
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
    });
    expect(route).not.toHaveBeenCalled();
    expect(generateText).not.toHaveBeenCalled();
    const { ToolBroker } = await import("../tools/tool-broker");
    const { ToolRegistry } = await import("../tools/tool-registry");
    const registry = new ToolRegistry();
    const execute = vi.fn();
    registry.register({
      id: "fixture.external",
      version: "1",
      category: "search",
      cost: { external: true, estimatedCents: 0, unit: "call" },
      rateLimit: { rps: 1, concurrency: 1 },
      compliance: { sourcePolicy: "none" },
      capabilities: { produces: [], accepts: [] },
      durableResultStrategy: {
        kind: "typed_projection",
        schema: "searxng-search/v1",
      },
      execute,
    } as never);
    const broker = new ToolBroker({
      registry,
      budgetStore: { reserve },
      limiter: { configure: vi.fn() },
    } as never);
    await expect(
      broker.invoke("fixture.external", {}, { workspaceId: WS[0]! }),
    ).rejects.toMatchObject({
      code: "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    registry.register({
      ...registry.get("fixture.external"),
      id: "fixture.zero-priced",
      cost: { external: false, estimatedCents: 0, unit: "call" },
    } as never);
    await expect(
      broker.invoke("fixture.zero-priced", {}, { workspaceId: WS[0]! }),
    ).rejects.toMatchObject({
      code: "EXECUTION_BUDGET_VERIFICATION_UNAVAILABLE",
    });
    expect(execute).not.toHaveBeenCalled();
  });
  it("a build/admission early return still denies otherwise signed tenant reads", async () => {
    vi.stubEnv("RUNTIME_EXECUTION_PROFILE", "source-watch");
    const { loadRuntimeReleaseIdentity } =
      await import("./runtime-release-identity");
    await expect(
      loadRuntimeReleaseIdentity({
        mode: "development",
        artifactRoot: "/artifact",
        env: process.env,
      }),
    ).resolves.toMatchObject({
      attested: false,
      code: "SOURCE_WATCH_NOT_MANAGED",
    });
    const { AuthGuard } = await import("../auth/auth.guard");
    const guard = new AuthGuard(
      {
        verify: async () => ({
          userId: "user",
          workspaceId: WS[0]!,
          roles: [],
        }),
      },
      { resolve: () => [] },
    );
    await expect(
      guard.canActivate({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: "Bearer fixture-token" },
          }),
        }),
      } as never),
    ).rejects.toThrow();
  });

  it("an explicit production mode cannot be reclassified by a development environment value", async () => {
    const candidate = await import("./development-candidate");
    await candidate.prepareRuntimeCandidate("/artifact", process.env);
    await expect(
      candidate.admitRuntimeCandidate(
        "/artifact",
        build,
        process.env,
        "production",
      ),
    ).rejects.toThrow();
    expect(candidate.candidateWorkspaceAllowed(WS[0]!)).toBe(false);
  });
  it("starts pending-denied before any build/image failure, then opens only the verified workspaces", async () => {
    const candidate = await import("./development-candidate");
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    await candidate.prepareRuntimeCandidate("/artifact", process.env);
    expect(candidate.candidateWorkspaceAllowed(WS[0]!)).toBe(false);
    await candidate.admitRuntimeCandidate("/artifact", build, process.env);
    expect(candidate.candidateWorkspaceAllowed(WS[0]!)).toBe(true);
    expect(candidate.candidateWorkspaceAllowed("outside")).toBe(false);
    await candidate.admitRuntimeCandidate("/artifact", build, process.env);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(kill).toHaveBeenCalledWith(process.pid, "SIGTERM");
    expect(candidate.candidateWorkspaceAllowed(WS[0]!)).toBe(false);
    expect(() => candidate.assertCandidateTenantAccess(WS[0]!)).toThrow();
  });

  it.each([{ uid: 10001 }, { mode: 0o666 }, { nlink: 2 }])(
    "a self-writable or substituted cache %j never activates a workspace",
    async (patch) => {
      Object.assign(flags, patch);
      const candidate = await import("./development-candidate");
      await candidate.prepareRuntimeCandidate("/artifact", process.env);
      await expect(
        candidate.admitRuntimeCandidate("/artifact", build, process.env),
      ).rejects.toThrow();
      expect(candidate.candidateWorkspaceAllowed(WS[0]!)).toBe(false);
    },
  );

  it("normal consumption rejects an extra valid SaaS Grant before SQL, even for an admitted workspace", async () => {
    const candidate = await import("./development-candidate");
    await candidate.prepareRuntimeCandidate("/artifact", process.env);
    await candidate.admitRuntimeCandidate("/artifact", build, process.env);
    const requestSha256 = "f".repeat(64),
      tokenSha256 = "e".repeat(64),
      subjectId = "20000000-0000-4000-8000-000000000001";
    const accountKey = `icp.design:company:${subjectId}:${requestSha256}`;
    files.set(
      "/run/secrets/development-candidate/budget-allocations.json",
      JSON.stringify({
        schemaVersion: "development-candidate-budget-allocations/v1",
        authorizationSha256: marker.authorizationSha256,
        campaignId: marker.instanceId,
        expiresAt: marker.validUntil,
        capMicrousd: 5_000_000,
        arms: {
          A: { workspaceId: WS[0], capMicrousd: 2_500_000 },
          B: { workspaceId: WS[1], capMicrousd: 2_500_000 },
        },
        allocations: [
          {
            id: "a".repeat(64),
            requestKey: requestSha256,
            arm: "A",
            workspaceId: WS[0],
            purpose: "icp.design",
            quoteSha256: "b".repeat(64),
            capMicrousd: 1_000_000,
            state: "BOUND",
            accountKey,
            grantSha256: tokenSha256,
          },
        ],
      }),
    );
    const { ExecutionBudgetAuthorityService } =
      await import("../execution-budget/execution-budget-authority.service");
    const consumeWorkspaceAndOpen = vi.fn(async () => ({
      authorityId: "30000000-0000-4000-8000-000000000001",
      replay: false,
      accountKey,
    }));
    const service = new ExecutionBudgetAuthorityService(
      {} as never,
      { consumeWorkspaceAndOpen } as never,
    );
    const grant = {
      authorityKind: "WORKSPACE_GRANT",
      workspaceId: WS[0],
      purpose: "icp.design",
      subjectType: "company",
      subjectId,
      requestSha256,
      tokenSha256,
      capMicrousd: 1_000_000n,
    };
    await expect(
      service.consumeVerifiedWorkspaceGrant(grant as never),
    ).resolves.toMatchObject({ accountKey });
    await expect(
      service.consumeVerifiedWorkspaceGrant({
        ...grant,
        tokenSha256: "0".repeat(64),
      } as never),
    ).rejects.toThrow();
    expect(consumeWorkspaceAndOpen).toHaveBeenCalledOnce();
    const budget = await import("./development-candidate-budget");
    await expect(
      budget.assertCandidateAccountAllocated(WS[0]!, accountKey),
    ).resolves.toBeUndefined();
    await expect(
      budget.assertCandidateAccountAllocated(WS[0]!, "not-allocated"),
    ).rejects.toThrow();
    files.delete("/run/secrets/development-candidate/budget-allocations.json");
    await expect(
      budget.assertCandidateGrantAllocated(grant as never),
    ).rejects.toThrow();
  });
});
