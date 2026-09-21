import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import type { RuntimeReleaseIdentity } from "../runtime/runtime-release-identity";
import type { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";
import { loadVerifiedPlatformAuthorityPolicyAsset } from "./platform-authority-policy-asset";
import { platformAutomationReadinessFactName } from "./platform-automation-readiness";
import { createCapabilityCache } from "./platform-capability-cache";
import { createCapabilityTransport } from "./platform-capability-transport";
import { CapabilityHttpsClient } from "./platform-capability-https";
import { MachineTokenClient } from "./machine-token-client";
import {
  machineTokenConfiguration,
  readMachineSecretFile,
} from "./machine-token-runtime";

export interface CapabilityRuntimeInput {
  readonly registry: RuntimeReadinessContributorRegistry;
  readonly identity: RuntimeReleaseIdentity;
  readonly admitted: () => boolean;
  readonly env?: NodeJS.ProcessEnv;
}
const CONFIG_KEYS = [
  "PLATFORM_CAPABILITY_ORIGIN",
  "PLATFORM_CAPABILITY_CA_FILE",
  "PLATFORM_CAPABILITY_JWKS_URI",
  "PLATFORM_CAPABILITY_ISSUER",
  "PLATFORM_CAPABILITY_GROWTHOS_SHA",
  "MACHINE_BOOTSTRAP_CA_FILE",
  "MACHINE_BOOTSTRAP_CERT_FILE",
  "MACHINE_BOOTSTRAP_KEY_FILE",
  "MACHINE_BOOTSTRAP_ENDPOINT",
  "MACHINE_BOOTSTRAP_CONFIGURATION_REVISION",
  "CAPABILITY_MACHINE_JWKS_URI",
  "CAPABILITY_MACHINE_ISSUER",
  "CAPABILITY_MACHINE_AUDIENCE",
  "CAPABILITY_MACHINE_SUBJECT",
] as const;
const failure = () => ({
  status: "failed" as const,
  code: "PLATFORM_CAPABILITY_UNAVAILABLE",
});
function fileRevision(path: string): string {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size < 1 ||
    stat.size > 65536
  )
    throw new Error();
  return [
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.mode,
    stat.uid,
  ].join(":");
}
/** One lifecycle shared by Nest API and the standalone platform Worker.
 * Contributor reads are local only; background bootstrap is independent of aggregate readiness. */
export class CapabilityRuntime {
  private readonly env: NodeJS.ProcessEnv;
  private readonly identity: RuntimeReleaseIdentity;
  private readonly policy = loadVerifiedPlatformAuthorityPolicyAsset();
  private readonly schedules = this.policy.policy.rows.map((row) => ({
    scheduleId: row.schedule_id,
    workflowType: row.workflow_type,
    taskQueue: row.task_queue,
    mode: row.desired_mode,
  }));
  private unregister: (() => void)[] = [];
  private cached: ReturnType<typeof createCapabilityCache> | undefined;
  private machine: MachineTokenClient | undefined;
  private https: CapabilityHttpsClient | undefined;
  private unsubscribe: (() => void) | undefined;
  private pins:
    | { env: string; files: ReadonlyMap<string, string>; configuration: string }
    | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active: AbortController | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;
  private started = false;
  constructor(private readonly input: CapabilityRuntimeInput) {
    this.env = input.env ?? process.env;
    this.identity = structuredClone(input.identity);
    try {
      for (const row of this.schedules)
        for (const fact of [
          "temporal_proof",
          "issuer",
          "revocation_delivery",
        ] as const)
          this.unregister.push(
            input.registry.register(
              platformAutomationReadinessFactName(fact, row.scheduleId),
              () => {
                if (!this.current()) return failure();
                return this.cached?.check(row.scheduleId) ?? failure();
              },
            ),
          );
    } catch (error) {
      this.stop();
      throw error;
    }
  }
  private envRevision(): string {
    return JSON.stringify(CONFIG_KEYS.map((key) => this.env[key] ?? ""));
  }
  private current(): boolean {
    try {
      if (this.stopped || !this.input.admitted() || !this.identity.attested)
        throw new Error();
      if (
        this.pins &&
        (this.pins.env !== this.envRevision() ||
          [...this.pins.files].some(
            ([path, pin]) => fileRevision(path) !== pin,
          ))
      )
        throw new Error();
      this.machine?.currentToken();
      return true;
    } catch {
      this.invalidate();
      this.closeClients();
      return false;
    }
  }
  private invalidate(): void {
    this.cached?.stop();
    this.cached = undefined;
  }
  private closeClients(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.machine?.close();
    this.machine = undefined;
    this.https?.close();
    this.https = undefined;
    this.pins = undefined;
  }
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.refresh();
  }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const controller = new AbortController();
    this.active = controller;
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error()), {
        once: true,
      });
      timer = setTimeout(() => controller.abort(), 3000);
      timer.unref();
    });
    const guard = () => {
      if (controller.signal.aborted || !this.current()) throw new Error();
    };
    const work = async () => {
      if (this.stopped || !this.input.admitted() || !this.identity.attested)
        throw new Error();
      const captured = this.envRevision();
      const env = { ...this.env };
      const required = (key: string) => {
        const value = env[key];
        if (!value || value !== value.trim()) throw new Error();
        return value;
      };
      if (
        !/^[a-f0-9]{40}$/.test(required("PLATFORM_CAPABILITY_GROWTHOS_SHA")) ||
        required("CAPABILITY_MACHINE_AUDIENCE") !==
          "platform-automation-capability-read"
      )
        throw new Error();
      const issuer = required("PLATFORM_CAPABILITY_ISSUER");
      const issuerUri = new URL(issuer);
      if (
        issuer.length > 2048 ||
        /[\p{Cc}\p{Z}]/u.test(issuer) ||
        issuer.includes("?") ||
        issuer.includes("#") ||
        issuerUri.username ||
        issuerUri.password ||
        !(
          issuerUri.protocol === "https:" ||
          (issuerUri.protocol === "http:" &&
            ["localhost", "127.0.0.1"].includes(issuerUri.hostname))
        )
      )
        throw new Error();
      const paths = [
        "PLATFORM_CAPABILITY_CA_FILE",
        "MACHINE_BOOTSTRAP_CA_FILE",
        "MACHINE_BOOTSTRAP_CERT_FILE",
        "MACHINE_BOOTSTRAP_KEY_FILE",
      ].map(required);
      const files = new Map(paths.map((path) => [path, fileRevision(path)]));
      const config = await machineTokenConfiguration(
        "capability-request",
        this.identity.artifact_digest.replace(/^sha256:/, ""),
        env,
      );
      try {
        const ca = await readMachineSecretFile(
          required("PLATFORM_CAPABILITY_CA_FILE"),
        );
        const fingerprint = createHash("sha256")
          .update(captured)
          .update(config.ca)
          .update(config.certificate)
          .update(config.privateKey)
          .update(ca)
          .digest("hex");
        if (
          controller.signal.aborted ||
          this.stopped ||
          captured !== this.envRevision() ||
          [...files].some(([path, pin]) => fileRevision(path) !== pin)
        ) {
          config.privateKey.fill(0);
          throw new Error();
        }
        if (this.pins?.configuration !== fingerprint) {
          this.invalidate();
          this.closeClients();
          this.machine = new MachineTokenClient(config);
          this.https = new CapabilityHttpsClient({
            origin: required("PLATFORM_CAPABILITY_ORIGIN"),
            ca,
            identityJwksUri: config.jwksUri,
            capabilityJwksUri: required("PLATFORM_CAPABILITY_JWKS_URI"),
          });
          this.pins = { env: captured, files, configuration: fingerprint };
          this.unsubscribe = this.machine.subscribe((value) => {
            if (!value) this.invalidate();
          });
        }
      } finally {
        config.privateKey.fill(0);
      }
      const machine = this.machine!,
        https = this.https!;
      await machine.getToken();
      guard();
      const jwks = await https.loadKeys(controller.signal);
      guard();
      const transport = createCapabilityTransport(
        {
          endpoint: https.endpoint,
          backendSha: this.identity.build_sha,
          growthosSha: required("PLATFORM_CAPABILITY_GROWTHOS_SHA"),
          policyDigest: this.policy.sha256,
          schedules: this.schedules,
        },
        async (signal) => {
          if (signal.aborted) throw new Error();
          const token = await machine.getToken();
          guard();
          return token;
        },
        (input, init) =>
          https.fetch(input, {
            ...init,
            signal: AbortSignal.any([init!.signal!, controller.signal]),
          }),
      );
      const next = createCapabilityCache(
        {
          expected: {
            issuer,
            audience: "platform-automation-capability-read",
            backendSha: this.identity.build_sha,
            growthosSha: required("PLATFORM_CAPABILITY_GROWTHOS_SHA"),
            policyDigest: this.policy.sha256,
          },
          schedules: this.schedules,
          jwks,
          allowedKids: jwks.keys.map((key) => key.kid!),
        },
        transport,
      );
      try {
        await next.refresh();
        guard();
        this.invalidate();
        this.cached = next;
      } catch (error) {
        next.stop();
        throw error;
      }
    };
    this.inFlight = Promise.race([work(), expired])
      .catch(() => this.invalidate())
      .finally(() => {
        clearTimeout(timer);
        controller.abort();
        if (this.active === controller) this.active = undefined;
        this.inFlight = undefined;
        if (this.started && !this.stopped) {
          this.timer = setTimeout(() => void this.refresh(), 10000);
          this.timer.unref();
        }
      });
    return this.inFlight;
  }
  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.active?.abort();
    this.invalidate();
    this.closeClients();
    for (const unregister of this.unregister) unregister();
    this.unregister = [];
  }
}
export function startCapabilityRuntime(
  input: CapabilityRuntimeInput,
): CapabilityRuntime {
  const runtime = new CapabilityRuntime(input);
  runtime.start();
  return runtime;
}
