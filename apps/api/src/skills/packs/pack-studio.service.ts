import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { canonicalDigest } from "../../model-runtime/context-engine";
import { PrismaService } from "../../prisma/prisma.service";
import { validateEvalManifest, type EvalManifest } from "../evals/eval-manifest";
import { BUILTIN_PACKS } from "./generated/builtin-pack-catalog";
import { runPackEvals } from "./pack-evals";
import { buildStrategy } from "./pack-resolver";
import { PrismaPackRegistryStore, type PackVersionRow } from "./pack-registry.store";
import { diffBriefs, publishBlockers, validateDraft } from "./pack-studio.core";
import type { PackManifest } from "./pack-manifest";

type TransactionClient = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

interface PackageRow {
  readonly id: string;
  readonly packKey: string;
  readonly packType: string;
  readonly status: string;
  readonly activeVersionId: string | null;
}

interface DraftRow {
  readonly id: string;
  readonly draftNumber: number;
  readonly manifest: PackManifest;
  readonly content: string;
  readonly validation: Record<string, unknown> | null;
}

const RECEIPT_TTL_DAYS = 30;

@Injectable()
export class PackStudioService {
  private readonly store: PrismaPackRegistryStore;

  constructor(private readonly prisma: PrismaService) {
    this.store = new PrismaPackRegistryStore(prisma);
  }

  async listPacks(operatorWorkspaceId: string) {
    return this.prisma.withWorkspace(operatorWorkspaceId, (tx) =>
      tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT p."id"::text AS "id",
               p."pack_key" AS "packKey",
               p."pack_type" AS "packType",
               p."status",
               p."status_reason" AS "statusReason",
               v."version" AS "activeVersion",
               p."updated_at" AS "updatedAt"
        FROM "pack_package" p
        LEFT JOIN "pack_version" v ON v."id" = p."active_version_id"
        ORDER BY p."pack_key"
      `),
    );
  }

  async getPack(operatorWorkspaceId: string, packKey: string) {
    return this.prisma.withWorkspace(operatorWorkspaceId, async (tx: TransactionClient) => {
      const pkg = await this.loadPackage(tx, packKey);
      const versions = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT "id"::text AS "id", "version", "manifest_digest" AS "manifestDigest",
               "content_digest" AS "contentDigest", "published_by" AS "publishedBy", "created_at" AS "createdAt"
        FROM "pack_version" WHERE "package_id" = ${pkg.id}::uuid ORDER BY "created_at" DESC, "id" DESC
      `);
      const drafts = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT "id"::text AS "id", "draft_number" AS "draftNumber", "updated_by" AS "updatedBy",
               "updated_at" AS "updatedAt", "validation"
        FROM "pack_draft" WHERE "package_id" = ${pkg.id}::uuid ORDER BY "draft_number" DESC
      `);
      const activations = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT a."id"::text AS "id", a."scope", a."workspace_id"::text AS "workspaceId", a."canary",
               a."activated_by" AS "activatedBy", a."created_at" AS "createdAt", v."version"
        FROM "pack_activation" a JOIN "pack_version" v ON v."id" = a."version_id"
        WHERE a."package_id" = ${pkg.id}::uuid ORDER BY a."created_at" DESC LIMIT 50
      `);
      const receipts = await tx.$queryRaw<Record<string, unknown>[]>(Prisma.sql`
        SELECT "id"::text AS "id", "subject_version" AS "subjectVersion",
               "subject_digest" AS "subjectDigest", "eval_manifest_digest" AS "evalManifestDigest",
               "tier", "passed", "cases_total" AS "casesTotal", "cases_passed" AS "casesPassed",
               "run_by" AS "runBy", "created_at" AS "createdAt"
        FROM "eval_receipt"
        WHERE "subject_kind" = 'pack' AND "subject_key" = ${packKey}
        ORDER BY "created_at" DESC LIMIT 20
      `);
      return { ...pkg, versions, drafts, activations, receipts };
    });
  }

  async createDraft(
    operatorWorkspaceId: string,
    operatorUserId: string | undefined,
    packKey: string,
    fromVersion: string | undefined,
  ) {
    return this.prisma.withWorkspace(operatorWorkspaceId, async (tx: TransactionClient) => {
      const pkg = await this.loadPackage(tx, packKey);
      let manifest: unknown = { packKey, packType: pkg.packType, version: "1.0.0" };
      let content = "";
      if (fromVersion) {
        const versions = await tx.$queryRaw<{ manifest: unknown; content: string }[]>(Prisma.sql`
          SELECT "manifest", "content" FROM "pack_version"
          WHERE "package_id" = ${pkg.id}::uuid AND "version" = ${fromVersion} LIMIT 1
        `);
        if (!versions[0]) throw new NotFoundException(`version not found: ${packKey}@${fromVersion}`);
        manifest = versions[0].manifest;
        content = versions[0].content;
      }
      const numbers = await tx.$queryRaw<{ next: number }[]>(Prisma.sql`
        SELECT COALESCE(MAX("draft_number"), 0) + 1 AS "next" FROM "pack_draft" WHERE "package_id" = ${pkg.id}::uuid
      `);
      const draftId = randomUUID();
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "pack_draft" ("id", "package_id", "draft_number", "manifest", "content", "updated_by")
        VALUES (${draftId}::uuid, ${pkg.id}::uuid, ${numbers[0].next},
                ${JSON.stringify(manifest)}::jsonb, ${content}, ${operatorUserId ?? null})
      `);
      return { draftId, draftNumber: numbers[0].next };
    });
  }

  async updateDraft(
    operatorWorkspaceId: string,
    operatorUserId: string | undefined,
    packKey: string,
    draftId: string,
    update: { manifest?: unknown; content?: string },
  ) {
    if (update.manifest === undefined && update.content === undefined) {
      throw new NotFoundException("nothing to update");
    }
    return this.prisma.withWorkspace(operatorWorkspaceId, async (tx: TransactionClient) => {
      const pkg = await this.loadPackage(tx, packKey);
      const updated = await tx.$executeRaw(Prisma.sql`
        UPDATE "pack_draft"
        SET "manifest" = COALESCE(${update.manifest === undefined ? null : JSON.stringify(update.manifest)}::jsonb, "manifest"),
            "content" = COALESCE(${update.content ?? null}, "content"),
            "updated_by" = ${operatorUserId ?? null},
            "updated_at" = now()
        WHERE "id" = ${draftId}::uuid AND "package_id" = ${pkg.id}::uuid
      `);
      if (updated === 0) throw new NotFoundException(`draft not found: ${draftId}`);
      return { packKey, draftId, updated: true };
    });
  }

  async validateDraft(operatorWorkspaceId: string, packKey: string, draftId: string) {
    return this.prisma.withWorkspace(operatorWorkspaceId, async (tx: TransactionClient) => {
      const { pkg, draft } = await this.loadDraft(tx, packKey, draftId);
      const report = validateDraft(pkg.packKey, draft.manifest);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "pack_draft" SET "validation" = ${JSON.stringify(report)}::jsonb, "updated_at" = now()
        WHERE "id" = ${draftId}::uuid AND "package_id" = ${pkg.id}::uuid
      `);
      return report;
    });
  }

  async dryRunDraft(
    operatorWorkspaceId: string,
    packKey: string,
    draftId: string,
    body: {
      skillKey?: string;
      industries?: readonly string[];
      markets?: readonly string[];
      motions?: readonly string[];
    },
  ) {
    const draftData = await this.prisma.withWorkspace(operatorWorkspaceId, (tx: TransactionClient) =>
      this.loadDraft(tx, packKey, draftId),
    );
    const report = validateDraft(draftData.pkg.packKey, draftData.draft.manifest);
    const contentDigest = createHash("sha256").update(draftData.draft.content, "utf8").digest("hex");
    const draftVersion: PackVersionRow = {
      id: `draft:${draftId}`,
      packageId: draftData.pkg.id,
      version: String((draftData.draft.manifest as { version?: unknown }).version ?? "draft"),
      manifest: draftData.draft.manifest,
      content: draftData.draft.content,
      manifestDigest: canonicalDigest(draftData.draft.manifest),
      contentDigest,
    };

    const packages = await this.store.listActivePackages(operatorWorkspaceId);
    const versions: PackVersionRow[] = [];
    let before: PackVersionRow | null = null;
    for (const entry of packages) {
      const enabled = await this.store.loadEnablement(operatorWorkspaceId, entry.id);
      if (enabled === false) continue;
      const version = await this.store.loadEffectiveVersion(operatorWorkspaceId, entry.id);
      if (!version) continue;
      if (entry.id === draftData.pkg.id) {
        before = version;
        continue; // 以草稿替换当前版本参与解析
      }
      versions.push(version);
    }
    versions.push(draftVersion);

    const selectors = {
      ...(body.industries ? { industries: body.industries } : {}),
      ...(body.markets ? { markets: body.markets } : {}),
      ...(body.motions ? { motions: body.motions } : {}),
    };
    const skillKey = body.skillKey ?? `pack-studio:${packKey}`;
    const after = buildStrategy({ skillKey, ...selectors }, versions);
    const beforeResolved = before
      ? buildStrategy({ skillKey, ...selectors }, [...versions.filter((v) => v !== draftVersion), before])
      : null;
    return {
      issues: report.issues,
      selectedPacks: after.descriptor.packs.map((pack) => pack.packKey),
      brief: after.brief,
      diff: diffBriefs(beforeResolved?.brief ?? "", after.brief),
    };
  }

  async evalDraft(
    operatorWorkspaceId: string,
    operatorUserId: string | undefined,
    packKey: string,
    draftId: string,
    evals: unknown,
  ) {
    const { pkg, draft } = await this.prisma.withWorkspace(operatorWorkspaceId, (tx: TransactionClient) =>
      this.loadDraft(tx, packKey, draftId),
    );
    const manifestDigest = canonicalDigest(draft.manifest);
    const validatedDigest = (draft.validation ?? {})["manifestDigest"];
    if (validatedDigest !== manifestDigest) {
      throw new NotFoundException("draft has changed since its last successful validation");
    }
    const evalManifest = this.resolveEvalManifest(pkg.packKey, evals);
    const evalManifestDigest = canonicalDigest(evalManifest);
    const contentDigest = createHash("sha256").update(draft.content, "utf8").digest("hex");
    const result = await runPackEvals(evalManifest, {
      packKey: pkg.packKey,
      version: String((draft.manifest as { version?: unknown }).version ?? "draft"),
      manifest: draft.manifest,
      content: draft.content,
      contentDigest,
    });
    const casesPassed = result.cases.filter((entry) => entry.ok).length;
    const receiptId = randomUUID();
    return this.prisma.withWorkspace(operatorWorkspaceId, async (tx: TransactionClient) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "eval_receipt"
          ("id", "subject_kind", "subject_key", "subject_version", "subject_digest",
           "eval_manifest_digest", "tier", "passed", "cases_total", "cases_passed", "run_by")
        VALUES
          (${receiptId}::uuid, 'pack', ${pkg.packKey},
           ${String((draft.manifest as { version?: unknown }).version ?? "draft")},
           ${manifestDigest}, ${evalManifestDigest}, 'deterministic', ${result.passed},
           ${result.cases.length}, ${casesPassed}, ${operatorUserId ?? null})
      `);
      await tx.$executeRaw(Prisma.sql`
        UPDATE "pack_draft"
        SET "validation" = COALESCE("validation", '{}'::jsonb) || ${JSON.stringify({
          evalManifestDigest,
          evalPassed: result.passed,
        })}::jsonb,
            "updated_at" = now()
        WHERE "id" = ${draftId}::uuid AND "package_id" = ${pkg.id}::uuid
      `);
      return {
        passed: result.passed,
        casesTotal: result.cases.length,
        casesPassed,
        evalManifestDigest,
        receiptId,
        cases: result.cases,
      };
    });
  }

  async publishDraft(
    operatorWorkspaceId: string,
    operatorUserId: string | undefined,
    packKey: string,
    draftId: string,
  ) {
    const { pkg, draft } = await this.prisma.withWorkspace(operatorWorkspaceId, (tx: TransactionClient) =>
      this.loadDraft(tx, packKey, draftId),
    );
    const manifest = draft.manifest;
    const report = validateDraft(pkg.packKey, manifest);
    if (report.issues.some((issue) => issue.severity === "error")) {
      throw new NotFoundException("draft manifest no longer validates; run validate first");
    }
    const manifestDigest = report.manifestDigest;
    const validation = draft.validation ?? {};
    if (validation["manifestDigest"] !== manifestDigest) {
      throw new NotFoundException("draft is not validated for its current manifest");
    }
    const receipts = await this.prisma.withWorkspace(operatorWorkspaceId, (tx: TransactionClient) =>
      tx.$queryRaw<{ subjectDigest: string; evalManifestDigest: string; tier: string; passed: boolean; createdAt: Date }[]>(Prisma.sql`
        SELECT "subject_digest" AS "subjectDigest", "eval_manifest_digest" AS "evalManifestDigest",
               "tier", "passed", "created_at" AS "createdAt"
        FROM "eval_receipt"
        WHERE "subject_kind" = 'pack' AND "subject_key" = ${pkg.packKey}
        ORDER BY "created_at" DESC LIMIT 20
      `),
    );
    const blockers = publishBlockers({
      manifestDigest,
      evalManifestDigest: (validation["evalManifestDigest"] as string | undefined) ?? null,
      receipts: receipts.map((receipt) => ({
        subjectDigest: receipt.subjectDigest,
        evalManifestDigest: receipt.evalManifestDigest,
        tier: receipt.tier as "deterministic" | "model",
        passed: receipt.passed,
        createdAt: receipt.createdAt,
      })),
      maxAgeDays: RECEIPT_TTL_DAYS,
    });
    if (blockers.length > 0) {
      throw new NotFoundException(`publish blocked: ${blockers.join(", ")}`);
    }
    const version = String((manifest as { version?: unknown }).version ?? "");
    const contentDigest = createHash("sha256").update(draft.content, "utf8").digest("hex");
    return this.prisma.withWorkspace(operatorWorkspaceId, async (tx: TransactionClient) => {
      const versionId = randomUUID();
      try {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "pack_version"
            ("id", "package_id", "version", "manifest", "content", "manifest_digest", "content_digest", "published_by")
          VALUES
            (${versionId}::uuid, ${pkg.id}::uuid, ${version}, ${JSON.stringify(manifest)}::jsonb,
             ${draft.content}, ${manifestDigest}, ${contentDigest}, ${operatorUserId ?? null})
        `);
      } catch (error) {
        const message = String((error as Error)?.message ?? "");
        if (/unique|duplicate key/u.test(message)) {
          throw new NotFoundException(`version already exists: ${pkg.packKey}@${version}`);
        }
        throw error;
      }
      return { packKey: pkg.packKey, version, versionId, manifestDigest };
    });
  }

  async activateVersion(
    operatorWorkspaceId: string,
    operatorUserId: string | undefined,
    packKey: string,
    body: { version: string; scope: "platform" | "workspace"; workspaceId?: string; canary?: boolean },
  ) {
    return this.prisma.withWorkspace(operatorWorkspaceId, async (tx: TransactionClient) => {
      const pkg = await this.loadPackage(tx, packKey);
      const versions = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT "id"::text AS "id" FROM "pack_version"
        WHERE "package_id" = ${pkg.id}::uuid AND "version" = ${body.version} LIMIT 1
      `);
      const versionRow = versions[0];
      if (!versionRow) throw new NotFoundException(`version not found: ${packKey}@${body.version}`);
      if (body.scope === "workspace" && !body.workspaceId) {
        throw new NotFoundException("workspace activations require workspaceId");
      }
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "pack_activation"
          ("id", "package_id", "version_id", "scope", "workspace_id", "canary", "activated_by")
        VALUES
          (${randomUUID()}::uuid, ${pkg.id}::uuid, ${versionRow.id}::uuid, ${body.scope},
           ${body.scope === "workspace" ? body.workspaceId ?? null : null}::uuid,
           ${body.canary === true}, ${operatorUserId ?? null})
      `);
      if (body.scope === "platform") {
        await tx.$executeRaw(Prisma.sql`
          UPDATE "pack_package" SET "active_version_id" = ${versionRow.id}::uuid, "updated_at" = now()
          WHERE "id" = ${pkg.id}::uuid
        `);
      }
      return { packKey, version: body.version, scope: body.scope, canary: body.canary === true };
    });
  }

  async getWorkspaceEnablement(targetWorkspaceId: string, packKey: string) {
    return this.prisma.withWorkspace(targetWorkspaceId, async (tx: TransactionClient) => {
      const pkg = await this.loadPackage(tx, packKey);
      const rows = await tx.$queryRaw<{ enabled: boolean; reason: string | null; updatedAt: Date }[]>(Prisma.sql`
        SELECT "enabled", "reason", "updated_at" AS "updatedAt" FROM "pack_enablement"
        WHERE "workspace_id" = ${targetWorkspaceId}::uuid AND "package_id" = ${pkg.id}::uuid LIMIT 1
      `);
      const override = rows[0] ?? null;
      return {
        packKey,
        workspaceId: targetWorkspaceId,
        platformStatus: pkg.status,
        override,
        enabled: pkg.status === "ACTIVE" && (override?.enabled ?? true),
      };
    });
  }

  async setWorkspaceEnablement(
    targetWorkspaceId: string,
    operatorUserId: string | undefined,
    packKey: string,
    enabled: boolean,
    reason: string | undefined,
  ) {
    return this.prisma.withWorkspace(targetWorkspaceId, async (tx: TransactionClient) => {
      const pkg = await this.loadPackage(tx, packKey);
      const rows = await tx.$queryRaw<{ enabled: boolean; reason: string | null; updatedAt: Date }[]>(Prisma.sql`
        INSERT INTO "pack_enablement" ("id", "workspace_id", "package_id", "enabled", "reason", "updated_by")
        VALUES (gen_random_uuid(), ${targetWorkspaceId}::uuid, ${pkg.id}::uuid, ${enabled},
                ${reason ?? null}, ${operatorUserId ?? null})
        ON CONFLICT ("workspace_id", "package_id") DO UPDATE
          SET "enabled" = EXCLUDED."enabled", "reason" = EXCLUDED."reason",
              "updated_by" = EXCLUDED."updated_by", "updated_at" = now()
        RETURNING "enabled", "reason", "updated_at" AS "updatedAt"
      `);
      return { packKey, workspaceId: targetWorkspaceId, ...rows[0] };
    });
  }

  async clearWorkspaceEnablement(targetWorkspaceId: string, packKey: string) {
    return this.prisma.withWorkspace(targetWorkspaceId, async (tx: TransactionClient) => {
      const pkg = await this.loadPackage(tx, packKey);
      const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
        DELETE FROM "pack_enablement"
        WHERE "workspace_id" = ${targetWorkspaceId}::uuid AND "package_id" = ${pkg.id}::uuid
        RETURNING "id"::text AS "id"
      `);
      return { packKey, workspaceId: targetWorkspaceId, removed: rows.length > 0 };
    });
  }

  private resolveEvalManifest(packKey: string, supplied: unknown): EvalManifest {
    if (supplied !== undefined) {
      const issues = validateEvalManifest(supplied);
      if (issues.some((issue) => issue.severity === "error")) {
        throw new NotFoundException(`eval manifest invalid: ${issues.map((issue) => issue.code).join(", ")}`);
      }
      return supplied as EvalManifest;
    }
    const builtin = BUILTIN_PACKS.find((record) => record.packKey === packKey);
    if (!builtin?.evals) {
      throw new NotFoundException("eval manifest required: this pack has no built-in evals");
    }
    return builtin.evals;
  }

  private async loadPackage(tx: TransactionClient, packKey: string): Promise<PackageRow> {
    const rows = await tx.$queryRaw<PackageRow[]>(Prisma.sql`
      SELECT "id"::text AS "id", "pack_key" AS "packKey", "pack_type" AS "packType",
             "status", "active_version_id"::text AS "activeVersionId"
      FROM "pack_package" WHERE "pack_key" = ${packKey} LIMIT 1
    `);
    const pkg = rows[0];
    if (!pkg) throw new NotFoundException(`pack not registered: ${packKey}`);
    return pkg;
  }

  private async loadDraft(
    tx: TransactionClient,
    packKey: string,
    draftId: string,
  ): Promise<{ pkg: PackageRow; draft: DraftRow }> {
    const pkg = await this.loadPackage(tx, packKey);
    const rows = await tx.$queryRaw<DraftRow[]>(Prisma.sql`
      SELECT "id"::text AS "id", "draft_number" AS "draftNumber", "manifest", "content", "validation"
      FROM "pack_draft" WHERE "id" = ${draftId}::uuid AND "package_id" = ${pkg.id}::uuid LIMIT 1
    `);
    const draft = rows[0];
    if (!draft) throw new NotFoundException(`draft not found: ${draftId}`);
    return { pkg, draft };
  }
}
