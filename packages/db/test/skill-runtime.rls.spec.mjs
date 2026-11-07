import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

/**
 * S0 技能运行时（service 组，真库）：平台目录跨空间可读；enablement/快照按 workspace
 * RLS 隔离；版本与快照 append-only（app_user 不可改不可删）；目录状态只允许列级 UPDATE。
 * 迁移由 CI 的 `prisma migrate deploy` 应用；本 spec 自建目录行并在结束时清理。
 */

const OWNER_URL = process.env.DATABASE_URL;
const APP_URL = process.env.APP_DATABASE_URL;

function requireUrl(name, value) {
  assert.ok(value, `${name} is required`);
  return value;
}

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

async function withWorkspace(prisma, workspaceId, fn) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });
}

async function rejectsWithPermission(operation) {
  await assert.rejects(operation, (error) => {
    assert.match(String(error?.message), /permission denied/u);
    return true;
  });
}

async function rejectsWithRls(operation) {
  await assert.rejects(operation, (error) => {
    assert.match(String(error?.message), /row-level security/u);
    return true;
  });
}

const WS_A = randomUUID();
const WS_B = randomUUID();
const PACKAGE_ID = randomUUID();
const VERSION_ID = randomUUID();
const SKILL_KEY = `spec.skill_${randomUUID().slice(0, 8)}`;
const DIGEST = "a".repeat(64);

describe("skill runtime v0 registry RLS and append-only grants", () => {
  let owner;
  let app;

  before(async () => {
    owner = client(requireUrl("DATABASE_URL", OWNER_URL));
    app = client(requireUrl("APP_DATABASE_URL", APP_URL));
    await owner.$executeRaw`
      INSERT INTO "skill_package"
        ("id", "skill_key", "scope", "workspace_id", "pack_type", "display_name", "status")
      VALUES (${PACKAGE_ID}::uuid, ${SKILL_KEY}, 'platform', NULL, 'growth_motion', 'spec skill', 'ACTIVE')
    `;
    await owner.$executeRaw`
      INSERT INTO "skill_version"
        ("id", "package_id", "workspace_id", "version", "manifest", "body_markdown",
         "manifest_digest", "body_digest", "task_contract_id", "task_contract_digest")
      VALUES (${VERSION_ID}::uuid, ${PACKAGE_ID}::uuid, NULL, '1.0.0', '{}'::jsonb, 'body',
              ${DIGEST}, ${DIGEST}, 'demo.task', ${DIGEST})
    `;
  });

  after(async () => {
    await owner.$executeRaw`DELETE FROM "skill_resolution_snapshot" WHERE "package_id" = ${PACKAGE_ID}::uuid`;
    await owner.$executeRaw`DELETE FROM "skill_enablement" WHERE "package_id" = ${PACKAGE_ID}::uuid`;
    await owner.$executeRaw`DELETE FROM "skill_version" WHERE "package_id" = ${PACKAGE_ID}::uuid`;
    await owner.$executeRaw`DELETE FROM "skill_package" WHERE "id" = ${PACKAGE_ID}::uuid`;
    await Promise.allSettled([owner.$disconnect(), app.$disconnect()]);
  });

  it("lets every workspace context read the platform catalog", async () => {
    for (const workspaceId of [WS_A, WS_B]) {
      const packages = await withWorkspace(
        app,
        workspaceId,
        (tx) => tx.$queryRaw`SELECT "id"::text AS "id" FROM "skill_package" WHERE "id" = ${PACKAGE_ID}::uuid`,
      );
      assert.equal(packages.length, 1);
      const versions = await withWorkspace(
        app,
        workspaceId,
        (tx) => tx.$queryRaw`SELECT "id"::text AS "id" FROM "skill_version" WHERE "id" = ${VERSION_ID}::uuid`,
      );
      assert.equal(versions.length, 1);
    }
  });

  it("isolates enablement rows to their own workspace", async () => {
    await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$executeRaw`
        INSERT INTO "skill_enablement" ("id", "workspace_id", "package_id", "enabled")
        VALUES (gen_random_uuid(), ${WS_A}::uuid, ${PACKAGE_ID}::uuid, true)
      `,
    );
    const visibleToA = await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$queryRaw`SELECT "enabled" FROM "skill_enablement" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
    );
    assert.deepEqual(visibleToA, [{ enabled: true }]);
    const visibleToB = await withWorkspace(
      app,
      WS_B,
      (tx) => tx.$queryRaw`SELECT "enabled" FROM "skill_enablement" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
    );
    assert.deepEqual(visibleToB, []);

    await rejectsWithRls(() =>
      withWorkspace(
        app,
        WS_B,
        (tx) => tx.$executeRaw`
          INSERT INTO "skill_enablement" ("id", "workspace_id", "package_id", "enabled")
          VALUES (gen_random_uuid(), ${WS_A}::uuid, ${PACKAGE_ID}::uuid, true)
        `,
      ),
    );

    await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$executeRaw`DELETE FROM "skill_enablement" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
    );
  });

  it("makes snapshots append-only and idempotent per descriptor digest", async () => {
    const insert = () =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`
          INSERT INTO "skill_resolution_snapshot"
            ("id", "workspace_id", "skill_key", "package_id", "version_id",
             "descriptor", "descriptor_digest", "resolver_version")
          VALUES (gen_random_uuid(), ${WS_A}::uuid, ${SKILL_KEY}, ${PACKAGE_ID}::uuid,
                  ${VERSION_ID}::uuid, '{}'::jsonb, ${DIGEST}, 'skill-resolver/v0')
          ON CONFLICT ("workspace_id", "skill_key", "descriptor_digest") DO NOTHING
        `,
      );
    await insert();
    await insert();

    const rows = await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$queryRaw`SELECT "id"::text AS "id" FROM "skill_resolution_snapshot" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
    );
    assert.equal(rows.length, 1);

    const hidden = await withWorkspace(
      app,
      WS_B,
      (tx) => tx.$queryRaw`SELECT "id"::text AS "id" FROM "skill_resolution_snapshot" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
    );
    assert.equal(hidden.length, 0);

    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`UPDATE "skill_resolution_snapshot" SET "resolver_version" = 'tampered' WHERE "package_id" = ${PACKAGE_ID}::uuid`,
      ),
    );
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`DELETE FROM "skill_resolution_snapshot" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
      ),
    );
  });

  it("keeps skill versions immutable for the application role", async () => {
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`UPDATE "skill_version" SET "version" = '2.0.0' WHERE "id" = ${VERSION_ID}::uuid`,
      ),
    );
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`DELETE FROM "skill_version" WHERE "id" = ${VERSION_ID}::uuid`,
      ),
    );
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`
          INSERT INTO "skill_version"
            ("id", "package_id", "workspace_id", "version", "manifest", "body_markdown",
             "manifest_digest", "body_digest", "task_contract_id", "task_contract_digest")
          VALUES (gen_random_uuid(), ${PACKAGE_ID}::uuid, NULL, '9.9.9', '{}'::jsonb, 'b',
                  ${DIGEST}, ${DIGEST}, 'demo.task', ${DIGEST})
        `,
      ),
    );
  });

  it("allows only the status columns of the catalog to be updated by the application role", async () => {
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`UPDATE "skill_package" SET "pack_type" = 'market' WHERE "id" = ${PACKAGE_ID}::uuid`,
      ),
    );
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`INSERT INTO "skill_package" ("id", "skill_key", "pack_type", "display_name") VALUES (gen_random_uuid(), 'spec.other', 'market', 'x')`,
      ),
    );
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`DELETE FROM "skill_package" WHERE "id" = ${PACKAGE_ID}::uuid`,
      ),
    );

    await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$executeRaw`
        UPDATE "skill_package"
        SET "status" = 'DISABLED', "status_reason" = 'spec', "status_updated_at" = now(), "updated_at" = now()
        WHERE "id" = ${PACKAGE_ID}::uuid
      `,
    );
    const [row] = await owner.$queryRaw`SELECT "status" FROM "skill_package" WHERE "id" = ${PACKAGE_ID}::uuid`;
    assert.equal(row.status, "DISABLED");
    await owner.$executeRaw`UPDATE "skill_package" SET "status" = 'ACTIVE' WHERE "id" = ${PACKAGE_ID}::uuid`;
  });
});
