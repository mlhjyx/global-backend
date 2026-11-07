import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

/**
 * S1 Pack v1（service 组，真库）：平台目录/版本跨空间可读；workspace 激活、启停与
 * 策略快照按 workspace 隔离；发布版本/激活/回执/快照 append-only；目录只允许列级更新。
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
    assert.match(String(error?.message), /row-level security|violates foreign key/u);
    return true;
  });
}

const WS_A = randomUUID();
const WS_B = randomUUID();
const PACKAGE_ID = randomUUID();
const VERSION_ID = randomUUID();
const PACK_KEY = `demo.pack_${randomUUID().slice(0, 8)}`;
const DIGEST = "b".repeat(64);
const SNAPSHOT_DIGEST = "c".repeat(64);

describe("pack v1 registry RLS and append-only grants", () => {
  let owner;
  let app;

  before(async () => {
    owner = client(requireUrl("DATABASE_URL", OWNER_URL));
    app = client(requireUrl("APP_DATABASE_URL", APP_URL));
    await owner.$executeRaw`
      INSERT INTO "pack_package" ("id", "pack_key", "pack_type", "status")
      VALUES (${PACKAGE_ID}::uuid, ${PACK_KEY}, 'growth_motion', 'ACTIVE')
    `;
    await owner.$executeRaw`
      INSERT INTO "pack_version"
        ("id", "package_id", "version", "manifest", "content", "manifest_digest", "content_digest")
      VALUES (${VERSION_ID}::uuid, ${PACKAGE_ID}::uuid, '1.0.0', '{}'::jsonb, 'content',
              ${DIGEST}, ${DIGEST})
    `;
    await owner.$executeRaw`
      INSERT INTO "pack_activation" ("id", "package_id", "version_id", "scope", "activated_by")
      VALUES (gen_random_uuid(), ${PACKAGE_ID}::uuid, ${VERSION_ID}::uuid, 'platform', 'spec')
    `;
  });

  after(async () => {
    await owner.$executeRaw`DELETE FROM "strategy_resolution_snapshot" WHERE "descriptor_digest" = ${SNAPSHOT_DIGEST}`;
    await owner.$executeRaw`DELETE FROM "eval_receipt" WHERE "subject_key" = ${PACK_KEY}`;
    await owner.$executeRaw`DELETE FROM "pack_enablement" WHERE "package_id" = ${PACKAGE_ID}::uuid`;
    await owner.$executeRaw`DELETE FROM "pack_activation" WHERE "package_id" = ${PACKAGE_ID}::uuid`;
    await owner.$executeRaw`DELETE FROM "pack_version" WHERE "package_id" = ${PACKAGE_ID}::uuid`;
    await owner.$executeRaw`DELETE FROM "pack_package" WHERE "id" = ${PACKAGE_ID}::uuid`;
    await Promise.allSettled([owner.$disconnect(), app.$disconnect()]);
  });

  it("lets every workspace context read the platform pack catalog", async () => {
    for (const workspaceId of [WS_A, WS_B]) {
      const packages = await withWorkspace(
        app,
        workspaceId,
        (tx) => tx.$queryRaw`SELECT "id"::text AS "id" FROM "pack_package" WHERE "id" = ${PACKAGE_ID}::uuid`,
      );
      assert.equal(packages.length, 1);
      const versions = await withWorkspace(
        app,
        workspaceId,
        (tx) => tx.$queryRaw`SELECT "id"::text AS "id" FROM "pack_version" WHERE "id" = ${VERSION_ID}::uuid`,
      );
      assert.equal(versions.length, 1);
      const activations = await withWorkspace(
        app,
        workspaceId,
        (tx) => tx.$queryRaw`SELECT "id"::text AS "id" FROM "pack_activation" WHERE "package_id" = ${PACKAGE_ID}::uuid AND "scope" = 'platform'`,
      );
      assert.equal(activations.length, 1);
    }
  });

  it("isolates workspace enablement and canary activations", async () => {
    await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$executeRaw`
        INSERT INTO "pack_enablement" ("id", "workspace_id", "package_id", "enabled")
        VALUES (gen_random_uuid(), ${WS_A}::uuid, ${PACKAGE_ID}::uuid, false)
      `,
    );
    const visibleToA = await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$queryRaw`SELECT "enabled" FROM "pack_enablement" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
    );
    assert.deepEqual(visibleToA, [{ enabled: false }]);
    const visibleToB = await withWorkspace(
      app,
      WS_B,
      (tx) => tx.$queryRaw`SELECT "enabled" FROM "pack_enablement" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
    );
    assert.deepEqual(visibleToB, []);

    await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$executeRaw`
        INSERT INTO "pack_activation" ("id", "package_id", "version_id", "scope", "workspace_id", "canary", "activated_by")
        VALUES (gen_random_uuid(), ${PACKAGE_ID}::uuid, ${VERSION_ID}::uuid, 'workspace', ${WS_A}::uuid, true, 'spec')
      `,
    );
    const canaryA = await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$queryRaw`SELECT "canary" FROM "pack_activation" WHERE "scope" = 'workspace' AND "package_id" = ${PACKAGE_ID}::uuid`,
    );
    assert.deepEqual(canaryA, [{ canary: true }]);
    const canaryB = await withWorkspace(
      app,
      WS_B,
      (tx) => tx.$queryRaw`SELECT "canary" FROM "pack_activation" WHERE "scope" = 'workspace' AND "package_id" = ${PACKAGE_ID}::uuid`,
    );
    assert.deepEqual(canaryB, []);

    await rejectsWithRls(() =>
      withWorkspace(
        app,
        WS_B,
        (tx) => tx.$executeRaw`
          INSERT INTO "pack_activation" ("id", "package_id", "version_id", "scope", "workspace_id", "canary")
          VALUES (gen_random_uuid(), ${PACKAGE_ID}::uuid, ${VERSION_ID}::uuid, 'workspace', ${WS_A}::uuid, true)
        `,
      ),
    );

    await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$executeRaw`DELETE FROM "pack_enablement" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
    );
    // 激活是 append-only（app_user 无 DELETE）；workspace 行由 owner 在 after() 清理。
  });

  it("keeps versions, activations and receipts append-only for the application role", async () => {
    await rejectsWithPermission(() =>
      withWorkspace(app, WS_A, (tx) => tx.$executeRaw`UPDATE "pack_version" SET "version" = '2.0.0' WHERE "id" = ${VERSION_ID}::uuid`),
    );
    await rejectsWithPermission(() =>
      withWorkspace(app, WS_A, (tx) => tx.$executeRaw`DELETE FROM "pack_version" WHERE "id" = ${VERSION_ID}::uuid`),
    );
    // 发布路径：app_user 可 INSERT（Pack Studio 发布），插入后不可改不可删。
    const publishedId = randomUUID();
    await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$executeRaw`
        INSERT INTO "pack_version"
          ("id", "package_id", "version", "manifest", "content", "manifest_digest", "content_digest")
        VALUES (${publishedId}::uuid, ${PACKAGE_ID}::uuid, '9.9.9', '{}'::jsonb, 'x',
                ${"e".repeat(64)}, ${"e".repeat(64)})
      `,
    );
    await rejectsWithPermission(() =>
      withWorkspace(app, WS_A, (tx) => tx.$executeRaw`UPDATE "pack_version" SET "version" = '9.9.8' WHERE "id" = ${publishedId}::uuid`),
    );
    await rejectsWithPermission(() =>
      withWorkspace(app, WS_A, (tx) => tx.$executeRaw`DELETE FROM "pack_version" WHERE "id" = ${publishedId}::uuid`),
    );
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`UPDATE "pack_activation" SET "canary" = NOT "canary" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
      ),
    );
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`DELETE FROM "pack_activation" WHERE "package_id" = ${PACKAGE_ID}::uuid`,
      ),
    );

    await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$executeRaw`
        INSERT INTO "eval_receipt"
          ("id", "subject_kind", "subject_key", "subject_version", "subject_digest",
           "eval_manifest_digest", "tier", "passed", "cases_total", "cases_passed")
        VALUES (gen_random_uuid(), 'pack', ${PACK_KEY}, '1.0.0', ${DIGEST}, ${DIGEST},
                'deterministic', true, 5, 5)
      `,
    );
    const receipts = await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$queryRaw`SELECT "passed" FROM "eval_receipt" WHERE "subject_key" = ${PACK_KEY}`,
    );
    assert.deepEqual(receipts, [{ passed: true }]);
    await rejectsWithPermission(() =>
      withWorkspace(app, WS_A, (tx) => tx.$executeRaw`UPDATE "eval_receipt" SET "passed" = false WHERE "subject_key" = ${PACK_KEY}`),
    );
    await rejectsWithPermission(() =>
      withWorkspace(app, WS_A, (tx) => tx.$executeRaw`DELETE FROM "eval_receipt" WHERE "subject_key" = ${PACK_KEY}`),
    );
  });

  it("makes strategy snapshots idempotent, tenant-isolated and append-only", async () => {
    const insert = () =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`
          INSERT INTO "strategy_resolution_snapshot"
            ("id", "workspace_id", "skill_key", "descriptor", "descriptor_digest", "resolver_version")
          VALUES (gen_random_uuid(), ${WS_A}::uuid, 'demo.skill', '{}'::jsonb, ${SNAPSHOT_DIGEST},
                  'strategy-resolver/v0')
          ON CONFLICT ("workspace_id", "skill_key", "descriptor_digest") DO NOTHING
        `,
      );
    await insert();
    await insert();
    const rows = await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$queryRaw`SELECT "id"::text AS "id" FROM "strategy_resolution_snapshot" WHERE "descriptor_digest" = ${SNAPSHOT_DIGEST}`,
    );
    assert.equal(rows.length, 1);
    const hidden = await withWorkspace(
      app,
      WS_B,
      (tx) => tx.$queryRaw`SELECT "id"::text AS "id" FROM "strategy_resolution_snapshot" WHERE "descriptor_digest" = ${SNAPSHOT_DIGEST}`,
    );
    assert.equal(hidden.length, 0);

    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`UPDATE "strategy_resolution_snapshot" SET "resolver_version" = 'tampered' WHERE "descriptor_digest" = ${SNAPSHOT_DIGEST}`,
      ),
    );
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`DELETE FROM "strategy_resolution_snapshot" WHERE "descriptor_digest" = ${SNAPSHOT_DIGEST}`,
      ),
    );
  });

  it("allows only the status and activation columns of the pack catalog to change", async () => {
    await rejectsWithPermission(() =>
      withWorkspace(
        app,
        WS_A,
        (tx) => tx.$executeRaw`UPDATE "pack_package" SET "pack_key" = 'demo.other' WHERE "id" = ${PACKAGE_ID}::uuid`,
      ),
    );
    await withWorkspace(
      app,
      WS_A,
      (tx) => tx.$executeRaw`
        UPDATE "pack_package"
        SET "status" = 'DISABLED',
            "status_reason" = 'spec',
            "status_updated_at" = now(),
            "active_version_id" = ${VERSION_ID}::uuid,
            "updated_at" = now()
        WHERE "id" = ${PACKAGE_ID}::uuid
      `,
    );
    const [row] = await owner.$queryRaw`SELECT "status" FROM "pack_package" WHERE "id" = ${PACKAGE_ID}::uuid`;
    assert.equal(row.status, "DISABLED");
    await owner.$executeRaw`UPDATE "pack_package" SET "status" = 'ACTIVE' WHERE "id" = ${PACKAGE_ID}::uuid`;
  });
});
