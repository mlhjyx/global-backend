export type WorkerWorkload = "customer-worker" | "platform-worker";

export function workerComposition(workload: string) {
  if (workload !== "customer-worker" && workload !== "platform-worker")
    throw new Error("WORKER_WORKLOAD_INVALID");
  return Object.freeze({
    workload,
    namespace:
      workload === "platform-worker" ? "platform-automation" : "default",
    role:
      workload === "platform-worker"
        ? ("PLATFORM_WORKER" as const)
        : ("WORKER" as const),
    profile:
      workload === "platform-worker"
        ? ("temporal-platform-worker" as const)
        : ("temporal-customer-worker" as const),
    taskQueue: "understanding",
  });
}

export function workerIdentity(subject: string, instanceId: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(subject) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      instanceId,
    )
  )
    throw new Error("WORKER_IDENTITY_INVALID");
  return `${subject}:${instanceId}`;
}
