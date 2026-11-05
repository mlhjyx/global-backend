import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

const OWNER_URL = process.env.DATABASE_URL;

function requireUrl(name, value) {
  assert.ok(value, `${name} is required`);
  return value;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

async function createChannel(db) {
  const id = randomUUID();
  await db.$executeRaw`
    INSERT INTO "source_channel" ("id", "name", "mode", "category", "status", "config", "updated_at")
    VALUES (${id}::uuid, ${`records-spec-${id.slice(0, 8)}`}, 'crawl', 'trade_fair', 'ENABLED', '{}'::jsonb, now())
  `;
  return id;
}

function recordInput(channelId, overrides = {}) {
  return {
    channelId,
    crawlRunId: randomUUID(),
    dedupeKey: `d:acme-${Math.random().toString(16).slice(2, 10)}.example`,
    name: "Acme Pumpen GmbH",
    website: "https://acme.example/",
    country: "Germany",
    sourceUrl: "https://expo.example/exhibitor/acme",
    contactName: "Max Mustermann",
    email: "sales@acme.example",
    ...overrides,
  };
}

async function insertRecord(db, input) {
  const id = randomUUID();
  await db.$executeRaw`
    INSERT INTO "source_channel_record" (
      "id", "channel_id", "crawl_run_id", "dedupe_key", "name", "website", "country",
      "source_url", "contact_name", "email", "first_seen_at", "last_seen_at"
    ) VALUES (
      ${id}::uuid, ${input.channelId}::uuid, ${input.crawlRunId}::uuid, ${input.dedupeKey},
      ${input.name}, ${input.website ?? null}, ${input.country ?? null},
      ${input.sourceUrl}, ${input.contactName ?? null}, ${input.email ?? null}, now(), now()
    )
  `;
  return id;
}

describe("source_channel_record (物化记录池)", () => {
  let db;
  before(async () => {
    db = client(requireUrl("DATABASE_URL", OWNER_URL));
    await db.$queryRaw`SELECT 1`;
  });
  after(async () => {
    await db?.$disconnect();
  });

  it("upserts on (channel_id, dedupe_key): 重跑同键更新 last_seen 而不新增行", async () => {
    const channelId = await createChannel(db);
    const input = recordInput(channelId);
    const firstId = await insertRecord(db, input);
    await db.$executeRaw`
      INSERT INTO "source_channel_record" ("id", "channel_id", "crawl_run_id", "dedupe_key", "name", "source_url", "last_seen_at")
      VALUES (${randomUUID()}::uuid, ${channelId}::uuid, ${randomUUID()}::uuid, ${input.dedupeKey}, 'Acme Pumpen (updated)', ${input.sourceUrl}, now())
      ON CONFLICT ("channel_id", "dedupe_key") DO UPDATE
      SET "name" = EXCLUDED."name", "last_seen_at" = EXCLUDED."last_seen_at"
    `;
    const rows = await db.$queryRaw`
      SELECT "id"::text AS id, "name" FROM "source_channel_record" WHERE "channel_id" = ${channelId}::uuid
    `;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, firstId);
    assert.equal(rows[0].name, "Acme Pumpen (updated)");
  });

  it("rejects duplicate (channel_id, dedupe_key) and non-https source_url", async () => {
    const channelId = await createChannel(db);
    const input = recordInput(channelId);
    await insertRecord(db, input);
    await assert.rejects(insertRecord(db, input), /23505|duplicate key|already exists|unique/i);
    await assert.rejects(
      insertRecord(db, recordInput(channelId, { sourceUrl: "http://plain.example/x" })),
      /source_url_check|check constraint|23514/i,
    );
  });

  it("cascades records when the channel is deleted", async () => {
    const channelId = await createChannel(db);
    await insertRecord(db, recordInput(channelId));
    await db.$executeRaw`DELETE FROM "source_channel" WHERE "id" = ${channelId}::uuid`;
    const rows = await db.$queryRaw`
      SELECT count(*)::int AS n FROM "source_channel_record" WHERE "channel_id" = ${channelId}::uuid
    `;
    assert.equal(rows[0].n, 0);
  });

  it("keeps source_channel_run.crawl_run_id unique while allowing NULLs", async () => {
    const channelId = await createChannel(db);
    const crawlRunId = randomUUID();
    const insertRun = (runId) => db.$executeRaw`
      INSERT INTO "source_channel_run" ("id", "channel_id", "crawl_run_id", "status", "started_at")
      VALUES (${randomUUID()}::uuid, ${channelId}::uuid, ${runId}::uuid, 'SUCCEEDED', now())
    `;
    await insertRun(crawlRunId);
    await assert.rejects(insertRun(crawlRunId), /23505|duplicate key|already exists|unique/i);
    const insertNullRun = () => db.$executeRaw`
      INSERT INTO "source_channel_run" ("id", "channel_id", "crawl_run_id", "status", "started_at")
      VALUES (${randomUUID()}::uuid, ${channelId}::uuid, NULL, 'SUCCEEDED', now())
    `;
    await insertNullRun();
    await insertNullRun();
  });

  it("grants app_user the manifest privileges on the record pool", async () => {
    const rows = await db.$queryRaw`
      SELECT
        has_table_privilege('app_user', 'public.source_channel_record', 'SELECT') AS sel,
        has_table_privilege('app_user', 'public.source_channel_record', 'INSERT') AS ins,
        has_table_privilege('app_user', 'public.source_channel_record', 'UPDATE') AS upd,
        has_table_privilege('app_user', 'public.source_channel_record', 'DELETE') AS del
    `;
    assert.equal(rows[0].sel, true);
    assert.equal(rows[0].ins, true);
    assert.equal(rows[0].upd, true);
    assert.equal(rows[0].del, false);
  });
});
