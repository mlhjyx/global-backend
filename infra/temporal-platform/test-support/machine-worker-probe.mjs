import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire("/repo/apps/api/package.json");
const { Connection, Client } = require("@temporalio/client");
const {
  NativeConnection,
  Worker,
  Runtime,
  DefaultLogger,
} = require("@temporalio/worker");
const { Context } = require("@temporalio/activity");
const directory = "/run/secrets/temporal-platform-client";
const ca = await readFile(`${directory}/ca.crt`);
const tls = {
  serverNameOverride: "task4c-temporal",
  serverRootCACertificate: ca,
};
const address = "task4c-temporal:7233";
const token = async (name) =>
  (await readFile(`${directory}/${name}.jwt`, "utf8")).trim();
Runtime.install({
  logger: new DefaultLogger("ERROR"),
  telemetryOptions: { logging: { filter: "ERROR" } },
  workerHeartbeatInterval: "1s",
});

async function observed(label, read) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await read()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`MACHINE_OBSERVATION_TIMEOUT ${label}`);
}

async function denied(connection, method, request) {
  await assert.rejects(
    connection.withDeadline(Date.now() + 5000, () =>
      connection.workflowService[method](request),
    ),
    (error) => error?.code === 7 || error?.code === 16,
    `expected authorization rejection: ${method}`,
  );
}

const adminConnection = await Connection.connect({
  address,
  tls,
  apiKey: await token("admin"),
  connectTimeout: "5s",
});
try {
  // "default" must already exist: shared provisioning creates and validates it.
  // Obtain an actual server-issued platform task token, then attempt completion
  // with a valid customer worker and a caller-supplied customer namespace. The
  // closed authorizer admits the customer's own RPC; native token enforcement
  // must reject the mismatch before the history handler can consume the task.
  const platformRaw = await Connection.connect({
    address,
    tls,
    apiKey: await token("worker"),
    connectTimeout: "5s",
  });
  const customerRaw = await Connection.connect({
    address,
    tls,
    apiKey: await token("customer-worker"),
    connectTimeout: "5s",
  });
  try {
    const platformIdentity = `task4c-backend-worker:${randomUUID()}`;
    const customerIdentity = `task4c-customer-worker:${randomUUID()}`;
    const platformClient = new Client({
      connection: adminConnection,
      namespace: "platform-automation",
    });
    await platformClient.workflow.start("MachineWorkerProof", {
      workflowId: `token-binding-${randomUUID()}`,
      taskQueue: "understanding",
      workflowExecutionTimeout: "30s",
    });
    const task = await platformRaw.withDeadline(Date.now() + 10000, () =>
      platformRaw.workflowService.pollWorkflowTaskQueue({
        namespace: "platform-automation",
        identity: platformIdentity,
        taskQueue: { name: "understanding" },
      }),
    );
    assert.ok(task.taskToken?.length);
    await assert.rejects(
      customerRaw.withDeadline(Date.now() + 5000, () =>
        customerRaw.workflowService.respondWorkflowTaskFailed({
          namespace: "default",
          identity: customerIdentity,
          taskToken: task.taskToken,
          cause: 14,
        }),
      ),
      (error) =>
        error?.code === 3 &&
        /token from a different namespace/i.test(error?.details ?? ""),
      "native task token namespace mismatch must reject",
    );
    await platformRaw.withDeadline(Date.now() + 5000, () =>
      platformRaw.workflowService.respondWorkflowTaskFailed({
        namespace: "",
        identity: platformIdentity,
        taskToken: task.taskToken,
        cause: 14,
      }),
    );
    process.stdout.write("MACHINE_TOKEN_NAMESPACE_MISMATCH_REJECTED\n");
  } finally {
    await Promise.all([platformRaw.close(), customerRaw.close()]);
  }
  for (const spec of [
    {
      namespace: "platform-automation",
      subject: "task4c-backend-worker",
      workerToken: "worker",
      starterToken: "writer",
    },
    {
      namespace: "default",
      subject: "task4c-customer-worker",
      workerToken: "customer-worker",
      starterToken: "customer-client",
    },
  ]) {
    const identity = `${spec.subject}:${randomUUID()}`;
    const apiKey = await token(spec.workerToken);
    const raw = await Connection.connect({
      address,
      tls,
      apiKey,
      connectTimeout: "5s",
    });
    const native = await NativeConnection.connect({ address, tls, apiKey });
    const starter = await Connection.connect({
      address,
      tls,
      apiKey: await token(spec.starterToken),
      connectTimeout: "5s",
    });
    let worker;
    let stickyQueue;
    let phase = "negative-matrix";
    try {
      const other =
        spec.namespace === "default" ? "platform-automation" : "default";
      await denied(raw, "pollWorkflowTaskQueue", {
        namespace: other,
        identity,
        taskQueue: { name: "understanding" },
      });
      await denied(raw, "pollActivityTaskQueue", {
        namespace: spec.namespace,
        identity,
        taskQueue: { name: "other" },
      });
      await denied(raw, "startWorkflowExecution", {
        namespace: spec.namespace,
        workflowId: randomUUID(),
        workflowType: { name: "MachineWorkerProof" },
        taskQueue: { name: "understanding" },
        requestId: randomUUID(),
      });
      await denied(raw, "createSchedule", {
        namespace: spec.namespace,
        scheduleId: randomUUID(),
      });
      try {
        await raw.withDeadline(Date.now() + 5000, () =>
          raw.workflowService.describeNamespace({ namespace: spec.namespace }),
        );
        process.stdout.write(
          `MACHINE_DESCRIBE_NAMESPACE_STATUS ${spec.namespace} ALLOW\n`,
        );
      } catch (error) {
        if (error?.code !== 7 && error?.code !== 16) throw error;
        process.stdout.write(
          `MACHINE_DESCRIBE_NAMESPACE_STATUS ${spec.namespace} ${error.code}\n`,
        );
      }
      const workflowId = `machine-proof-${randomUUID()}`;
      let releaseActivity;
      const heartbeatObserved = new Promise((resolve) => {
        releaseActivity = resolve;
      });
      phase = "worker-create";
      worker = await Worker.create({
        connection: native,
        namespace: spec.namespace,
        taskQueue: "understanding",
        identity,
        workflowsPath:
          "/repo/infra/temporal-platform/test-support/machine-worker-workflows.cjs",
        bundlerOptions: {
          webpackConfigHook(config) {
            config.resolve.modules = [
              "/repo/apps/api/node_modules",
              ...config.resolve.modules,
            ];
            return config;
          },
        },
        activities: {
          async machineProofActivity(value) {
            Context.current().heartbeat(value);
            if (
              Context.current().info.workflowExecution.workflowId === workflowId
            )
              await heartbeatObserved;
            return value;
          },
        },
        maxCachedWorkflows: 10,
        maxConcurrentWorkflowTaskExecutions: 2,
        maxConcurrentActivityTaskExecutions: 2,
        shutdownGraceTime: "2s",
        shutdownForceTime: "5s",
      });
      const client = new Client({
        connection: starter,
        namespace: spec.namespace,
      });
      phase = "worker-run";
      await worker.runUntil(async () => {
        try {
          const handle = await client.workflow.start("MachineWorkerProof", {
            workflowId,
            taskQueue: "understanding",
            workflowExecutionTimeout: "30s",
          });
          await observed("activity-heartbeat", async () => {
            const description = await handle.describe();
            return description.raw.pendingActivities?.some(
              (activity) => activity.lastHeartbeatTime,
            );
          });
          await observed("worker-heartbeat", async () => {
            const workers = await adminConnection.workflowService.listWorkers({
              namespace: spec.namespace,
              pageSize: 100,
            });
            return workers.workers?.some(
              (entry) =>
                entry.workerIdentity === identity &&
                entry.taskQueue === "understanding",
            );
          });
          releaseActivity();
          assert.equal(await handle.result(), "first:second");
          const history = await handle.fetchHistory();
          stickyQueue = history.events.find(
            (event) =>
              event.workflowTaskScheduledEventAttributes?.taskQueue?.kind === 2,
          )?.workflowTaskScheduledEventAttributes.taskQueue;
          assert.ok(
            stickyQueue?.name.startsWith(`${identity}-`),
            "owned sticky workflow task was not observed in native history",
          );
          await observed("sticky-poller", async () => {
            const queue =
              await adminConnection.workflowService.describeTaskQueue({
                namespace: spec.namespace,
                taskQueue: stickyQueue,
                taskQueueType: 1,
              });
            return queue.pollers?.some(
              (poller) => poller.identity === identity,
            );
          });
        } finally {
          releaseActivity();
        }
      });
      assert.equal(worker.getState(), "STOPPED");
      phase = "shutdown-readback";
      await observed("worker-shutdown-ack", async () => {
        const workers = await adminConnection.workflowService.listWorkers({
          namespace: spec.namespace,
          pageSize: 100,
        });
        // SDK 1.23.0 emits SHUTTING_DOWN in ShutdownWorker; a SHUTDOWN
        // heartbeat would instead remove the row in native v1.31.2.
        const entry = (workers.workers ?? []).find(
          (entry) => entry.workerIdentity === identity,
        );
        const queue = await adminConnection.workflowService.describeTaskQueue({
          namespace: spec.namespace,
          taskQueue: stickyQueue,
          taskQueueType: 1,
        });
        // ShutdownWorker's required server effect is ForceUnloadTaskQueuePartition.
        // Poller presence was verified immediately before shutdown; its native
        // expiry is much longer than this bounded readback window.
        return (
          (!entry || entry.status === 2) &&
          !(queue.pollers ?? []).some((poller) => poller.identity === identity)
        );
      });
      process.stdout.write(
        `MACHINE_WORKER_PASS ${spec.namespace} workflow/activity/heartbeat/sticky/shutdown\n`,
      );
    } catch (error) {
      // Never dump SDK errors/options: they may contain connection metadata.
      process.stderr.write(
        `MACHINE_WORKER_FAILED ${spec.namespace} ${error?.name ?? "Error"} phase=${phase} code=${/^[A-Z_]{1,40}$/.test(error?.code ?? "") ? error.code : "none"} observation=${/^MACHINE_OBSERVATION_TIMEOUT ([a-z-]+)$/.exec(error?.message ?? "")?.[1] ?? "none"} describeNamespace=${/namespace/i.test(error?.message ?? "")} permissionDenied=${/permission|unauthoriz/i.test(error?.message ?? "")}\n`,
      );
      process.stderr.write(
        String(error?.stack ?? "")
          .split("\n")
          .filter((line) => /^\s+at /.test(line))
          .slice(0, 3)
          .join("\n") + "\n",
      );
      throw new Error("native machine Worker matrix failed");
    } finally {
      if (worker && worker.getState() === "RUNNING") worker.shutdown();
      await Promise.all([raw.close(), starter.close(), native.close()]);
    }
  }
} finally {
  await adminConnection.close();
  await Runtime.instance().shutdown();
}
