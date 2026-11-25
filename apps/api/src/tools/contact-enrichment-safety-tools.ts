import { paidOperationKey } from "../site-builder/site-build-cost-ledger";
import {
  createSmtpRcptProbeTool,
  type SmtpProbeInput,
  type SmtpProbeOutput,
  type SmtpRcptProbeToolDependencies,
} from "./builtin-tools";
import { resolvePublicIp } from "../adapters/net-guard";
import { smtpRcptProbe } from "../adapters/smtp-probe";
import type { ToolRegistry } from "./tool-registry";
import { parseContactEmailFindPayload } from "../durable-results/artifact/materializers/contact-email-find.materializer";
import {
  requestPublicHttp,
  type PublicHttpDependencies,
} from "../adapters/guarded-http";
import { assertPiiKeyConfigured } from "../compliance/pii-crypto";
import {
  ExecutionControlError,
  isExecutionControlError,
} from "../execution-budget/execution-control-error";
import { HunterProvider } from "../enrichment/finders/hunter.provider";
import { ProspeoProvider } from "../enrichment/finders/prospeo.provider";
import {
  enrichmentInputVersion,
  normalizeEnrichedEmail,
} from "../enrichment/finders/email-enrichment-provider";
import { MillionVerifierProvider } from "../enrichment/verification/millionverifier.provider";
import { EmailableProvider } from "../enrichment/verification/emailable.provider";
import { ZeroBounceProvider } from "../enrichment/verification/zerobounce.provider";
import type { EmailVerificationProvider } from "../enrichment/verification/email-verification-provider";
import { parseContactEmailVerificationResult } from "../durable-results/contact-email-verification-projections";
import {
  closedSafetyRecord,
  deepFreezeSafety,
  parseEnrichmentCandidateRef,
  type BoundEnrichmentStep,
} from "../enrichment/safety/enrichment-safety.contract";
import {
  finderPhysicalInputFingerprint,
  verificationPhysicalInputFingerprint,
} from "../enrichment/safety/enrichment-target-snapshot";
import { isCanonicalArtifactUuid } from "../durable-results/artifact/artifact.types";
import {
  isTerminalExternalActionPolicyDenied,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "./tool-contract";
export const CONTROLLED_ENRICHMENT_PROVIDERS = [
  "hunter",
  "prospeo",
  "millionverifier",
  "emailable",
  "zerobounce",
] as const;
export type ControlledEnrichmentProvider =
  (typeof CONTROLLED_ENRICHMENT_PROVIDERS)[number];
export function isControlledFinderProvider(
  provider: ControlledEnrichmentProvider,
): provider is "hunter" | "prospeo" {
  return provider === "hunter" || provider === "prospeo";
}
/** Closed registration truth for the five governance-listed producers; the factory takes ids from here. */
export const CONTROLLED_ENRICHMENT_TOOL_DECLARATIONS = Object.freeze([
  Object.freeze({
    id: "contact_email.find.hunter",
    version: "1.0.0",
    durableResultStrategy: {
      kind: "artifact_reference",
      schema: "contact-email-find-hunter/v1",
      maxBytes: 16384,
      mediaTypes: ["application/octet-stream"],
      privacyClass: "PERSONAL_DATA",
      ttlSeconds: 86400,
    },
  }),
  Object.freeze({
    id: "contact_email.find.prospeo",
    version: "1.0.0",
    durableResultStrategy: {
      kind: "artifact_reference",
      schema: "contact-email-find-prospeo/v1",
      maxBytes: 16384,
      mediaTypes: ["application/octet-stream"],
      privacyClass: "PERSONAL_DATA",
      ttlSeconds: 86400,
    },
  }),
  Object.freeze({
    id: "contact_email.verify.millionverifier",
    version: "1.0.0",
    durableResultStrategy: Object.freeze({ kind: "typed_projection", schema: "contact-email-verify-millionverifier/v1" }),
  }),
  Object.freeze({
    id: "contact_email.verify.emailable",
    version: "1.0.0",
    durableResultStrategy: Object.freeze({ kind: "typed_projection", schema: "contact-email-verify-emailable/v1" }),
  }),
  Object.freeze({
    id: "contact_email.verify.zerobounce",
    version: "1.0.0",
    durableResultStrategy: Object.freeze({ kind: "typed_projection", schema: "contact-email-verify-zerobounce/v1" }),
  }),
]);
export function controlledEnrichmentToolId(provider: ControlledEnrichmentProvider): string {
  return isControlledFinderProvider(provider)
    ? "contact_email.find." + provider
    : "contact_email.verify." + provider;
}
export interface ControlledEnrichmentProviderState {
  readonly provider: ControlledEnrichmentProvider;
  readonly apiKey: string | null;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly costMicrousd: number;
  readonly pricingVersion: string;
  readonly enabled: boolean;
  readonly policyAllowed: boolean;
  readonly retentionSeconds: number;
}
export interface ControlledEnrichmentWireInput {
  readonly step: BoundEnrichmentStep;
  readonly finder: Readonly<{
    fullName: string;
    domain: string;
    companyName?: string;
    linkedinUrl?: string;
  }> | null;
  readonly verification: Readonly<{
    email: string;
    domain: string;
    providerTimeoutSeconds: number | null;
  }> | null;
}
export interface ContactEnrichmentSafetyToolDeps {
  readonly providers: Readonly<
    Record<ControlledEnrichmentProvider, ControlledEnrichmentProviderState>
  >;
  currentProvider(
    provider: ControlledEnrichmentProvider,
  ): Promise<ControlledEnrichmentProviderState>;
  loadTrustedInput(
    stepId: string,
    context: Readonly<ToolContext>,
    deriveOnly?: boolean,
  ): Promise<ControlledEnrichmentWireInput>;
  readonly httpDependencies?: Pick<
    PublicHttpDependencies,
    "resolver" | "executePinned"
  >;
}

export const CONTROLLED_ENRICHMENT_API_HOSTS = Object.freeze({
  hunter: "api.hunter.io",
  prospeo: "api.prospeo.io",
  millionverifier: "api.millionverifier.com",
  emailable: "api.emailable.com",
  zerobounce: "api.zerobounce.net",
});
function denied(): never {
  throw new ExecutionControlError("EXECUTION_BUDGET_REQUEST_INVALID");
}
function unknownResult(): never {
  throw new ExecutionControlError("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
}
function parseInput(value: unknown): { stepId: string } {
  const row = closedSafetyRecord(value, ["stepId"]);
  if (!isCanonicalArtifactUuid(row.stepId)) return denied();
  return { stepId: row.stepId };
}
const PROVIDER_HOSTS = CONTROLLED_ENRICHMENT_API_HOSTS;
function timeoutOf(config: ControlledEnrichmentProviderState): number {
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100)
    return denied();
  return Math.min(config.timeoutMs, 30000);
}
function quoteOf(config: ControlledEnrichmentProviderState): string {
  if (
    !Number.isSafeInteger(config.costMicrousd) ||
    config.costMicrousd < 0 ||
    config.costMicrousd > 150000
  )
    return denied();
  return BigInt(config.costMicrousd).toString();
}
function assertProvider(
  provider: ControlledEnrichmentProvider,
  current: ControlledEnrichmentProviderState,
  initial: ControlledEnrichmentProviderState,
): void {
  if (
    current.provider !== provider ||
    !current.enabled ||
    !current.policyAllowed ||
    typeof current.apiKey !== "string" ||
    !current.apiKey.trim() ||
    current.pricingVersion !== initial.pricingVersion ||
    quoteOf(current) !== quoteOf(initial)
  )
    return denied();
  const url = new URL(current.baseUrl);
  if (
    url.protocol !== "https:" ||
    url.hostname !== PROVIDER_HOSTS[provider] ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    current.baseUrl !== initial.baseUrl
  )
    return denied();
  if (
    timeoutOf(current) !== timeoutOf(initial) ||
    !Number.isSafeInteger(current.retentionSeconds) ||
    current.retentionSeconds < 1 ||
    current.retentionSeconds < Math.min(86400, initial.retentionSeconds)
  )
    return denied();
}
function assertBinding(
  provider: ControlledEnrichmentProvider,
  wire: ControlledEnrichmentWireInput,
  input: { stepId: string },
  ctx: ToolContext,
  config: ControlledEnrichmentProviderState,
): void {
  const step = wire.step;
  const toolId = controlledEnrichmentToolId(provider);
  if (
    step.stepId !== input.stepId ||
    step.provider !== provider ||
    step.toolId !== toolId ||
    step.toolVersion !== "1.0.0" ||
    step.quoteMicrousd !== quoteOf(config) ||
    step.pricingVersion !== config.pricingVersion ||
    ctx.workspaceId !== step.workspaceId ||
    ctx.runId !== step.accountKey ||
    ctx.purpose !== "enrichment" ||
    ctx.artifactSubject?.subjectType !== "contact" ||
    ctx.artifactSubject.subjectId !== step.contactId
  )
    return denied();
  if (isControlledFinderProvider(provider)) {
    if (
      step.phase !== "FINDER" ||
      !wire.finder ||
      wire.verification !== null ||
      step.candidateRef !== null
    )
      return denied();
    const inputVersion = enrichmentInputVersion(wire.finder);
    if (
      finderPhysicalInputFingerprint({
        workspaceId: step.workspaceId,
        contactId: step.contactId,
        inputVersion,
      }) !== step.inputFingerprint
    )
      return denied();
  } else {
    if (
      step.phase !== "VERIFY" ||
      !wire.verification ||
      wire.finder !== null ||
      step.candidateRef === null
    )
      return denied();
    parseEnrichmentCandidateRef(step.candidateRef);
    const email = normalizeEnrichedEmail(
      wire.verification.email,
      wire.verification.domain,
    );
    if (!email) return denied();
    if (
      verificationPhysicalInputFingerprint({
        workspaceId: step.workspaceId,
        contactId: step.contactId,
        provider,
        email,
        providerTimeoutSeconds: wire.verification.providerTimeoutSeconds,
      }) !== step.inputFingerprint
    )
      return denied();
  }
}
interface PhysicalCapture {
  fetches: number;
  wires: number;
  failure: unknown;
}
function controlledFetch(
  deps: ContactEnrichmentSafetyToolDeps,
  provider: ControlledEnrichmentProvider,
  initial: ControlledEnrichmentProviderState,
  used: ControlledEnrichmentProviderState,
  wire: ControlledEnrichmentWireInput,
  ctx: ToolContext,
  capture: PhysicalCapture,
): typeof fetch {
  return async (input, init) => {
    try {
      capture.fetches += 1;
      const isProspeoPost = provider === "prospeo";
      if (
        capture.fetches !== 1 ||
        init?.signal?.aborted ||
        (isProspeoPost
          ? init?.method !== "POST" ||
            typeof init.body !== "string" ||
            Buffer.byteLength(init.body, "utf8") > 16384
          : init?.method !== "GET" || init.body !== undefined)
      )
        return denied();
      const raw =
        input instanceof URL
          ? input.toString()
          : typeof input === "string"
            ? input
            : input.url;
      const url = new URL(raw);
      if (url.origin !== new URL(used.baseUrl).origin) return denied();
      if (isProspeoPost && url.pathname !== "/enrich-person") return denied();
      const response = await requestPublicHttp(
        raw,
        {
          method: isProspeoPost ? "POST" : "GET",
          ...(isProspeoPost
            ? {
                headers: {
                  "x-key": used.apiKey!,
                  "content-type": "application/json",
                },
                body: init!.body as string,
              }
            : {}),
          timeoutMs: timeoutOf(used),
          maxBytes: 1000000,
          maxRedirects: 0,
        },
        {
          ...deps.httpDependencies,
          authorizeExternalAction: ctx.authorizeExternalAction,
          beforePhysicalWire: async () => {
            try {
              const current = await deps.currentProvider(provider);
              assertProvider(provider, current, initial);
              if (current.apiKey !== used.apiKey) return denied();
              assertBinding(
                provider,
                wire,
                { stepId: wire.step.stepId },
                ctx,
                current,
              );
              await ctx.beforePhysicalWire!();
            } catch (error) {
              capture.failure = error;
              throw error;
            }
          },
          dispatchPhysicalWire: async (execute) => {
            const run = async () => {
              capture.wires += 1;
              if (capture.wires !== 1) return unknownResult();
              return execute();
            };
            return ctx.dispatchPhysicalWire
              ? ctx.dispatchPhysicalWire(
                  "contact-enrichment:" + wire.step.stepId,
                  run,
                )
              : run();
          },
        },
      );
      if (response.body.byteLength > 1000000 || !response.ok)
        return unknownResult();
      return new Response(new Uint8Array(response.body), {
        status: response.status,
        headers: response.headers,
      });
    } catch (error) {
      if (capture.failure === undefined) capture.failure = error;
      throw error;
    }
  };
}
function rethrowCaptured(capture: PhysicalCapture): void {
  if (capture.failure === undefined) return;
  if (
    isExecutionControlError(capture.failure) ||
    isTerminalExternalActionPolicyDenied(capture.failure)
  )
    throw capture.failure;
  if (capture.wires > 0) return unknownResult();
  return denied();
}
function verificationProvider(
  provider: Exclude<ControlledEnrichmentProvider, "hunter" | "prospeo">,
  config: ControlledEnrichmentProviderState,
  fetchImpl: typeof fetch,
): EmailVerificationProvider {
  if (provider === "millionverifier")
    return new MillionVerifierProvider(config, fetchImpl);
  if (provider === "emailable") return new EmailableProvider(config, fetchImpl);
  return new ZeroBounceProvider(config, fetchImpl);
}
async function executeControlled(
  deps: ContactEnrichmentSafetyToolDeps,
  provider: ControlledEnrichmentProvider,
  initial: ControlledEnrichmentProviderState,
  inputValue: unknown,
  ctx: ToolContext,
): Promise<ToolResult<unknown>> {
  if (
    ctx.paidCost !== undefined ||
    typeof ctx.beforePhysicalWire !== "function"
  )
    return denied();
  const input = parseInput(inputValue);
  const current = await deps.currentProvider(provider);
  assertProvider(provider, current, initial);
  if (isControlledFinderProvider(provider)) assertPiiKeyConfigured();
  const wire = await deps.loadTrustedInput(input.stepId, ctx);
  assertBinding(provider, wire, input, ctx, current);
  const capture: PhysicalCapture = { fetches: 0, wires: 0, failure: undefined };
  const fetchImpl = controlledFetch(
    deps,
    provider,
    initial,
    current,
    wire,
    ctx,
    capture,
  );
  const costMicrousd = quoteOf(initial);
  const costCents = Number(costMicrousd) / 10000;
  if (isControlledFinderProvider(provider)) {
    const payload = wire.finder!;
    const adapter =
      provider === "hunter"
        ? new HunterProvider(current, fetchImpl)
        : new ProspeoProvider(
            { ...current, minIntervalMs: 0, max429Retries: 0 },
            fetchImpl,
          );
    const outcome = await adapter.findEmail({
      ...payload,
      workspaceId: wire.step.workspaceId,
      contactId: wire.step.contactId,
      accountKey: wire.step.accountKey,
      runId: wire.step.accountKey,
    });
    rethrowCaptured(capture);
    if (
      capture.fetches !== 1 ||
      capture.wires !== 1 ||
      outcome.status === "error"
    )
      return unknownResult();
    const data =
      outcome.status === "hit"
        ? {
            status: "hit",
            email: outcome.hit.email,
            providerConfidence: outcome.hit.providerConfidence ?? null,
            acceptAll: outcome.hit.acceptAll ?? null,
            pattern: outcome.hit.pattern ?? null,
            reason: "candidate_found",
          }
        : {
            status: "miss",
            email: null,
            providerConfidence: null,
            acceptAll: null,
            pattern: null,
            reason: "no_match",
          };
    return deepFreezeSafety({
      data: parseContactEmailFindPayload(data),
      costCents,
      costMicrousd,
    });
  }
  const payload = wire.verification!;
  const email = normalizeEnrichedEmail(payload.email, payload.domain);
  if (!email) return denied();
  const adapter = verificationProvider(provider, current, fetchImpl);
  const outcome = await adapter.verify({
    email,
    ...(payload.providerTimeoutSeconds === null
      ? {}
      : { providerTimeoutSeconds: payload.providerTimeoutSeconds }),
  });
  rethrowCaptured(capture);
  if (capture.fetches !== 1 || capture.wires !== 1 || outcome.error !== null)
    return unknownResult();
  return parseContactEmailVerificationResult(provider, {
    data: {
      providerKey: provider,
      state: outcome.state,
      catchAll: outcome.catchAll,
      catchAllClass: outcome.catchAllClass,
      score: outcome.score,
      acceptAll: outcome.acceptAll,
      disposable: outcome.disposable,
      role: outcome.role,
      reason: "provider_verdict",
      costBasis: "estimated_upper_bound",
    },
    costCents,
    costMicrousd,
  });
}
export function createContactEnrichmentSafetyTools(
  deps: ContactEnrichmentSafetyToolDeps,
): readonly Tool<{ stepId: string }, unknown>[] {
  return Object.freeze(
    CONTROLLED_ENRICHMENT_PROVIDERS.map((provider) => {
      const initial = Object.freeze({ ...deps.providers[provider] });
      const finder = isControlledFinderProvider(provider);
      const quote = quoteOf(initial);
      if (
        !Number.isSafeInteger(initial.retentionSeconds) ||
        initial.retentionSeconds < 1
      )
        return denied();
      const tool: Tool<{ stepId: string }, unknown> = {
        id: controlledEnrichmentToolId(provider),
        version: "1.0.0",
        category: finder ? "structured_source" : "verify",
        sourceClass: finder ? "contact_discovery" : "email_verification",
        cost: Object.freeze({
          unit: "request",
          estimatedCents: Number(quote) / 10000,
          estimatedMicrousd: quote,
          external: true,
        }),
        rateLimit: { rps: 1, concurrency: 1 },
        compliance: {
          sourcePolicy: "required",
          policyDomain: PROVIDER_HOSTS[provider],
          respectsRobots: false,
          personalData: true,
          allowedPurpose: ["enrichment"],
          reversible: true,
          authRequired: true,
          risk: "medium",
        },
        capabilities: {
          produces: ["contact"],
          accepts: ["domain"],
          enrichesOnly: true,
        },
        idempotencyKey: (input) => parseInput(input).stepId,
        durableResultStrategy: finder
          ? {
              kind: "artifact_reference",
              schema:
                provider === "prospeo"
                  ? "contact-email-find-prospeo/v1"
                  : "contact-email-find-hunter/v1",
              maxBytes: 16384,
              mediaTypes: ["application/octet-stream"],
              privacyClass: "PERSONAL_DATA",
              ttlSeconds: Math.min(86400, initial.retentionSeconds),
            }
          : {
              kind: "typed_projection",
              schema:
                provider === "millionverifier"
                  ? "contact-email-verify-millionverifier/v1"
                  : provider === "emailable"
                    ? "contact-email-verify-emailable/v1"
                    : "contact-email-verify-zerobounce/v1",
            },
        physicalWireObservation: "before_each_wire",
        async healthCheck() {
          try {
            const current = await deps.currentProvider(provider);
            assertProvider(provider, current, initial);
            return { healthy: true };
          } catch {
            return { healthy: false };
          }
        },
        execute: (input, ctx) =>
          executeControlled(deps, provider, initial, input, ctx),
      };
      return Object.freeze(tool);
    }),
  );
}

export function registerContactEnrichmentSafetyTools(
  registry: ToolRegistry,
  deps: ContactEnrichmentSafetyToolDeps,
): ToolRegistry {
  const [hunterTool, prospeoTool, millionVerifierTool, emailableTool, zeroBounceTool] =
    createContactEnrichmentSafetyTools(deps);
  if (!hunterTool || !prospeoTool || !millionVerifierTool || !emailableTool || !zeroBounceTool)
    throw new ExecutionControlError("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
  registry.register(hunterTool as Tool);
  registry.register(prospeoTool as Tool);
  registry.register(millionVerifierTool as Tool);
  registry.register(emailableTool as Tool);
  registry.register(zeroBounceTool as Tool);
  return registry;
}

/** Reuse the original SMTP producer, key and protocol; only add the step's last-send gate. */
export function createStepAwareSmtpRcptProbeTool(
  dependencies: SmtpRcptProbeToolDependencies = {
    resolveMxHost: resolvePublicIp,
    executeSmtpProbe: smtpRcptProbe,
  },
): Tool<SmtpProbeInput, SmtpProbeOutput> {
  const original = createSmtpRcptProbeTool(dependencies);
  return {
    ...original,
    physicalWireObservation: "before_each_wire",
    execute: async (input, context) => {
      const scoped = createSmtpRcptProbeTool({
        resolveMxHost: dependencies.resolveMxHost,
        executeSmtpProbe: async (...args) => {
          await context.beforePhysicalWire?.();
          return dependencies.executeSmtpProbe(...args);
        },
      });
      return scoped.execute(input, context);
    },
  };
}

/** Existing generic ledger identity, using the original SMTP tool's own key implementation. */
export function originalSmtpBudgetOperationKey(
  accountKey: string,
  input: SmtpProbeInput,
  expectedToolVersion: string,
): string {
  const original = createSmtpRcptProbeTool();
  if (original.version !== expectedToolVersion)
    throw new ExecutionControlError("BUDGET_OPERATION_REPLAY_UNAVAILABLE");
  return paidOperationKey([
    accountKey,
    "tool-budget",
    original.id,
    original.version,
    original.idempotencyKey(input),
  ]);
}
