/**
 * R0 intake contract：真 PostgreSQL + app_user RLS 验证（无 sandbox、无 mock DB）。
 *
 * 覆盖：迁移/约束、同键重放、异体冲突、并发、跨租户、RLS 读写、Temporal ACK
 * 不确定恢复、无 key 补偿，以及历史 request_hash=NULL 兼容。
 *
 * 前置：
 *   DATABASE_URL=postgresql://global:global@localhost:5432/global_dev pnpm --filter @global/db migrate:deploy
 *   APP_DATABASE_URL=postgresql://app_user:app_pw@localhost:5432/global_dev \
 *     node --import tsx scripts/verify-site-builder-intake-idempotency.mts
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { HttpException } from "@nestjs/common";
import { PrismaService } from "../src/prisma/prisma.service";
import type {
  DemoV0LaunchInput,
  DemoV0Launcher,
} from "../src/site-builder/demo-launcher";
import {
  IntakeService,
  type IntakeInput,
} from "../src/site-builder/intake.service";

process.env.APP_DATABASE_URL ??=
  "postgresql://app_user:app_pw@localhost:5432/global_dev";

const ENDPOINT = "POST /api/v1/site-builder/intake";
const workspaces = new Set<string>();

const INPUT: IntakeInput = {
  company: { nameZh: "R0 幂等验证企业", nameEn: "R0 Idempotency Verify Co." },
  industry: "isic-2813",
  products: ["verification pump"],
  targetMarkets: ["DE"],
  hasWebsite: false,
  websiteUrl: null,
  businessEmail: "verify-r0@example.com",
};

function ctx(workspaceId: string) {
  return { userId: "r0-verify", workspaceId, roles: [] };
}

function workspace(): string {
  const id = randomUUID();
  workspaces.add(id);
  return id;
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  console.log(`  ✅ ${message}`);
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof HttpException)) return undefined;
  const body = error.getResponse();
  if (typeof body !== "object" || body === null) return undefined;
  const envelope = body as { error?: { code?: string } };
  return envelope.error?.code;
}

function countingLauncher(
  calls: DemoV0LaunchInput[],
  launch?: (
    input: DemoV0LaunchInput,
  ) => Promise<{ firstExecutionRunId: string }>,
): DemoV0Launcher {
  return {
    launchDemoV0: async (input) => {
      calls.push(input);
      return (
        launch?.(input) ?? { firstExecutionRunId: `verify-${input.buildRunId}` }
      );
    },
    recoverDemoV0: async (input) => ({
      firstExecutionRunId: `verify-${input.buildRunId}`,
    }),
  };
}

async function counts(prisma: PrismaService, workspaceId: string) {
  return prisma.withWorkspace(workspaceId, async (tx) => ({
    sites: await tx.site.count(),
    runs: await tx.siteBuildRun.count(),
    keys: await tx.idempotencyKey.count({ where: { endpoint: ENDPOINT } }),
  }));
}

async function cleanup(prisma: PrismaService): Promise<void> {
  const errors: unknown[] = [];
  for (const workspaceId of workspaces) {
    try {
      await prisma.withWorkspace(workspaceId, async (tx) => {
        await tx.idempotencyKey.deleteMany({ where: { workspaceId } });
        await tx.site.deleteMany({ where: { workspaceId } });
      });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `failed to clean ${errors.length} R0 verify workspace(s)`,
    );
  }
}

async function waitWithTimeout(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("concurrent launcher barrier timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const prisma = new PrismaService();
  await prisma.$connect();

  try {
    console.log("① DB 角色 / migration / constraint");
    const role = await prisma.$queryRaw<{ isSuper: string }[]>`
      SELECT current_setting('is_superuser') AS "isSuper"`;
    check(
      role[0]?.isSuper === "off",
      "APP_DATABASE_URL 使用非 superuser，RLS 证明有效",
    );

    const relation = await prisma.$queryRaw<
      {
        rowSecurity: boolean;
        forceRowSecurity: boolean;
        hashType: string;
        constraintValidated: boolean;
      }[]
    >`
      SELECT c.relrowsecurity AS "rowSecurity",
             c.relforcerowsecurity AS "forceRowSecurity",
             format_type(a.atttypid, a.atttypmod) AS "hashType",
             con.convalidated AS "constraintValidated"
        FROM pg_class c
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'request_hash'
        JOIN pg_constraint con
          ON con.conrelid = c.oid AND con.conname = 'idempotency_key_request_hash_format'
       WHERE c.oid = 'idempotency_key'::regclass`;
    check(
      relation[0]?.rowSecurity && relation[0]?.forceRowSecurity,
      "idempotency_key 保持 ENABLE + FORCE RLS",
    );
    check(
      relation[0]?.hashType === "character varying(64)",
      "request_hash 为 varchar(64)",
    );
    check(
      relation[0]?.constraintValidated,
      "request_hash CHECK 已完成在线 VALIDATE",
    );

    const invalidWs = workspace();
    let invalidHashRejected = false;
    try {
      await prisma.withWorkspace(invalidWs, (tx) =>
        tx.idempotencyKey.create({
          data: {
            workspaceId: invalidWs,
            endpoint: "VERIFY invalid hash",
            key: "invalid-hash",
            requestHash: "not-a-sha256",
            response: {},
          },
        }),
      );
    } catch {
      invalidHashRejected = true;
    }
    check(invalidHashRejected, "DB CHECK 拒绝非 64 位小写 SHA-256");

    console.log("② 顺序重放 / request hash 冲突");
    const sequentialWs = workspace();
    const sequentialCalls: DemoV0LaunchInput[] = [];
    const sequential = new IntakeService(
      prisma,
      countingLauncher(sequentialCalls),
    );
    const first = await sequential.create(
      ctx(sequentialWs),
      INPUT,
      "sequential-key",
    );
    const replay = await sequential.create(
      ctx(sequentialWs),
      {
        businessEmail: INPUT.businessEmail,
        websiteUrl: null,
        hasWebsite: false,
        targetMarkets: ["DE"],
        products: ["verification pump"],
        industry: INPUT.industry,
        company: { nameEn: INPUT.company.nameEn, nameZh: INPUT.company.nameZh },
      },
      "sequential-key",
    );
    check(
      JSON.stringify(replay) === JSON.stringify(first),
      "同键同语义请求返回首个响应",
    );
    check(sequentialCalls.length === 1, "顺序重放不重复触发 launcher");
    check(
      JSON.stringify(await counts(prisma, sequentialWs)) ===
        JSON.stringify({ sites: 1, runs: 1, keys: 1 }),
      "顺序重放最终恰有 1 Site / 1 run / 1 key",
    );
    const stored = await prisma.withWorkspace(sequentialWs, (tx) =>
      tx.idempotencyKey.findUnique({
        where: {
          workspaceId_endpoint_key: {
            workspaceId: sequentialWs,
            endpoint: ENDPOINT,
            key: "sequential-key",
          },
        },
      }),
    );
    check(
      /^[0-9a-f]{64}$/.test(stored?.requestHash ?? ""),
      "request_hash 持久化为完整 SHA-256",
    );

    const mismatch = await sequential
      .create(
        ctx(sequentialWs),
        { ...INPUT, products: ["different product"] },
        "sequential-key",
      )
      .catch((error: unknown) => error);
    check(
      errorCode(mismatch) === "IDEMPOTENCY_KEY_REUSED",
      "同 key 异请求稳定返回冲突码",
    );
    check(sequentialCalls.length === 1, "异体冲突不启动第二条 workflow");

    console.log("③ 真并发：同 key / 不同 key");
    const concurrentSameWs = workspace();
    const sameCalls: DemoV0LaunchInput[] = [];
    let releaseBoth!: () => void;
    const bothLaunchesEntered = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const sameService = new IntakeService(
      prisma,
      countingLauncher(sameCalls, async (input) => {
        // 强制两个请求都在 temporalRunId=NULL 的 ACK 窗口进入 launcher，真实覆盖 CAS=1/0 收敛。
        if (sameCalls.length === 2) releaseBoth();
        await waitWithTimeout(bothLaunchesEntered, 5_000);
        return { firstExecutionRunId: `barrier-${input.buildRunId}` };
      }),
    );
    const sameResults = await Promise.all([
      sameService.create(ctx(concurrentSameWs), INPUT, "same-key"),
      sameService.create(ctx(concurrentSameWs), INPUT, "same-key"),
    ]);
    check(
      sameResults[0].siteId === sameResults[1].siteId &&
        sameResults[0].buildId === sameResults[1].buildId,
      "并发同 key 收敛到同一 site/build",
    );
    check(
      JSON.stringify(await counts(prisma, concurrentSameWs)) ===
        JSON.stringify({ sites: 1, runs: 1, keys: 1 }),
      "并发同 key 数据库最终恰有 1/1/1",
    );
    check(
      sameCalls.length === 2 &&
        new Set(sameCalls.map((call) => call.buildRunId)).size === 1,
      "barrier 强制双 start，且两个请求只指向一个确定性 workflowId/buildId",
    );
    const concurrentRun = await prisma.withWorkspace(concurrentSameWs, (tx) =>
      tx.siteBuildRun.findUnique({ where: { id: sameResults[0].buildId } }),
    );
    check(
      concurrentRun?.temporalRunId === `barrier-${sameResults[0].buildId}`,
      "双 ACK 的 CAS=1/0 最终持久化同一个 execution-chain head",
    );

    const concurrentDifferentWs = workspace();
    const differentCalls: DemoV0LaunchInput[] = [];
    const differentService = new IntakeService(
      prisma,
      countingLauncher(differentCalls),
    );
    const differentResults = await Promise.allSettled([
      differentService.create(ctx(concurrentDifferentWs), INPUT, "key-a"),
      differentService.create(ctx(concurrentDifferentWs), INPUT, "key-b"),
    ]);
    const fulfilled = differentResults.filter(
      (result) => result.status === "fulfilled",
    );
    const rejected = differentResults.filter(
      (result) => result.status === "rejected",
    );
    check(
      fulfilled.length === 1 && rejected.length === 1,
      "并发不同 key 仅一个请求赢得一站名额",
    );
    check(
      errorCode((rejected[0] as PromiseRejectedResult).reason) ===
        "SITE_LIMIT_REACHED",
      "并发 loser 返回稳定 SITE_LIMIT_REACHED",
    );
    check(
      JSON.stringify(await counts(prisma, concurrentDifferentWs)) ===
        JSON.stringify({ sites: 1, runs: 1, keys: 1 }),
      "并发不同 key 也不遗留 loser 账本",
    );

    console.log("④ 跨 workspace + RLS 读写隔离");
    const wsA = workspace();
    const wsB = workspace();
    const tenantCalls: DemoV0LaunchInput[] = [];
    const tenantService = new IntakeService(
      prisma,
      countingLauncher(tenantCalls),
    );
    const tenantA = await tenantService.create(ctx(wsA), INPUT, "shared-key");
    const tenantB = await tenantService.create(ctx(wsB), INPUT, "shared-key");
    check(
      tenantA.siteId !== tenantB.siteId && tenantA.buildId !== tenantB.buildId,
      "两租户可使用相同 key 且响应彼此独立",
    );
    const invisible = await prisma.withWorkspace(wsB, async (tx) => ({
      site: await tx.site.findUnique({ where: { id: tenantA.siteId } }),
      run: await tx.siteBuildRun.findUnique({ where: { id: tenantA.buildId } }),
      key: await tx.idempotencyKey.findUnique({
        where: {
          workspaceId_endpoint_key: {
            workspaceId: wsA,
            endpoint: ENDPOINT,
            key: "shared-key",
          },
        },
      }),
    }));
    check(
      !invisible.site && !invisible.run && !invisible.key,
      "B 对 A 的 Site/run/key 均不可见",
    );
    let spoofBlocked = false;
    try {
      await prisma.withWorkspace(wsB, (tx) =>
        tx.idempotencyKey.create({
          data: {
            workspaceId: wsA,
            endpoint: "VERIFY rls spoof",
            key: "spoof",
            requestHash: null,
            response: {},
          },
        }),
      );
    } catch {
      spoofBlocked = true;
    }
    check(spoofBlocked, "B 无法伪写 workspace_id=A（WITH CHECK 生效）");

    console.log("⑤ 启动 ACK 失败恢复 / 无 key 补偿");
    const recoverWs = workspace();
    let failOnce = true;
    const recoverCalls: DemoV0LaunchInput[] = [];
    const recoverService = new IntakeService(
      prisma,
      countingLauncher(recoverCalls, async (input) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("simulated ACK loss");
        }
        return { firstExecutionRunId: `recovered-${input.buildRunId}` };
      }),
    );
    const uncertain = await recoverService
      .create(ctx(recoverWs), INPUT, "recover-key")
      .catch((error: unknown) => error);
    check(
      errorCode(uncertain) === "DEMO_LAUNCH_UNAVAILABLE",
      "有 key ACK 不确定返回稳定 502 码",
    );
    check(
      JSON.stringify(await counts(prisma, recoverWs)) ===
        JSON.stringify({ sites: 1, runs: 1, keys: 1 }),
      "有 key ACK 不确定保留 Site/run/key",
    );
    const recovered = await recoverService.create(
      ctx(recoverWs),
      INPUT,
      "recover-key",
    );
    check(
      recovered.buildId === recoverCalls[0]?.buildRunId,
      "同 key 恢复复用原 build",
    );
    const recoveredRun = await prisma.withWorkspace(recoverWs, (tx) =>
      tx.siteBuildRun.findUnique({ where: { id: recovered.buildId } }),
    );
    check(
      recoveredRun?.temporalRunId === `recovered-${recovered.buildId}`,
      "恢复后持久化 Temporal execution ACK",
    );

    const terminalWs = workspace();
    let terminalLaunches = 0;
    let terminalRecoveries = 0;
    const terminalService = new IntakeService(prisma, {
      launchDemoV0: async () => {
        terminalLaunches += 1;
        throw new Error("simulated response loss after Temporal start");
      },
      recoverDemoV0: async ({ buildRunId }) => {
        terminalRecoveries += 1;
        return { firstExecutionRunId: `terminal-${buildRunId}` };
      },
    });
    const terminalUncertain = await terminalService
      .create(ctx(terminalWs), INPUT, "terminal-recover-key")
      .catch((error: unknown) => error);
    check(
      errorCode(terminalUncertain) === "DEMO_LAUNCH_UNAVAILABLE",
      "终态 ACK 丢失前置请求返回稳定 502",
    );
    const terminalRun = await prisma.withWorkspace(terminalWs, async (tx) => {
      const run = await tx.siteBuildRun.findFirst({
        where: { workspaceId: terminalWs },
      });
      if (!run) throw new Error("terminal recovery run missing");
      await tx.siteBuildRun.update({
        where: { id: run.id },
        data: { status: "failed", finishedAt: new Date() },
      });
      await tx.site.update({
        where: { id: run.siteId },
        data: { status: "setup_failed" },
      });
      return run;
    });
    const terminalRecovered = await terminalService.create(
      ctx(terminalWs),
      INPUT,
      "terminal-recover-key",
    );
    const terminalPersisted = await prisma.withWorkspace(terminalWs, (tx) =>
      tx.siteBuildRun.findUnique({ where: { id: terminalRun.id } }),
    );
    check(
      terminalRecovered.buildId === terminalRun.id &&
        terminalLaunches === 1 &&
        terminalRecoveries === 1,
      "终态 run 只 describe 恢复，绝不重新 start",
    );
    check(
      terminalPersisted?.temporalRunId === `terminal-${terminalRun.id}`,
      "终态恢复的 execution-chain ACK 已持久化",
    );

    const unkeyedWs = workspace();
    const unkeyedService = new IntakeService(
      prisma,
      countingLauncher([], async () => {
        throw new Error("definite launch failure");
      }),
    );
    const unkeyedError = await unkeyedService
      .create(ctx(unkeyedWs), INPUT)
      .catch((error: unknown) => error);
    check(
      errorCode(unkeyedError) === "DEMO_LAUNCH_UNAVAILABLE",
      "无 key 失败也返回稳定 502 码",
    );
    check(
      JSON.stringify(await counts(prisma, unkeyedWs)) ===
        JSON.stringify({ sites: 0, runs: 0, keys: 0 }),
      "无 key 新站失败补偿删除 Site，FK cascade 删除 run",
    );

    const unkeyedAckWs = workspace();
    let workspaceTransactions = 0;
    const ackFailingPrisma = {
      withWorkspace: async (
        workspaceId: string,
        fn: (tx: never) => Promise<unknown>,
      ) => {
        workspaceTransactions += 1;
        if (workspaceTransactions === 2) {
          throw new Error("simulated DB outage after Temporal start returned");
        }
        return prisma.withWorkspace(workspaceId, fn as never);
      },
    } as unknown as PrismaService;
    const unkeyedAckCalls: DemoV0LaunchInput[] = [];
    const unkeyedAckService = new IntakeService(
      ackFailingPrisma,
      countingLauncher(unkeyedAckCalls),
    );
    const unkeyedAckError = await unkeyedAckService
      .create(ctx(unkeyedAckWs), INPUT)
      .catch((error: unknown) => error);
    check(
      errorCode(unkeyedAckError) === "DEMO_LAUNCH_UNAVAILABLE" &&
        unkeyedAckCalls.length === 1,
      "无 key 的 start 成功 + ACK 写库失败返回稳定 502",
    );
    check(
      JSON.stringify(await counts(prisma, unkeyedAckWs)) ===
        JSON.stringify({ sites: 1, runs: 1, keys: 0 }),
      "无 key 的 post-start ACK 失败保留真库 Site/run，不删除运行中 workflow 锚点",
    );

    console.log("⑥ nullable 旧 endpoint 兼容");
    const legacyWs = workspace();
    await prisma.withWorkspace(legacyWs, (tx) =>
      tx.idempotencyKey.create({
        data: {
          workspaceId: legacyWs,
          endpoint: "POST /companies",
          key: "legacy-company-key",
          response: { legacy: true },
        },
      }),
    );
    const legacy = await prisma.withWorkspace(legacyWs, (tx) =>
      tx.idempotencyKey.findUnique({
        where: {
          workspaceId_endpoint_key: {
            workspaceId: legacyWs,
            endpoint: "POST /companies",
            key: "legacy-company-key",
          },
        },
      }),
    );
    check(
      legacy?.requestHash === null,
      "迁移后旧 endpoint 仍可写/读 request_hash=NULL",
    );

    console.log("\n🎉 R0 intake 真库验证全绿。");
  } finally {
    try {
      await cleanup(prisma);
    } finally {
      await prisma.$disconnect();
    }
  }
}

main().catch((error) => {
  console.error("💥 R0 intake verify failed:", error);
  process.exit(1);
});
