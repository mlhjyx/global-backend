import { BadGatewayException, HttpException, HttpStatus } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import type { RequestContext } from "../auth/request-context";
import type { DemoV0LaunchInput, DemoV0Launcher } from "./demo-launcher";
import {
  IntakeService,
  type IntakeInput,
  type IntakeResult,
} from "./intake.service";

const CTX: RequestContext = {
  userId: "u1",
  workspaceId: "11111111-1111-4111-8111-111111111111",
  roles: [],
};
const OTHER_CTX: RequestContext = {
  userId: "u2",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  roles: [],
};

const BASE_INTAKE: IntakeInput = {
  company: { nameZh: "杭州爱克姆泵业有限公司", nameEn: "Acme Pump Co., Ltd." },
  industry: "isic-2813",
  products: ["centrifugal pump", "screw pump"],
  targetMarkets: ["DE", "US"],
  hasWebsite: false,
  websiteUrl: null,
  businessEmail: "sales@acmepump.com",
};

interface FakeDb {
  sites: Record<string, unknown>[];
  runs: Record<string, unknown>[];
  keys: Record<string, unknown>[];
}

interface TargetCreate {
  (
    ctx: RequestContext,
    input: IntakeInput,
    idempotencyKey?: string,
  ): Promise<IntakeResult>;
}

function callCreate(
  service: IntakeService,
  ctx: RequestContext,
  input: IntakeInput,
  idempotencyKey?: string,
): Promise<IntakeResult> {
  // 这个适配让目标契约在生产签名尚未实现时仍能运行并形成行为 RED，而不是停在 TS2554。
  return (service.create as TargetCreate)(ctx, input, idempotencyKey);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeService(
  opts: {
    existingSite?: boolean;
    existingStatus?: string;
    launcher?: DemoV0Launcher;
    ackPersistError?: Error;
  } = {},
) {
  const db: FakeDb = { sites: [], runs: [], keys: [] };
  let siteSeq = 0;
  let runSeq = 0;

  if (opts.existingSite) {
    db.sites.push({
      id: "site-existing",
      workspaceId: CTX.workspaceId,
      slug: "existing-slug",
      status: opts.existingStatus ?? "ready",
    });
  }

  const tx = {
    $executeRaw: async () => 0,
    site: {
      findFirst: async ({ where }: { where: { workspaceId?: string } }) =>
        db.sites.find((site) => site.workspaceId === where.workspaceId) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `site-${++siteSeq}`, ...data };
        db.sites.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = db.sites.find((site) => site.id === where.id);
        if (!row) throw new Error(`missing site ${where.id}`);
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: { id: string } }) => {
        const index = db.sites.findIndex((site) => site.id === where.id);
        if (index >= 0) db.sites.splice(index, 1);
        // 真库 Site → SiteBuildRun 是 ON DELETE CASCADE；fake 也必须忠实模拟。
        db.runs.splice(
          0,
          db.runs.length,
          ...db.runs.filter((run) => run.siteId !== where.id),
        );
      },
    },
    siteBuildRun: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        db.runs.find((run) => run.id === where.id) ?? null,
      findFirst: async ({ where }: { where: { siteId: string; status: { in: string[] } } }) =>
        db.runs.find(
          (run) => run.siteId === where.siteId && where.status.in.includes(String(run.status)),
        ) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `run-${++runSeq}`, temporalRunId: null, ...data };
        db.runs.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = db.runs.find((run) => run.id === where.id);
        if (!row) throw new Error(`missing run ${where.id}`);
        Object.assign(row, data);
        return row;
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        if (opts.ackPersistError) throw opts.ackPersistError;
        const row = db.runs.find((run) => run.id === where.id);
        if (!row) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    idempotencyKey: {
      findUnique: async ({
        where,
      }: {
        where: {
          workspaceId_endpoint_key: {
            workspaceId: string;
            endpoint: string;
            key: string;
          };
        };
      }) => {
        const wanted = where.workspaceId_endpoint_key;
        return (
          db.keys.find(
            (row) =>
              row.workspaceId === wanted.workspaceId &&
              row.endpoint === wanted.endpoint &&
              row.key === wanted.key,
          ) ?? null
        );
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const duplicate = db.keys.some(
          (row) =>
            row.workspaceId === data.workspaceId &&
            row.endpoint === data.endpoint &&
            row.key === data.key,
        );
        if (duplicate) throw new Error("fake unique violation");
        const row = { id: `key-${db.keys.length + 1}`, ...clone(data) };
        db.keys.push(row);
        return row;
      },
    },
  };

  const prisma = {
    withWorkspace: async <T>(
      _workspaceId: string,
      fn: (client: typeof tx) => Promise<T>,
    ): Promise<T> => fn(tx),
  };
  const launches: DemoV0LaunchInput[] = [];
  const launcher =
    opts.launcher ??
    ({
      launchDemoV0: async (input: DemoV0LaunchInput) => {
        launches.push(input);
        return { firstExecutionRunId: `temporal-${input.buildRunId}` };
      },
      recoverDemoV0: async (input: DemoV0LaunchInput) => ({
        firstExecutionRunId: `temporal-${input.buildRunId}`,
      }),
    } as unknown as DemoV0Launcher);

  return {
    service: new IntakeService(prisma as never, launcher),
    db,
    launches,
  };
}

async function expectHttpError(
  promise: Promise<unknown>,
  status: number,
  code: string,
): Promise<HttpException> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(HttpException);
  expect((error as HttpException).getStatus()).toBe(status);
  expect((error as HttpException).getResponse()).toMatchObject({
    error: { code },
  });
  return error as HttpException;
}

describe("IntakeService R0 contract（POST /site-builder/intake）", () => {
  it("无 key：原子建 Site + demo run，返回 buildId/generating_demo，ACK 后落 temporalRunId", async () => {
    const { service, db, launches } = makeService();
    const result = await callCreate(service, CTX, BASE_INTAKE);

    expect(result).toEqual({
      siteId: "site-1",
      buildId: "run-1",
      status: "generating_demo",
    });
    expect(result).not.toHaveProperty("mode");
    expect(db.sites).toHaveLength(1);
    expect(db.sites[0]).toMatchObject({
      workspaceId: CTX.workspaceId,
      mode: "builder",
      status: "building",
      name: "Acme Pump Co., Ltd.",
      locales: ["en"],
      intake: BASE_INTAKE,
    });
    expect(db.sites[0]?.slug).toMatch(/^acme-pump-co-ltd-[a-z0-9]{6}$/);
    expect(db.runs).toEqual([
      expect.objectContaining({
        id: "run-1",
        workspaceId: CTX.workspaceId,
        siteId: "site-1",
        kind: "demo_v0",
        status: "queued",
        temporalRunId: "temporal-run-1",
      }),
    ]);
    expect(launches).toEqual([
      { workspaceId: CTX.workspaceId, siteId: "site-1", buildRunId: "run-1" },
    ]);
  });

  it("hasWebsite=true 仍走同一 demo 契约；websiteUrl 仅作为 intake 背景保留", async () => {
    const { service, db } = makeService();
    const input = {
      ...BASE_INTAKE,
      hasWebsite: true,
      websiteUrl: "https://www.acmepump.com",
    };
    const result = await callCreate(service, CTX, input);

    expect(result).toEqual({
      siteId: "site-1",
      buildId: "run-1",
      status: "generating_demo",
    });
    expect(db.runs).toHaveLength(1);
    expect((db.sites[0]?.intake as Record<string, unknown>).websiteUrl).toBe(
      "https://www.acmepump.com",
    );
  });

  it("hasWebsite=true 但缺 websiteUrl → 400 VALIDATION_ERROR（服务层不信 DTO）", async () => {
    const { service } = makeService();
    await expectHttpError(
      callCreate(service, CTX, {
        ...BASE_INTAKE,
        hasWebsite: true,
        websiteUrl: null,
      }),
      HttpStatus.BAD_REQUEST,
      "VALIDATION_ERROR",
    );
  });

  it.each(["", "   ", "contains space", "slash/not-allowed", "x".repeat(129)])(
    "非法 Idempotency-Key %j → 400 INVALID_IDEMPOTENCY_KEY，且零写入",
    async (key) => {
      const { service, db } = makeService();
      await expectHttpError(
        callCreate(service, CTX, BASE_INTAKE, key),
        HttpStatus.BAD_REQUEST,
        "INVALID_IDEMPOTENCY_KEY",
      );
      expect(db.sites).toHaveLength(0);
      expect(db.runs).toHaveLength(0);
      expect(db.keys).toHaveLength(0);
    },
  );

  it("同 workspace + 同 key + 同语义请求：重放首个结果，不重复建站/run/Temporal", async () => {
    const { service, db, launches } = makeService();
    const first = await callCreate(
      service,
      CTX,
      BASE_INTAKE,
      "intake-request-1",
    );
    // 属性插入顺序不同但语义相同，request hash 必须稳定。
    const reordered: IntakeInput = {
      businessEmail: BASE_INTAKE.businessEmail,
      websiteUrl: null,
      hasWebsite: false,
      targetMarkets: ["DE", "US"],
      products: ["centrifugal pump", "screw pump"],
      industry: "isic-2813",
      company: {
        nameEn: "Acme Pump Co., Ltd.",
        nameZh: "杭州爱克姆泵业有限公司",
      },
    };
    const replay = await callCreate(
      service,
      CTX,
      reordered,
      "intake-request-1",
    );

    expect(replay).toEqual(first);
    expect(db.sites).toHaveLength(1);
    expect(db.runs).toHaveLength(1);
    expect(db.keys).toHaveLength(1);
    expect(db.keys[0]).toMatchObject({
      workspaceId: CTX.workspaceId,
      endpoint: "POST /api/v1/site-builder/intake",
      key: "intake-request-1",
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      response: first,
    });
    expect(launches).toHaveLength(1);
  });

  it("同 key 改请求体 → 409 IDEMPOTENCY_KEY_REUSED，零新增、零重启", async () => {
    const { service, db, launches } = makeService();
    await callCreate(service, CTX, BASE_INTAKE, "intake-request-1");

    await expectHttpError(
      callCreate(
        service,
        CTX,
        { ...BASE_INTAKE, products: ["a materially different product"] },
        "intake-request-1",
      ),
      HttpStatus.CONFLICT,
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(db.sites).toHaveLength(1);
    expect(db.runs).toHaveLength(1);
    expect(db.keys).toHaveLength(1);
    expect(launches).toHaveLength(1);
  });

  it("intake endpoint 的历史 NULL requestHash 无法证明请求相同 → fail-closed 409", async () => {
    const { service, db, launches } = makeService();
    db.sites.push({
      id: "legacy-site",
      workspaceId: CTX.workspaceId,
      status: "building",
    });
    db.runs.push({
      id: "legacy-run",
      workspaceId: CTX.workspaceId,
      siteId: "legacy-site",
      temporalRunId: "legacy-temporal-run",
    });
    db.keys.push({
      id: "legacy-key-row",
      workspaceId: CTX.workspaceId,
      endpoint: "POST /api/v1/site-builder/intake",
      key: "legacy-null-hash",
      requestHash: null,
      response: {
        siteId: "legacy-site",
        buildId: "legacy-run",
        status: "generating_demo",
      },
    });

    await expectHttpError(
      callCreate(service, CTX, BASE_INTAKE, "legacy-null-hash"),
      HttpStatus.CONFLICT,
      "IDEMPOTENCY_KEY_REUSED",
    );
    expect(launches).toHaveLength(0);
  });

  it("既有非 setup_failed 站 → 409 SITE_LIMIT_REACHED，错误码稳定", async () => {
    const { service, db } = makeService({
      existingSite: true,
      existingStatus: "ready",
    });
    await expectHttpError(
      callCreate(service, CTX, BASE_INTAKE, "new-request"),
      HttpStatus.CONFLICT,
      "SITE_LIMIT_REACHED",
    );
    expect(db.runs).toHaveLength(0);
    expect(db.keys).toHaveLength(0);
  });

  it('setup_failed Site 上已有 active refurbish 时拒绝 re-intake，保持全站单飞', async () => {
    const { service, db } = makeService({ existingSite: true, existingStatus: 'setup_failed' });
    db.runs.push({
      id: 'refurbish-running',
      siteId: 'site-existing',
      kind: 'refurbish',
      status: 'running',
    });

    await expectHttpError(
      callCreate(service, CTX, BASE_INTAKE, 'new-intake-key'),
      HttpStatus.CONFLICT,
      'SITE_LIMIT_REACHED',
    );
    expect(db.runs).toHaveLength(1);
  });

  it("有 key 的 launch 首次不确定失败：502 稳定码且保留账本；同 key 重试同一 build 并补写 ACK", async () => {
    let failOnce = true;
    const launches: DemoV0LaunchInput[] = [];
    const launcher = {
      launchDemoV0: async (input: DemoV0LaunchInput) => {
        launches.push(input);
        if (failOnce) {
          failOnce = false;
          throw new Error("internal temporal address must never leak");
        }
        return { firstExecutionRunId: "temporal-recovered" };
      },
    } as unknown as DemoV0Launcher;
    const { service, db } = makeService({ launcher });

    const firstError = await expectHttpError(
      callCreate(service, CTX, BASE_INTAKE, "recoverable-request"),
      HttpStatus.BAD_GATEWAY,
      "DEMO_LAUNCH_UNAVAILABLE",
    );
    expect(JSON.stringify(firstError.getResponse())).not.toContain(
      "internal temporal",
    );
    expect(db.sites).toHaveLength(1);
    expect(db.runs).toHaveLength(1);
    expect(db.keys).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({ status: "queued", temporalRunId: null });

    const replay = await callCreate(
      service,
      CTX,
      BASE_INTAKE,
      "recoverable-request",
    );
    expect(replay).toEqual({
      siteId: "site-1",
      buildId: "run-1",
      status: "generating_demo",
    });
    expect(db.sites).toHaveLength(1);
    expect(db.runs).toHaveLength(1);
    expect(db.keys).toHaveLength(1);
    expect(db.runs[0]?.temporalRunId).toBe("temporal-recovered");
    expect(launches).toHaveLength(2);
  });

  it("ACK 丢失但 workflow 已把 run 推到终态：旧 key 只重放旧 build，绝不重启 workflow", async () => {
    let launchCount = 0;
    let recoverCount = 0;
    const launcher = {
      launchDemoV0: async () => {
        launchCount += 1;
        throw new Error(
          "simulated response loss after Temporal accepted the start",
        );
      },
      recoverDemoV0: async () => {
        recoverCount += 1;
        return { firstExecutionRunId: "recovered-terminal-run" };
      },
    } as unknown as DemoV0Launcher;
    const { service, db } = makeService({ launcher });

    await expectHttpError(
      callCreate(service, CTX, BASE_INTAKE, "terminal-after-ack-loss"),
      HttpStatus.BAD_GATEWAY,
      "DEMO_LAUNCH_UNAVAILABLE",
    );
    Object.assign(db.sites[0]!, { status: "setup_failed" });
    Object.assign(db.runs[0]!, { status: "failed", finishedAt: new Date() });

    await expect(
      callCreate(service, CTX, BASE_INTAKE, "terminal-after-ack-loss"),
    ).resolves.toEqual({
      siteId: "site-1",
      buildId: "run-1",
      status: "generating_demo",
    });
    expect(launchCount).toBe(1);
    expect(recoverCount).toBe(1);
    expect(db.runs[0]?.temporalRunId).toBe("recovered-terminal-run");
  });

  it("ACK 丢失且 Temporal 历史无法恢复：同 key 稳定 502，终态 run 绝不重启", async () => {
    let launchCount = 0;
    let recoverCount = 0;
    const launcher = {
      launchDemoV0: async () => {
        launchCount += 1;
        throw new Error("simulated response loss");
      },
      recoverDemoV0: async () => {
        recoverCount += 1;
        throw new Error("workflow history expired");
      },
    } as unknown as DemoV0Launcher;
    const { service, db } = makeService({ launcher });

    await expectHttpError(
      callCreate(service, CTX, BASE_INTAKE, "unrecoverable-terminal"),
      HttpStatus.BAD_GATEWAY,
      "DEMO_LAUNCH_UNAVAILABLE",
    );
    Object.assign(db.sites[0]!, { status: "setup_failed" });
    Object.assign(db.runs[0]!, { status: "failed", finishedAt: new Date() });

    await expectHttpError(
      callCreate(service, CTX, BASE_INTAKE, "unrecoverable-terminal"),
      HttpStatus.BAD_GATEWAY,
      "DEMO_LAUNCH_UNAVAILABLE",
    );
    expect(launchCount).toBe(1);
    expect(recoverCount).toBe(1);
    expect(db.runs[0]?.temporalRunId).toBeNull();
  });

  it("Temporal 已返回但 ACK 行消失：不得冒充 201，返回可同 key 修复的稳定 502", async () => {
    const holder: { db?: FakeDb } = {};
    const launcher = {
      launchDemoV0: async ({ buildRunId }: DemoV0LaunchInput) => {
        // 模拟 launch 与 ACK 事务之间 run 被并发删除/不可见。
        const db = holder.db!;
        db.runs.splice(0, db.runs.length);
        return { firstExecutionRunId: `temporal-${buildRunId}` };
      },
    } as unknown as DemoV0Launcher;
    const harness = makeService({ launcher });
    holder.db = harness.db;

    await expectHttpError(
      callCreate(harness.service, CTX, BASE_INTAKE, "lost-ack-row"),
      HttpStatus.BAD_GATEWAY,
      "DEMO_LAUNCH_UNAVAILABLE",
    );
  });

  it("无 key 的同步 launch 失败仍补偿回滚新 Site/run，并返回稳定 502", async () => {
    const launcher = {
      launchDemoV0: async () => {
        throw new Error("temporal unreachable at 10.0.0.1");
      },
    } as unknown as DemoV0Launcher;
    const { service, db } = makeService({ launcher });

    await expectHttpError(
      callCreate(service, CTX, BASE_INTAKE),
      HttpStatus.BAD_GATEWAY,
      "DEMO_LAUNCH_UNAVAILABLE",
    );
    expect(db.sites).toHaveLength(0);
    expect(db.runs).toHaveLength(0);
    expect(db.keys).toHaveLength(0);
  });

  it("无 key：Temporal start 已成功但 ACK 写库失败时保留 Site/run，不删除运行中 workflow 的锚点", async () => {
    const { service, db, launches } = makeService({
      ackPersistError: new Error("transient DB failure after Temporal start"),
    });

    await expectHttpError(
      callCreate(service, CTX, BASE_INTAKE),
      HttpStatus.BAD_GATEWAY,
      "DEMO_LAUNCH_UNAVAILABLE",
    );

    expect(launches).toHaveLength(1);
    expect(db.sites).toHaveLength(1);
    expect(db.sites[0]).toMatchObject({ id: "site-1", status: "building" });
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({
      id: "run-1",
      status: "queued",
      temporalRunId: null,
    });
    expect(db.keys).toHaveLength(0);
  });

  it("旧 key 在异步终态失败后只重放旧 build；新 key 才原地复用 setup_failed Site 建新 build", async () => {
    const { service, db, launches } = makeService();
    const first = await callCreate(service, CTX, BASE_INTAKE, "first-attempt");
    Object.assign(db.sites[0]!, { status: "setup_failed" });
    Object.assign(db.runs[0]!, { status: "failed", finishedAt: new Date() });

    const oldReplay = await callCreate(
      service,
      CTX,
      BASE_INTAKE,
      "first-attempt",
    );
    expect(oldReplay).toEqual(first);
    expect(db.sites[0]?.status).toBe("setup_failed");
    expect(db.runs).toHaveLength(1);
    expect(launches).toHaveLength(1);

    const retry = await callCreate(service, CTX, BASE_INTAKE, "second-attempt");
    expect(retry).toEqual({
      siteId: "site-1",
      buildId: "run-2",
      status: "generating_demo",
    });
    expect(db.sites).toHaveLength(1);
    expect(db.sites[0]?.status).toBe("building");
    expect(db.runs).toHaveLength(2);
    expect(db.keys).toHaveLength(2);
    expect(launches).toHaveLength(2);
  });

  it("相同 key 按 workspace 隔离：两租户各自创建、各自重放", async () => {
    const { service, db, launches } = makeService();
    const firstA = await callCreate(service, CTX, BASE_INTAKE, "shared-key");
    const firstB = await callCreate(
      service,
      OTHER_CTX,
      BASE_INTAKE,
      "shared-key",
    );
    const replayA = await callCreate(service, CTX, BASE_INTAKE, "shared-key");
    const replayB = await callCreate(
      service,
      OTHER_CTX,
      BASE_INTAKE,
      "shared-key",
    );

    expect(replayA).toEqual(firstA);
    expect(replayB).toEqual(firstB);
    expect(firstA.siteId).not.toBe(firstB.siteId);
    expect(firstA.buildId).not.toBe(firstB.buildId);
    expect(db.sites).toHaveLength(2);
    expect(db.runs).toHaveLength(2);
    expect(db.keys).toHaveLength(2);
    expect(launches).toHaveLength(2);
  });

  it("无英文名：站名使用中文名，slug 使用 site- 前缀", async () => {
    const { service, db } = makeService();
    await callCreate(service, CTX, {
      ...BASE_INTAKE,
      company: { nameZh: "杭州泵业", nameEn: null },
    });
    expect(db.sites[0]?.name).toBe("杭州泵业");
    expect(db.sites[0]?.slug).toMatch(/^site-[a-z0-9]{6}$/);
  });

  it("launcher 本身仍属于 502 边界，不冒充校验或冲突错误", async () => {
    const launcher = {
      launchDemoV0: async () => {
        throw new Error("down");
      },
    } as unknown as DemoV0Launcher;
    const { service } = makeService({ launcher });
    const error = await callCreate(service, CTX, BASE_INTAKE).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(BadGatewayException);
  });
});
