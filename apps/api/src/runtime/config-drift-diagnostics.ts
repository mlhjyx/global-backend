import { Injectable, Logger, OnApplicationBootstrap, Optional } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import {
  resolveModelGatewayEndpoint,
  validateModelGatewayEndpoint,
} from "../adapters/model-gateway-endpoint";
import {
  isGateEnrichmentTaskWriteEnabled,
  GATE_ENRICHMENT_TASK_WRITE_ENV,
} from "../discovery/judgment/gates";
import {
  isControlledEnrichmentFinder,
  isControlledEnrichmentVerifier,
} from "../enrichment/safety/enrichment-safety-policy";
import { validateCustomerTemporalReadiness } from "../temporal/temporal-config";

/**
 * Four-way configuration drift startup diagnostics.
 *
 * Compares:
 *  1. `data_provider` table status (`ENABLED` / `DISABLED` / `MISSING`)
 *  2. Container environment variables (presence boolean ONLY — never secret values or lengths)
 *  3. Controlled enrichment safety lane allowlist (`enrichment-safety-policy.ts`)
 *  4. Runtime feature flags & infrastructure endpoints (`ICP_INPUT_GUARDRAILS`,
 *     `GATE_ENRICHMENT_TASK_WRITE_ENABLED`, `MODEL_GATEWAY_URL`, customer Temporal mode)
 *
 * Strictly read-only and non-blocking on startup.
 */
export type ProviderDiagnosticRole = "finder" | "verifier" | "search" | "registry";

export interface ProviderDiagnosticDescriptor {
  readonly key: string;
  readonly envVar: string;
  readonly role: ProviderDiagnosticRole;
}

export const MONITORED_DATA_PROVIDERS: readonly ProviderDiagnosticDescriptor[] =
  Object.freeze([
    // Enrichment finders & verifiers
    { key: "hunter", envVar: "HUNTER_API_KEY", role: "finder" },
    { key: "prospeo", envVar: "PROSPEO_API_KEY", role: "finder" },
    { key: "findymail", envVar: "FINDYMAIL_API_KEY", role: "finder" },
    { key: "pdl", envVar: "PDL_API_KEY", role: "finder" },
    { key: "apollo", envVar: "APOLLO_API_KEY", role: "finder" },
    { key: "millionverifier", envVar: "MILLIONVERIFIER_API_KEY", role: "verifier" },
    { key: "emailable", envVar: "EMAILABLE_API_KEY", role: "verifier" },
    { key: "zerobounce", envVar: "ZEROBOUNCE_API_KEY", role: "verifier" },
    { key: "truelist", envVar: "TRUELIST_API_KEY", role: "verifier" },
    // Search & registry providers
    { key: "serper", envVar: "SERPER_API_KEY", role: "search" },
    { key: "exa", envVar: "EXA_API_KEY", role: "search" },
    { key: "brave", envVar: "BRAVE_SEARCH_API_KEY", role: "search" },
    { key: "companies_house", envVar: "COMPANIES_HOUSE_API_KEY", role: "registry" },
    { key: "opencorporates", envVar: "OPENCORPORATES_API_TOKEN", role: "registry" },
  ]);

export type ConfigDriftSeverity = "warn" | "info";

export type ConfigDriftCode =
  | "DB_ENABLED_ENV_MISSING"
  | "ENV_PRESENT_DB_DISABLED"
  | "ENV_PRESENT_DB_MISSING"
  | "ENV_PRESENT_UNSUPPORTED_BY_SAFETY"
  | "DB_ENABLED_UNSUPPORTED_BY_SAFETY"
  | "ICP_INPUT_GUARDRAILS_DISABLED"
  | "ICP_INPUT_GUARDRAILS_INVALID"
  | "GATE_ENRICHMENT_TASK_WRITE_ENABLED_NO_CONSUMER"
  | "MODEL_GATEWAY_IP_LITERAL_DETECTED"
  | "MODEL_GATEWAY_ENDPOINT_INVALID"
  | "TEMPORAL_CUSTOMER_CONFIG_DRIFT";

export interface ConfigDriftFinding {
  readonly severity: ConfigDriftSeverity;
  readonly code: ConfigDriftCode;
  readonly subject: string;
  readonly message: string;
}

export interface ProviderDriftRow {
  readonly key: string;
  readonly envVar: string;
  readonly role: ProviderDiagnosticRole;
  readonly dbStatus: "ENABLED" | "DISABLED" | "MISSING";
  readonly envKeyPresent: boolean;
  readonly safetySupport: "controlled" | "unsupported" | "not_applicable";
}

export interface ConfigDriftDiagnosticReport {
  readonly generatedAt: string;
  readonly dbStatusLoaded: boolean;
  readonly providers: readonly ProviderDriftRow[];
  readonly flags: {
    readonly icpInputGuardrails: string;
    readonly gateEnrichmentTaskWriteEnabled: boolean;
    readonly modelGatewaySource: string;
    readonly customerTemporalMode: string;
    readonly customerTemporalNamespace: string;
  };
  readonly findings: readonly ConfigDriftFinding[];
}

export interface DataProviderStatusRow {
  readonly key: string;
  readonly status: string;
}

function safetySupportFor(
  descriptor: ProviderDiagnosticDescriptor,
): ProviderDriftRow["safetySupport"] {
  if (descriptor.role === "finder") {
    return isControlledEnrichmentFinder(descriptor.key)
      ? "controlled"
      : "unsupported";
  }
  if (descriptor.role === "verifier") {
    return isControlledEnrichmentVerifier(descriptor.key)
      ? "controlled"
      : "unsupported";
  }
  return "not_applicable";
}

function envPresent(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = env[key];
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeDbStatus(raw: string | undefined): ProviderDriftRow["dbStatus"] {
  if (raw === "ENABLED") return "ENABLED";
  if (raw === "DISABLED") return "DISABLED";
  return "MISSING";
}

/**
 * Pure four-way config drift analyzer. Never includes any secret values or lengths
 * in its output.
 */
export function inspectConfigurationDrift(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly dbProviders?: readonly DataProviderStatusRow[] | null;
  readonly now?: Date;
}): ConfigDriftDiagnosticReport {
  const { env } = input;
  const dbStatusLoaded = Array.isArray(input.dbProviders);
  const dbMap = new Map<string, string>();
  if (dbStatusLoaded) {
    for (const row of input.dbProviders) {
      dbMap.set(row.key.trim().toLowerCase(), row.status);
    }
  }

  const findings: ConfigDriftFinding[] = [];
  const providers: ProviderDriftRow[] = [];

  for (const descriptor of MONITORED_DATA_PROVIDERS) {
    const dbStatus = dbStatusLoaded
      ? normalizeDbStatus(dbMap.get(descriptor.key))
      : "MISSING";
    const keyPresent = envPresent(env, descriptor.envVar);
    const safetySupport = safetySupportFor(descriptor);

    providers.push(
      Object.freeze({
        key: descriptor.key,
        envVar: descriptor.envVar,
        role: descriptor.role,
        dbStatus,
        envKeyPresent: keyPresent,
        safetySupport,
      }),
    );

    if (dbStatusLoaded) {
      if (dbStatus === "ENABLED" && !keyPresent) {
        findings.push({
          severity: "warn",
          code: "DB_ENABLED_ENV_MISSING",
          subject: descriptor.key,
          message: `data_provider '${descriptor.key}' is ENABLED in DB but ${descriptor.envVar} is missing in runtime env`,
        });
      } else if (dbStatus === "DISABLED" && keyPresent) {
        findings.push({
          severity: "warn",
          code: "ENV_PRESENT_DB_DISABLED",
          subject: descriptor.key,
          message: `${descriptor.envVar} is present in runtime env but data_provider '${descriptor.key}' is DISABLED in DB`,
        });
      } else if (dbStatus === "MISSING" && keyPresent) {
        findings.push({
          severity: "info",
          code: "ENV_PRESENT_DB_MISSING",
          subject: descriptor.key,
          message: `${descriptor.envVar} is present in runtime env but no data_provider row exists for '${descriptor.key}'`,
        });
      }
    }

    if (safetySupport === "unsupported" && keyPresent) {
      findings.push({
        severity: "warn",
        code: "ENV_PRESENT_UNSUPPORTED_BY_SAFETY",
        subject: descriptor.key,
        message: `${descriptor.envVar} is set for unsupported enrichment provider '${descriptor.key}'; contact-enrichment safety preflight may reject with GOVERNANCE_PENDING`,
      });
    }
    if (dbStatusLoaded && safetySupport === "unsupported" && dbStatus === "ENABLED") {
      findings.push({
        severity: "warn",
        code: "DB_ENABLED_UNSUPPORTED_BY_SAFETY",
        subject: descriptor.key,
        message: `data_provider '${descriptor.key}' is ENABLED in DB but not supported by controlled contact-enrichment safety policy`,
      });
    }
  }

  // ICP_INPUT_GUARDRAILS drift check — strictly aligned with icp.service.ts:149
  // (`process.env.ICP_INPUT_GUARDRAILS === 'on'`). Unset or any value other than
  // exact `'on'` evaluates to OFF in runtime.
  const rawGuardrails = env.ICP_INPUT_GUARDRAILS;
  const trimmedGuardrails = rawGuardrails?.trim();
  const normalizedLower = trimmedGuardrails?.toLowerCase();
  const icpInputGuardrails = !trimmedGuardrails ? "unset(off)" : rawGuardrails!;
  if (!trimmedGuardrails) {
    findings.push({
      severity: "warn",
      code: "ICP_INPUT_GUARDRAILS_DISABLED",
      subject: "ICP_INPUT_GUARDRAILS",
      message:
        "ICP_INPUT_GUARDRAILS is unset (effective mode: off; icp.service requires exact 'on')",
    });
  } else if (
    normalizedLower === "off" ||
    normalizedLower === "false" ||
    normalizedLower === "0"
  ) {
    findings.push({
      severity: "warn",
      code: "ICP_INPUT_GUARDRAILS_DISABLED",
      subject: "ICP_INPUT_GUARDRAILS",
      message: `ICP_INPUT_GUARDRAILS is '${rawGuardrails}' (input quality guardrails are disabled)`,
    });
  } else if (rawGuardrails !== "on") {
    findings.push({
      severity: "warn",
      code: "ICP_INPUT_GUARDRAILS_INVALID",
      subject: "ICP_INPUT_GUARDRAILS",
      message: `ICP_INPUT_GUARDRAILS is '${rawGuardrails}', which evaluates to OFF because icp.service strictly checks === 'on'`,
    });
  }

  // Dead queue feature flag check
  const gateEnrichmentTaskWriteEnabled = isGateEnrichmentTaskWriteEnabled(env);
  if (gateEnrichmentTaskWriteEnabled) {
    findings.push({
      severity: "warn",
      code: "GATE_ENRICHMENT_TASK_WRITE_ENABLED_NO_CONSUMER",
      subject: GATE_ENRICHMENT_TASK_WRITE_ENV,
      message: `${GATE_ENRICHMENT_TASK_WRITE_ENV} is enabled while gate_enrichment_task currently has no active background consumer`,
    });
  }

  // Model gateway endpoint hardening check
  const gatewayEndpoint = resolveModelGatewayEndpoint(env);
  if (gatewayEndpoint.baseUrl) {
    const validated = validateModelGatewayEndpoint(gatewayEndpoint.baseUrl, {
      allowInternalServiceHttp: true,
      env,
    });
    if (validated.warnings.includes("MODEL_GATEWAY_IP_LITERAL_DETECTED")) {
      findings.push({
        severity: "warn",
        code: "MODEL_GATEWAY_IP_LITERAL_DETECTED",
        subject: "MODEL_GATEWAY_URL",
        message: "Model gateway URL uses a non-loopback IP literal instead of a DNS/Compose service name",
      });
    } else if (!validated.ok) {
      findings.push({
        severity: "warn",
        code: "MODEL_GATEWAY_ENDPOINT_INVALID",
        subject: "MODEL_GATEWAY_URL",
        message: `Model gateway endpoint failed validation (${validated.code})`,
      });
    }
  }

  // Customer Temporal dual-mode readiness check
  const temporal = validateCustomerTemporalReadiness(env);
  if (!temporal.ok) {
    findings.push({
      severity: "warn",
      code: "TEMPORAL_CUSTOMER_CONFIG_DRIFT",
      subject: "TEMPORAL_CUSTOMER_BACKEND_MODE",
      message: `Customer Temporal dual-mode config has issues: ${temporal.issues.join(",")}`,
    });
  }

  return Object.freeze({
    generatedAt: (input.now ?? new Date()).toISOString(),
    dbStatusLoaded,
    providers: Object.freeze(providers),
    flags: Object.freeze({
      icpInputGuardrails,
      gateEnrichmentTaskWriteEnabled,
      modelGatewaySource: gatewayEndpoint.source,
      customerTemporalMode: temporal.mode,
      customerTemporalNamespace: temporal.namespace,
    }),
    findings: Object.freeze(findings),
  });
}

@Injectable()
export class ConfigDriftDiagnosticsService implements OnApplicationBootstrap {
  private readonly logger = new Logger("ConfigDriftDiagnostics");
  private lastReport: ConfigDriftDiagnosticReport | null = null;

  constructor(@Optional() private readonly prisma?: PrismaService) {}

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === "test") return;
    void this.runDiagnostics(process.env);
  }

  getLastReport(): ConfigDriftDiagnosticReport | null {
    return this.lastReport;
  }

  async runDiagnostics(
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ConfigDriftDiagnosticReport> {
    let dbProviders: readonly DataProviderStatusRow[] | null = null;
    if (this.prisma?.dataProvider?.findMany) {
      try {
        dbProviders = await this.prisma.dataProvider.findMany({
          select: { key: true, status: true },
        });
      } catch (error) {
        this.logger.warn(
          `config drift check skipped data_provider DB read: ${String((error as Error)?.message ?? error).slice(0, 140)}`,
        );
      }
    }

    const report = inspectConfigurationDrift({ env, dbProviders });
    this.lastReport = report;

    const warnings = report.findings.filter((f) => f.severity === "warn");
    if (warnings.length > 0) {
      this.logger.warn(
        JSON.stringify({
          event: "config_drift_detected",
          dbStatusLoaded: report.dbStatusLoaded,
          warningCount: warnings.length,
          findings: warnings.map((f) => ({
            code: f.code,
            subject: f.subject,
            message: f.message,
          })),
        }),
      );
    }

    return report;
  }
}
