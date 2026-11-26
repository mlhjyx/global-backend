import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { NestFactory } from "@nestjs/core";
import { describe, expect, it, vi } from "vitest";
import { isSiteBuilderEnabled } from "./site-builder-feature-flag";
import { SiteBuilderFeatureModule } from "./site-builder-feature.module";
import { settlementReadbackConfigured } from "./settlement-readback-config";
import {
  checkBrowserReadiness,
  ManagedDependencyReadinessContributors,
} from "./managed-dependency-readiness";
import { RuntimeReadinessContributorRegistry } from "./runtime-readiness-registry";
import { customerWriteAdmission } from "./customer-write-admission";
import { RuntimeReadinessService } from "../health/runtime-readiness.service";
import { createWorkspacePurgeActivities } from "../temporal/workspace-purge.activities";
import { DoclingClient as NeutralDoclingClient } from "../infra-clients/docling.client";
import { DoclingClient as ShimDoclingClient } from "../site-builder/docling.client";
import { EmbeddingsClient as NeutralEmbeddingsClient } from "../infra-clients/embeddings.client";
import { EmbeddingsClient as ShimEmbeddingsClient } from "../site-builder/embeddings.client";
import { StorageService as NeutralStorageService } from "../infra-clients/storage.service";
import { StorageService as ShimStorageService } from "../site-builder/storage.service";
import { sniffMime as neutralSniffMime } from "../infra-clients/object-key";
import { sniffMime as shimSniffMime } from "../site-builder/object-key";
import { chunkMarkdown as neutralChunkMarkdown } from "../common/chunker";
import { chunkMarkdown as shimChunkMarkdown } from "../site-builder/chunker";
import { scrubPii as neutralScrubPii } from "../common/pii-scrub";
import { scrubPii as shimScrubPii } from "../site-builder/agents/pii";
import { sanitizeEvidenceUrl as neutralSanitizeEvidenceUrl } from "../common/evidence-ref";
import { sanitizeEvidenceUrl as shimSanitizeEvidenceUrl } from "../site-builder/agents/evidence-ref";
import {
  paidOperationKey as neutralPaidOperationKey,
  PaidCallDeniedError as NeutralPaidCallDeniedError,
  PaidOperationUnknownError as NeutralPaidOperationUnknownError,
} from "../common/paid-cost-ledger-contract";
import {
  paidOperationKey as shimPaidOperationKey,
  PaidCallDeniedError as ShimPaidCallDeniedError,
  PaidOperationUnknownError as ShimPaidOperationUnknownError,
} from "../site-builder/site-build-cost-ledger";

const API_SRC_ROOT = resolve(import.meta.dirname, "..");

function walkProductionTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...walkProductionTs(full));
    } else if (
      entry.endsWith(".ts") &&
      !entry.endsWith(".spec.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".d.ts")
    ) {
      out.push(full);
    }
  }
  return out.sort();
}

function runtimeImportsSiteBuilder(source: string): boolean {
  const stmtRe =
    /(?:^|\n)\s*(?:import|export)\s+([^;]*?)\bfrom\s+['"](\.[^'"]*\/site-builder\/[^'"]*)['"]/gu;
  for (const match of source.matchAll(stmtRe)) {
    const clause = match[1].trim();
    if (clause === "type" || clause.startsWith("type ")) continue;
    return true;
  }
  if (/import\s*\(\s*['"][^'"]*\/site-builder\/[^'"]*['"]\s*\)/u.test(source)) {
    return true;
  }
  return false;
}

describe("Wave 4 S3: site-builder decoupling, neutral utilities, and SITE_BUILDER_ENABLED switch", () => {
  it("defaults SITE_BUILDER_ENABLED to true, supports disabling, and fails closed on invalid values", () => {
    expect(isSiteBuilderEnabled({})).toBe(true);
    expect(isSiteBuilderEnabled({ SITE_BUILDER_ENABLED: "" })).toBe(true);
    for (const truthy of ["true", "TRUE", "1", "on", "yes"]) {
      expect(isSiteBuilderEnabled({ SITE_BUILDER_ENABLED: truthy })).toBe(true);
    }
    for (const falsy of ["false", "FALSE", "0", "off", "no"]) {
      expect(isSiteBuilderEnabled({ SITE_BUILDER_ENABLED: falsy })).toBe(false);
    }
    expect(() =>
      isSiteBuilderEnabled({ SITE_BUILDER_ENABLED: "flase" }),
    ).toThrow(/SITE_BUILDER_ENABLED_INVALID/);
  });

  it("short-circuits settlement readback, browser readiness, and keeps all 5 SiteBuilder readiness contributors ok (unblocking customerWriteAdmission) when SITE_BUILDER_ENABLED=false", async () => {
    const disabledEnv: NodeJS.ProcessEnv = {
      SITE_BUILDER_ENABLED: "false",
      MODEL_GATEWAY_SETTLEMENT_READBACK_CREDENTIAL:
        "srb1.abcdefghijklmnop.1234567890123456789012345678901234567890123",
      CHROME_PATH: "/var/run/nonexistent-browser",
    };

    expect(settlementReadbackConfigured(disabledEnv)).toBe(false);
    const probe = vi.fn();
    await expect(checkBrowserReadiness(disabledEnv, probe as never)).resolves.toEqual({
      status: "ok",
    });
    expect(probe).not.toHaveBeenCalled();

    const prev = process.env.SITE_BUILDER_ENABLED;
    try {
      process.env.SITE_BUILDER_ENABLED = "false";
      const registry = new RuntimeReadinessContributorRegistry();
      const contributors = new ManagedDependencyReadinessContributors(
        registry,
        { current: () => ({ attested: false }) } as never,
      );
      contributors.onModuleInit();

      // All 5 SiteBuilder-owned contributors must return { status: "ok" } directly
      // with zero external probes so /health/ready and RuntimeWorkAdmissionGuard stay open.
      for (const name of [
        "storage",
        "budget_grant_verification",
        "site_builder_model_settlement_readback",
        "browser",
        "renderer",
      ]) {
        await expect(registry.check(name), name).resolves.toEqual({
          status: "ok",
        });
      }

      // Keep the 5 real disabled-ok SiteBuilder contributors from ManagedDependencyReadinessContributors,
      // and return ok for the non-SiteBuilder contributors (redis/auth_jwks/model_gateway/etc.)
      // so RuntimeReadinessService + customerWriteAdmission test the exact live integration.
      const sbKeys = new Set([
        "storage",
        "budget_grant_verification",
        "site_builder_model_settlement_readback",
        "browser",
        "renderer",
      ]);
      const realCheck = registry.check.bind(registry);
      vi.spyOn(registry, "check").mockImplementation(async (name) =>
        sbKeys.has(name) ? realCheck(name) : { status: "ok" },
      );

      const readiness = new RuntimeReadinessService(
        {
          reconnect: async () => ({ status: "ready" }),
          $transaction: async <T>(
            fn: (tx: {
              $executeRawUnsafe: () => Promise<number>;
              $queryRawUnsafe: () => Promise<Array<{ migration_name: string }>>;
            }) => Promise<T>,
          ) =>
            fn({
              $executeRawUnsafe: async () => 0,
              $queryRawUnsafe: async () => [
                { migration_name: "20261126150000_platform_schedule_config" },
              ],
            }),
        } as never,
        { probe: async () => ({ connected: true }) } as never,
        { current: () => ({ admitted: true }) } as never,
        {
          current: () => ({
            attested: true,
            migration_revision: "20261126150000_platform_schedule_config",
          }),
        } as never,
        {
          inspectWorkerQueue: async () => ({ status: "ok" }),
          inspectRole: async () => ({ status: "ok" }),
        } as never,
        registry,
      );
      const report = await readiness.check();
      expect(report.status).toBe("ready");
      expect(report.components.storage).toEqual({ status: "ok" });
      expect(report.components.renderer).toEqual({ status: "ok" });
      expect(report.components.browser).toEqual({ status: "ok" });
      expect(report.components.budget_grant_verification).toEqual({ status: "ok" });
      expect(report.capabilities.site_builder_model_settlement_readback).toEqual({
        status: "ok",
      });
      const writeGate = customerWriteAdmission(report);
      expect(writeGate.open).toBe(true);
      expect(writeGate.blocking).toEqual([]);
      contributors.onModuleDestroy();

      // When enabled, ManagedDependencyReadinessContributors does NOT register storage
      // or budget_grant_verification (owned by SiteBuilderModule to avoid duplicate registration).
      process.env.SITE_BUILDER_ENABLED = "true";
      const enabledNames: string[] = [];
      const enabledRegistry = new RuntimeReadinessContributorRegistry();
      vi.spyOn(enabledRegistry, "register").mockImplementation((name, check) => {
        enabledNames.push(name);
        return RuntimeReadinessContributorRegistry.prototype.register.call(
          enabledRegistry,
          name,
          check,
        );
      });
      const enabledContributors = new ManagedDependencyReadinessContributors(
        enabledRegistry,
        { current: () => ({ attested: false }) } as never,
      );
      enabledContributors.onModuleInit();
      expect(enabledNames).toContain("browser");
      expect(enabledNames).toContain("renderer");
      expect(enabledNames).toContain("site_builder_model_settlement_readback");
      expect(enabledNames).not.toContain("storage");
      expect(enabledNames).not.toContain("budget_grant_verification");
      enabledContributors.onModuleDestroy();
    } finally {
      if (prev === undefined) delete process.env.SITE_BUILDER_ENABLED;
      else process.env.SITE_BUILDER_ENABLED = prev;
    }
  });

  it(
    "mounts zero SiteBuilder modules when SITE_BUILDER_ENABLED=false and lazily loads SiteBuilderModule when true",
    async () => {
      const disabledDynamic = await SiteBuilderFeatureModule.register({
        SITE_BUILDER_ENABLED: "false",
      });
      expect(disabledDynamic.imports).toEqual([]);

      const appCtx = await NestFactory.createApplicationContext(disabledDynamic, {
        logger: false,
      });
      await appCtx.close();

      const enabledDynamic = await SiteBuilderFeatureModule.register({
        SITE_BUILDER_ENABLED: "true",
      });
      expect(enabledDynamic.imports).toHaveLength(1);
      expect((enabledDynamic.imports?.[0] as { name?: string })?.name).toBe(
        "SiteBuilderModule",
      );
    },
    60_000,
  );

  it("keeps acquisition modules, infra-clients, common, app.module, and workspace-purge free of runtime site-builder imports", () => {
    const forbiddenDirs = [
      "infra-clients",
      "common",
      "seller-knowledge",
      "discovery",
      "durable-results",
      "enrichment",
      "platform-authority",
      "tools",
    ];
    for (const dir of forbiddenDirs) {
      const files = walkProductionTs(join(API_SRC_ROOT, dir));
      expect(files.length, `expected files in ${dir}`).toBeGreaterThan(0);
      for (const file of files) {
        const source = readFileSync(file, "utf8");
        expect(
          runtimeImportsSiteBuilder(source),
          `${relative(API_SRC_ROOT, file)} must not have runtime import from site-builder/`,
        ).toBe(false);
      }
    }

    const appModuleSource = readFileSync(join(API_SRC_ROOT, "app.module.ts"), "utf8");
    expect(runtimeImportsSiteBuilder(appModuleSource)).toBe(false);
    expect(appModuleSource).toContain("SiteBuilderFeatureModule.register()");

    const workspacePurgeSource = readFileSync(
      join(API_SRC_ROOT, "temporal/workspace-purge.activities.ts"),
      "utf8",
    );
    expect(runtimeImportsSiteBuilder(workspacePurgeSource)).toBe(false);

    const workerSource = readFileSync(
      join(API_SRC_ROOT, "temporal/worker.ts"),
      "utf8",
    );
    for (const heavyImport of [
      "./site-builder.activities",
      "../site-builder/image-pipeline.service",
      "../site-builder/image-pipeline-runner",
      "../site-builder/site-release.service",
      "../site-builder/kb.service",
      "../site-builder/quality/",
    ]) {
      expect(workerSource, heavyImport).not.toContain(heavyImport);
    }
    expect(workerSource).toContain("isSiteBuilderEnabled(process.env)");
    expect(workerSource).toContain("loadSiteBuilderWorkerActivities");
    expect(workerSource).toContain("admitSiteBuilderWorkerDependencies(");
    expect(workerSource).toContain("siteBuilderDependencyChecks(");
  });

  it("allows workspace purge storage cleanup to succeed when siteBuilderStorage is omitted under SITE_BUILDER_ENABLED=false", async () => {
    const sellerDel = vi.fn(async () => 2);
    const eraseFinalObject = vi.fn(async () => "DELETED" as const);
    const acts = createWorkspacePurgeActivities({
      prisma: {} as never,
      siteBuilderStorage: undefined,
      personalArtifactCleanupPort: { eraseFinalObject },
      sellerDocumentsStorage: { bucket: "seller-docs", deletePrefix: sellerDel },
      dataExportStorage: { bucket: "seller-docs", delete: vi.fn(async () => undefined) },
    });
    const counts = await acts.purgeWorkspaceStorage({
      workspaceId: "ws-1",
      siteIds: ["site-1"],
      legacyReleasePrefixes: ["releases/site-1/"],
      personalObjects: [],
    });
    expect(counts).toEqual({
      sellerDocuments: 2,
      siteBuilder: 0,
      operationArtifacts: 0,
    });
    expect(sellerDel).toHaveBeenCalledWith("ws/ws-1/");
  });

  it("preserves exact symbol identity through site-builder re-export shims", () => {
    expect(ShimDoclingClient).toBe(NeutralDoclingClient);
    expect(ShimEmbeddingsClient).toBe(NeutralEmbeddingsClient);
    expect(ShimStorageService).toBe(NeutralStorageService);
    expect(shimSniffMime).toBe(neutralSniffMime);
    expect(shimChunkMarkdown).toBe(neutralChunkMarkdown);
    expect(shimScrubPii).toBe(neutralScrubPii);
    expect(shimSanitizeEvidenceUrl).toBe(neutralSanitizeEvidenceUrl);
    expect(shimPaidOperationKey).toBe(neutralPaidOperationKey);
    expect(ShimPaidCallDeniedError).toBe(NeutralPaidCallDeniedError);
    expect(ShimPaidOperationUnknownError).toBe(NeutralPaidOperationUnknownError);
  });
});
