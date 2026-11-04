import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.DATABASE_URL;
const PLATFORM_LOGIN = "execution_budget_crawl_platform_test";
const PLATFORM_PASSWORD = randomBytes(24).toString("hex");
const ISSUER = "https://control.example.test";
const AUDIENCE = "global-backend:execution-budget";
const SCHEMA_VERSION = "execution-budget-grant/v1";
const PURPOSE = "platform.channel_crawl";
const TECHNICAL_POLICY_REVISION = "d".repeat(64);

function requireUrl(name, value) {
  assert.ok(value, `${name} is required`);
  return value;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function roleUrl(login, password) {
  const value = new URL(requireUrl("DATABASE_URL", OWNER_URL));
  value.username = login;
  value.password = password;
  return value.toString();
}

function grantInput(overrides = {}) {
  const now = Date.now();
  const subjectId = overrides.subjectId ?? randomUUID();
  return {
    issuer: overrides.issuer ?? ISSUER,
    audience: overrides.audience ?? AUDIENCE,
    jti: overrides.jti ?? randomUUID(),
    tokenSha256: overrides.tokenSha256 ?? randomBytes(32).toString("hex"),
    schemaVersion: overrides.schemaVersion ?? SCHEMA_VERSION,
    purpose: overrides.purpose ?? PURPOSE,
    subjectType: overrides.subjectType ?? "source_channel",
    subjectId,
    crawlRunId: overrides.crawlRunId ?? randomUUID(),
    requestSha256:
      overrides.requestSha256 ?? randomBytes(32).toString("hex"),
    technicalPolicyRevision:
      overrides.technicalPolicyRevision ?? TECHNICAL_POLICY_REVISION,
    currency: overrides.currency ?? "USD",
    unit: overrides.unit ?? "microusd",
    capPerRunMicrousd: overrides.capPerRunMicrousd ?? 5_000_000n,
    campaignCapMicrousd: overrides.campaignCapMicrousd ?? 250_000_000n,
    maxRuns: overrides.maxRuns ?? 1n,
    issuedAt: overrides.issuedAt ?? new Date(now - 30_000),
    notBefore: overrides.notBefore ?? new Date(now - 20_000),
    expiresAt: overrides.expiresAt ?? new Date(now + 240_000),
  };
}

function expectedInput(grant, overrides = {}) {
  return {
    purpose: overrides.purpose ?? grant.purpose,
    subjectType: overrides.subjectType ?? grant.subjectType,
    subjectId: overrides.subjectId ?? grant.subjectId,
    requestSha256: overrides.requestSha256 ?? grant.requestSha256,
    crawlRunId: overrides.crawlRunId ?? grant.crawlRunId,
    technicalPolicyRevision:
      overrides.technicalPolicyRevision ?? grant.technicalPolicyRevision,
  };
}

async function ingestAndAdmit(
  database,
  grant,
  expected = expectedInput(grant),
) {
  return database.$queryRawUnsafe(
    `SELECT * FROM ingest_and_admit_platform_channel_crawl_run_v1(
      $1,$2,$3::uuid,$4,$5,$6::execution_budget_purpose,$7,$8,$9,$10,
      $11,$12,$13,$14::bigint,$15::bigint,$16::bigint,
      $17::timestamptz,$18::timestamptz,$19::timestamptz,
      $20::execution_budget_purpose,$21,$22,$23,$24,$25
    )`,
    grant.issuer,
    grant.audience,
    grant.jti,
    grant.tokenSha256,
    grant.schemaVersion,
    grant.purpose,
    grant.subjectType,
    grant.subjectId,
    grant.requestSha256,
    grant.crawlRunId,
    grant.technicalPolicyRevision,
    grant.currency,
    grant.unit,
    grant.capPerRunMicrousd,
    grant.campaignCapMicrousd,
    grant.maxRuns,
    grant.issuedAt,
    grant.notBefore,
    grant.expiresAt,
    expected.purpose,
    expected.subjectType,
    expected.subjectId,
    expected.requestSha256,
    expected.crawlRunId,
    expected.technicalPolicyRevision,
  );
}

async function rejectWith(operation, marker) {
  await assert.rejects(operation, (error) => {
    assert.match(String(error?.message), new RegExp(marker));
    return true;
  });
}

describe("platform channel-crawl authority PostgreSQL admission", () => {
  let owner;
  let platform;

  before(async () => {
    owner = client(requireUrl("DATABASE_URL", OWNER_URL));
    await owner.$executeRawUnsafe(`
      DO $role$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${PLATFORM_LOGIN}') THEN
          REVOKE execution_budget_platform_writer FROM ${PLATFORM_LOGIN};
          DROP ROLE ${PLATFORM_LOGIN};
        END IF;
        CREATE ROLE ${PLATFORM_LOGIN}
          LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
          NOREPLICATION NOBYPASSRLS PASSWORD '${PLATFORM_PASSWORD}';
        GRANT execution_budget_platform_writer TO ${PLATFORM_LOGIN};
      END
      $role$
    `);
    platform = client(roleUrl(PLATFORM_LOGIN, PLATFORM_PASSWORD));
  });

  after(async () => {
    await Promise.allSettled([platform?.$disconnect()]);
    if (owner) {
      await owner.$executeRawUnsafe(
        `REVOKE execution_budget_platform_writer FROM ${PLATFORM_LOGIN}`,
      );
      await owner.$executeRawUnsafe(`DROP ROLE IF EXISTS ${PLATFORM_LOGIN}`);
      await owner.$disconnect();
    }
  });

  it("atomically persists one request-bound authority/account and read-only recovers an ACK-loss retry", async () => {
    const grant = grantInput();

    const [first] = await ingestAndAdmit(platform, grant);
    const [retry] = await ingestAndAdmit(platform, grant);
    assert.equal(first.replay, false);
    assert.equal(retry.replay, true);
    assert.equal(String(retry.account_id), String(first.account_id));
    assert.equal(String(first.authority_id), String(retry.authority_id));
    assert.equal(first.authorized_cap_microusd, 5_000_000n);

    await rejectWith(
      () =>
        ingestAndAdmit(
          platform,
          grant,
          expectedInput(grant, { requestSha256: "f".repeat(64) }),
        ),
      "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
    );
    await rejectWith(
      () =>
        ingestAndAdmit(
          platform,
          grant,
          expectedInput(grant, { crawlRunId: randomUUID() }),
        ),
      "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
    );
  });

  it("fences one crawl run to one authority even across a fresh JTI", async () => {
    const first = grantInput();
    const [opened] = await ingestAndAdmit(platform, first);
    assert.equal(opened.replay, false);

    const second = grantInput({ crawlRunId: first.crawlRunId });
    await rejectWith(
      () => ingestAndAdmit(platform, second),
      "EXECUTION_BUDGET_GRANT_REUSED",
    );
  });

  it("keeps schedule and channel-crawl shapes mutually exclusive at both entry points", async () => {
    const scheduleShaped = grantInput({
      purpose: "platform.acquisition",
      subjectType: "schedule",
    });
    await rejectWith(
      () => ingestAndAdmit(platform, scheduleShaped),
      "EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH",
    );

    const crawlThroughV2 = await platform.$queryRawUnsafe(
      `SELECT * FROM ingest_and_admit_platform_execution_budget_run_v2(
        $1,$2,$3::uuid,$4,$5,$6::execution_budget_purpose,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16::bigint,$17::bigint,$18::bigint,
        $19::timestamptz,$20::timestamptz,$21::timestamptz,
        $22::execution_budget_purpose,$23,$24,$25,$26,$27,$28,$29
      )`,
      ISSUER,
      AUDIENCE,
      randomUUID(),
      randomBytes(32).toString("hex"),
      SCHEMA_VERSION,
      PURPOSE,
      "source_channel",
      randomUUID(),
      "channel-crawl",
      "a".repeat(64),
      "channel-crawl-2026-11-05",
      randomUUID(),
      TECHNICAL_POLICY_REVISION,
      "USD",
      "microusd",
      5_000_000n,
      250_000_000n,
      1n,
      new Date(Date.now() - 30_000),
      new Date(Date.now() - 20_000),
      new Date(Date.now() + 240_000),
      PURPOSE,
      "source_channel",
      randomUUID(),
      "channel-crawl",
      "a".repeat(64),
      "channel-crawl-2026-11-05",
      randomUUID(),
      TECHNICAL_POLICY_REVISION,
    ).catch((error) => error);
    assert.match(
      String(crawlThroughV2?.message),
      /EXECUTION_BUDGET_GRANT_SCOPE_MISMATCH/,
    );
  });

  it("rejects a non-writer principal", async () => {
    const grant = grantInput();
    const outsider = client(
      (() => {
        const value = new URL(requireUrl("DATABASE_URL", OWNER_URL));
        return value.toString();
      })(),
    );
    try {
      await rejectWith(
        () => ingestAndAdmit(outsider, grant),
        "EXECUTION_BUDGET_PLATFORM_WRITER_PRINCIPAL_INVALID",
      );
    } finally {
      await outsider.$disconnect();
    }
  });
});
