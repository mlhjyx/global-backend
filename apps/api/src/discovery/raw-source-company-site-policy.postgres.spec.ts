import { randomBytes, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mapPublicWebCompanyToRecord } from "./providers/public-web.provider";
import {
  prepareRawSourceBatch,
  type PreparedRawSourceRow,
  type RawSourcePolicySnapshot,
} from "./raw-source-ingestion";
import { persistPreparedRawSourceRecord } from "./raw-source-writer";
import { PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN } from "./source-policy-scope";

/*
 * Raw ingestion (TypeScript) and the database writer must reach the same source_policy binding:
 * when they disagree the writer raises and the whole discovery query rolls back. Each case below
 * prepares a record in TypeScript against the policies app_user reads, persists it through the
 * real writer as app_user and compares the stored row; the DB-only cases forge bindings
 * TypeScript never produces. Every Raw write is rolled back.
 *
 * Explicitly opted-in, disposable and migrated PostgreSQL only: RAW_SOURCE_POLICY_DATABASE_TEST=1
 * with an owner URL (fixtures) and an app_user URL (the only principal the writer admits), both
 * on a loopback host and a test database name.
 */
const enabled = process.env.RAW_SOURCE_POLICY_DATABASE_TEST === "1";
const ownerUrl = process.env.RAW_SOURCE_POLICY_TEST_DATABASE_URL;
const appUrl = process.env.RAW_SOURCE_POLICY_TEST_APP_DATABASE_URL;
if (enabled && (!ownerUrl || !appUrl)) {
  throw new Error(
    "RAW_SOURCE_POLICY_DATABASE_TEST=1 needs RAW_SOURCE_POLICY_TEST_DATABASE_URL and RAW_SOURCE_POLICY_TEST_APP_DATABASE_URL",
  );
}
for (const value of [ownerUrl, appUrl]) {
  if (!value) continue;
  const url = new URL(value);
  if (
    url.protocol !== "postgresql:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !["/global_test", "/raw_source_policy_test"].includes(url.pathname)
  ) {
    throw new Error("raw source policy test requires a loopback test database");
  }
}

interface PolicyRow {
  id: string;
  domain: string;
  reviewStatus?: "APPROVED" | "SUSPENDED";
  allowedPurpose?: unknown;
  retentionDays?: number;
}

interface StoredRaw {
  ingestStatus: string;
  dispositionCode: string | null;
  retentionDays: number;
  snapshot: Record<string, unknown>;
}

const ROLLBACK = new Error("raw source policy test rollback");
const BINDING_INVALID = /RAW_SOURCE_WRITER_POLICY_BINDING_INVALID/u;

describe.runIf(enabled)("Raw source policy binding on PostgreSQL", { timeout: 60_000 }, () => {
  // Created only when the suite runs: collecting a skipped suite still executes this body.
  let owner: PrismaClient;
  let app: PrismaClient;
  const workspaceId = randomUUID();
  const runId = randomUUID();
  const suffix = randomBytes(5).toString("hex");
  const site = `pumpen-${suffix}.de`;
  const restoredProviders: Array<{ key: string; status: string | null }> = [];

  const policyId = (ordinal: number) =>
    `${suffix.slice(0, 8)}-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
  const COMPANY_SITE_ID = policyId(1);

  beforeAll(async () => {
    owner = new PrismaClient({ datasourceUrl: ownerUrl });
    app = new PrismaClient({ datasourceUrl: appUrl });
    const existing = await owner.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM source_policy
      WHERE domain = ${PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN}`;
    if (existing[0]!.count !== 0n) {
      throw new Error(
        "the test database already has a company-site source_policy row; use a fresh disposable database",
      );
    }
    for (const [key, sourceClass] of [
      ["public_web", "public_intelligence"],
      ["registry", "company_registry"],
    ] as const) {
      const prior = await owner.$queryRaw<{ status: string }[]>`
        SELECT status FROM data_provider WHERE key = ${key}`;
      restoredProviders.push({ key, status: prior[0]?.status ?? null });
      await owner.$executeRaw`
        INSERT INTO data_provider(id, key, class, status, cost_per_call_cents, created_at)
        VALUES (gen_random_uuid(), ${key}, ${sourceClass}, 'ENABLED', 0, now())
        ON CONFLICT (key) DO UPDATE SET status = 'ENABLED'`;
    }
    await owner.$executeRaw`
      INSERT INTO discovery_run(id, workspace_id, plan_id, icp_id, status, materialization_contract_version)
      VALUES (${runId}::uuid, ${workspaceId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid,
        'RUNNING', 'discovery-company-materialization/v1')`;
  });

  afterAll(async () => {
    if (!owner) return;
    try {
      await owner.$executeRaw`DELETE FROM discovery_run WHERE id = ${runId}::uuid`;
      for (const { key, status } of restoredProviders) {
        if (status === null) {
          await owner.$executeRaw`DELETE FROM data_provider WHERE key = ${key}`;
        } else {
          await owner.$executeRaw`UPDATE data_provider SET status = ${status} WHERE key = ${key}`;
        }
      }
    } finally {
      await Promise.all([owner?.$disconnect(), app?.$disconnect()]);
    }
  });

  async function withPolicies(
    rows: readonly PolicyRow[],
    run: () => Promise<void>,
  ): Promise<void> {
    for (const row of rows) {
      // null stands for SQL NULL, the shape a hand-written SUSPENDED row most likely has.
      const allowedPurpose =
        row.allowedPurpose === null
          ? null
          : JSON.stringify(row.allowedPurpose ?? ["discovery", "enrichment"]);
      await owner.$executeRaw`
        INSERT INTO source_policy(id, domain, source_type, access_mode, allowed_purpose,
          retention_days, review_status, notes, created_at, updated_at)
        VALUES (${row.id}::uuid, ${row.domain}, 'official_website', 'crawl',
          ${allowedPurpose}::jsonb, ${row.retentionDays ?? 365}, ${row.reviewStatus ?? "APPROVED"},
          'raw-source-company-site-policy.postgres.spec', now(), now())`;
    }
    try {
      await run();
    } finally {
      for (const row of rows) {
        await owner.$executeRaw`DELETE FROM source_policy WHERE id = ${row.id}::uuid`;
      }
    }
  }

  const companySite = (overrides: Partial<PolicyRow> = {}): PolicyRow => ({
    id: COMPANY_SITE_ID,
    domain: PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN,
    ...overrides,
  });

  function publicWebRecord(domain: string): unknown {
    return mapPublicWebCompanyToRecord({
      domain,
      hitUrls: [`https://${domain}/produkte`],
      sourceText: `- Pumpen GmbH\n  URL: https://${domain}/produkte`,
      extracted: {
        is_company_site: true,
        name: "Pumpen Müller GmbH",
        country: "Germany",
        products: ["pumps"],
      },
      sourceClass: "public_intelligence",
      fetchedAt: new Date().toISOString(),
    });
  }

  function registryRecord(domain: string): unknown {
    return {
      externalId: `registry-${suffix}`,
      name: "Acme GmbH",
      domain,
      country: "DE",
      attributes: { products: ["pump"], employee_band: "50-100" },
      provenance: {
        sourceUrl: `https://${domain}/companies/1`,
        fetchedAt: new Date().toISOString(),
        contentHash: "a".repeat(64),
        parserVersion: "registry/v1",
      },
    };
  }

  /** TypeScript's decision against every policy app_user reads, as discovery reads them. */
  async function prepare(providerKey: string, record: unknown): Promise<PreparedRawSourceRow> {
    const policies: RawSourcePolicySnapshot[] = await app.sourcePolicy.findMany({
      select: {
        id: true,
        domain: true,
        retentionDays: true,
        reviewStatus: true,
        allowedPurpose: true,
        updatedAt: true,
      },
    });
    return prepareRawSourceBatch({ providerKey, records: [record], policies }).rows[0]!;
  }

  /** Persists through the real writer as app_user and returns the stored row; always rolls back. */
  async function persist(
    providerKey: string,
    row: PreparedRawSourceRow,
  ): Promise<StoredRaw> {
    let stored: StoredRaw | undefined;
    const write = app.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
        const receipt = await persistPreparedRawSourceRecord(tx, {
          workspaceId,
          runId,
          sourceEntityId: null,
          providerKey,
          sourceClass: providerKey === "registry" ? "company_registry" : "public_intelligence",
          row,
        });
        stored = (
          await tx.$queryRaw<StoredRaw[]>`
            SELECT ingest_status AS "ingestStatus", disposition_code AS "dispositionCode",
              retention_days AS "retentionDays", source_policy_snapshot AS snapshot
            FROM raw_source_record WHERE id = ${receipt.id}::uuid`
        )[0];
        throw ROLLBACK;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    await write.catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });
    return stored!;
  }

  /** TypeScript and the writer agree: no raise, and the stored row is the prepared one. */
  async function expectParity(
    providerKey: string,
    record: unknown,
    expected: { ingestStatus: string; dispositionCode: string | null; policyId: string | null },
  ): Promise<void> {
    const row = await prepare(providerKey, record);
    expect(row.ingestStatus).toBe(expected.ingestStatus);
    expect(row.dispositionCode).toBe(expected.dispositionCode);
    expect(row.sourcePolicySnapshot.id ?? null).toBe(expected.policyId);
    const stored = await persist(providerKey, row);
    expect(stored).toEqual({
      ingestStatus: row.ingestStatus,
      dispositionCode: row.dispositionCode,
      retentionDays: row.retentionDays,
      snapshot: row.sourcePolicySnapshot,
    });
  }

  it("keeps the binding function an owner-only helper and the writers' security unchanged", async () => {
    const routines = await owner.$queryRaw<
      { routine: string; definer: boolean; volatility: string; config: string[] | null; app: boolean; publicGrant: boolean }[]
    >`
      SELECT p.oid::regprocedure::text AS routine, p.prosecdef AS definer,
        p.provolatile::text AS volatility, p.proconfig AS config,
        has_function_privilege('app_user', p.oid, 'EXECUTE') AS app,
        EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl
          WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS "publicGrant"
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname IN (
        'raw_source_policy_binding_v3', 'write_raw_source_record_v2_legacy', 'write_raw_source_record_v2')
      ORDER BY p.proname COLLATE "C"`;
    expect(routines).toEqual([
      {
        routine: "raw_source_policy_binding_v3(text,text,text,jsonb,uuid,integer)",
        definer: false,
        volatility: "v",
        config: ["search_path=pg_catalog, public, pg_temp"],
        app: false,
        publicGrant: false,
      },
      {
        routine: "write_raw_source_record_v2(jsonb)",
        definer: true,
        volatility: "v",
        config: [expect.stringMatching(/^search_path=pg_catalog, public(?:, pg_temp)?$/u)],
        app: true,
        publicGrant: false,
      },
      {
        routine: "write_raw_source_record_v2_legacy(jsonb)",
        definer: true,
        volatility: "v",
        config: ["search_path=pg_catalog, public, pg_temp"],
        app: false,
        publicGrant: false,
      },
    ]);
  });

  describe("TypeScript and the writer bind the same policy", () => {
    it("accepts a public_web record under the company-site policy alone", async () => {
      await withPolicies([companySite()], () =>
        expectParity("public_web", publicWebRecord(site), {
          ingestStatus: "ACCEPTED",
          dispositionCode: null,
          policyId: COMPANY_SITE_ID,
        }),
      );
    });

    it.each([
      ["the exact domain", "", "", {}],
      ["a parent domain of the record's subdomain", "shop.", "", {}],
      ["the www. spelling", "", "www.", {}],
      ["an upper-case spelling", "", "UPPER", {}],
      ["a row without any purpose", "", "", { allowedPurpose: null }],
    ] as const)(
      "quarantines a public_web record whose site is SUSPENDED by %s",
      async (_title, recordPrefix, policySpelling, overrides) => {
        const domain =
          policySpelling === "UPPER" ? site.toUpperCase() : `${policySpelling}${site}`;
        const suspended: PolicyRow = {
          id: policyId(2),
          domain,
          reviewStatus: "SUSPENDED",
          ...overrides,
        };
        await withPolicies([companySite(), suspended], () =>
          expectParity("public_web", publicWebRecord(`${recordPrefix}${site}`), {
            ingestStatus: "QUARANTINED",
            dispositionCode: "SOURCE_POLICY_SUSPENDED",
            policyId: suspended.id,
          }),
        );
      },
    );

    it("prefers an approved site policy covering the host over the company-site policy", async () => {
      await withPolicies(
        [companySite(), { id: policyId(3), domain: site, retentionDays: 90 }],
        () =>
          expectParity("public_web", publicWebRecord(`shop.${site}`), {
            ingestStatus: "ACCEPTED",
            dispositionCode: null,
            policyId: policyId(3),
          }),
      );
    });

    it.each([
      ["SUSPENDED", { reviewStatus: "SUSPENDED" }, "SOURCE_POLICY_SUSPENDED"],
      ["without a purpose", { allowedPurpose: null }, "SOURCE_POLICY_PURPOSE_NOT_ALLOWED"],
      ["for enrichment only", { allowedPurpose: ["enrichment"] }, "SOURCE_POLICY_PURPOSE_NOT_ALLOWED"],
    ] as const)(
      "quarantines a public_web record when the company-site policy is %s",
      async (_title, overrides, reason) => {
        await withPolicies([companySite(overrides)], () =>
          expectParity("public_web", publicWebRecord(site), {
            ingestStatus: "QUARANTINED",
            dispositionCode: reason,
            policyId: COMPANY_SITE_ID,
          }),
        );
      },
    );

    it("quarantines a public_web record as SOURCE_POLICY_MISSING without the company-site policy", async () => {
      await expectParity("public_web", publicWebRecord(site), {
        ingestStatus: "QUARANTINED",
        dispositionCode: "SOURCE_POLICY_MISSING",
        policyId: null,
      });
    });

    it("never applies the company-site policy to another provider on its own host", async () => {
      await withPolicies([companySite()], () =>
        expectParity("registry", registryRecord(site), {
          ingestStatus: "QUARANTINED",
          dispositionCode: "SOURCE_POLICY_MISSING",
          policyId: null,
        }),
      );
    });

    it("binds the most specific site policy after dropping www., not the longest spelling", async () => {
      await withPolicies(
        [
          companySite(),
          { id: policyId(4), domain: `www.${site}` },
          { id: policyId(5), domain: `eu.${site}`, reviewStatus: "SUSPENDED" },
        ],
        () =>
          expectParity("public_web", publicWebRecord(`eu.${site}`), {
            ingestStatus: "QUARANTINED",
            dispositionCode: "SOURCE_POLICY_SUSPENDED",
            policyId: policyId(5),
          }),
      );
    });

    it("binds the SUSPENDED one of two site policies naming the same domain", async () => {
      await withPolicies(
        [
          companySite(),
          { id: policyId(6), domain: `www.${site}` },
          { id: policyId(7), domain: site.toUpperCase(), reviewStatus: "SUSPENDED" },
        ],
        () =>
          expectParity("public_web", publicWebRecord(site), {
            ingestStatus: "QUARANTINED",
            dispositionCode: "SOURCE_POLICY_SUSPENDED",
            policyId: policyId(7),
          }),
      );
    });
  });

  describe("the writer refuses bindings TypeScript never produces", () => {
    function bindTo(
      row: PreparedRawSourceRow,
      id: string,
      retentionDays = row.retentionDays,
    ): PreparedRawSourceRow {
      return {
        ...row,
        retentionDays,
        sourcePolicySnapshot: { ...row.sourcePolicySnapshot, kind: "source_policy", id },
      };
    }

    async function expectRefused(providerKey: string, row: PreparedRawSourceRow) {
      await expect(persist(providerKey, row)).rejects.toThrow(BINDING_INVALID);
    }

    it("refuses the company-site policy for another provider", async () => {
      await withPolicies([companySite(), { id: policyId(8), domain: site }], async () => {
        const row = await prepare("registry", registryRecord(site));
        // Control: the record itself is writable under the site policy that covers its host.
        expect((await persist("registry", row)).ingestStatus).toBe("ACCEPTED");
        await expectRefused("registry", bindTo(row, COMPANY_SITE_ID, 365));
      });
    });

    it("refuses the company-site policy while a site policy covers the host, whatever the status", async () => {
      await withPolicies(
        [companySite(), { id: policyId(9), domain: site, reviewStatus: "SUSPENDED" }],
        async () => {
          const quarantined = await prepare("public_web", publicWebRecord(site));
          expect(quarantined.dispositionCode).toBe("SOURCE_POLICY_SUSPENDED");
          await expectRefused("public_web", bindTo(quarantined, COMPANY_SITE_ID, 365));
        },
      );
      await withPolicies([companySite(), { id: policyId(10), domain: site }], async () => {
        const accepted = await prepare("public_web", publicWebRecord(site));
        expect(accepted.ingestStatus).toBe("ACCEPTED");
        await expectRefused("public_web", bindTo(accepted, COMPANY_SITE_ID, 365));
      });
    });

    it("refuses an ACCEPTED record under a SUSPENDED or purpose-less policy", async () => {
      await withPolicies([companySite({ reviewStatus: "SUSPENDED" })], async () => {
        const row = await prepare("public_web", publicWebRecord(site));
        expect(row.dispositionCode).toBe("SOURCE_POLICY_SUSPENDED");
        const accepted = await acceptedTwin(row);
        await expectRefused("public_web", accepted);
      });
      await withPolicies([companySite({ allowedPurpose: ["enrichment"] })], async () => {
        const row = await prepare("public_web", publicWebRecord(site));
        expect(row.dispositionCode).toBe("SOURCE_POLICY_PURPOSE_NOT_ALLOWED");
        await expectRefused("public_web", await acceptedTwin(row));
      });
    });

    it("refuses a retention that differs from the policy", async () => {
      await withPolicies([companySite()], async () => {
        const row = await prepare("public_web", publicWebRecord(site));
        expect(row.ingestStatus).toBe("ACCEPTED");
        await expectRefused("public_web", bindTo(row, COMPANY_SITE_ID, 364));
      });
    });

    it("refuses a site policy when a more specific one covers the host", async () => {
      await withPolicies(
        [
          companySite(),
          { id: policyId(11), domain: site },
          { id: policyId(12), domain: `shop.${site}`, reviewStatus: "SUSPENDED" },
        ],
        async () => {
          const row = await prepare("public_web", publicWebRecord(`shop.${site}`));
          expect(row.sourcePolicySnapshot.id).toBe(policyId(12));
          await expectRefused("public_web", bindTo(row, policyId(11)));
          await expectRefused("public_web", bindTo(await acceptedTwin(row), policyId(11)));
        },
      );
    });

    it("refuses an ACCEPTED record when an equally specific site policy is SUSPENDED", async () => {
      await withPolicies(
        [
          { id: policyId(13), domain: `www.${site}` },
          { id: policyId(14), domain: site, reviewStatus: "SUSPENDED" },
        ],
        async () => {
          const row = await prepare("public_web", publicWebRecord(site));
          expect(row.sourcePolicySnapshot.id).toBe(policyId(14));
          // The quarantined receipt may name either spelling; an ACCEPTED one may not.
          const stored = await persist("public_web", bindTo(row, policyId(13)));
          expect(stored.ingestStatus).toBe("QUARANTINED");
          await expectRefused("public_web", bindTo(await acceptedTwin(row), policyId(13)));
        },
      );
    });

    /**
     * The ACCEPTED form of a quarantined public_web record: the same record prepared under a
     * temporary APPROVED company-site policy, then bound back to the quarantined row's policy.
     */
    async function acceptedTwin(quarantined: PreparedRawSourceRow): Promise<PreparedRawSourceRow> {
      const twin = prepareRawSourceBatch({
        providerKey: "public_web",
        records: [publicWebRecord(new URL(quarantined.sourceUrl!).hostname)],
        policies: [
          {
            id: COMPANY_SITE_ID,
            domain: PUBLIC_WEB_COMPANY_SITE_POLICY_DOMAIN,
            retentionDays: quarantined.retentionDays,
            reviewStatus: "APPROVED",
            allowedPurpose: ["discovery"],
            updatedAt: new Date(),
          },
        ],
      }).rows[0]!;
      expect(twin.ingestStatus).toBe("ACCEPTED");
      return bindTo(twin, String(quarantined.sourcePolicySnapshot.id));
    }
  });
});
