import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

/**
 * P1-18 社媒信号（service 组，真库）：company_signal 的租户隔离与 app_user 授权。
 *
 * 迁移由 CI 的 `prisma migrate deploy` 应用；本 spec 自建 workspace/公司/信号行并在结束时
 * 清理。验证四件事：app_user 在 set_config 上下文里可插入/读取/更新；无上下文读空；
 * 跨 workspace 不可见且 WITH CHECK 拒绝写成别的租户；app_user 无 DELETE。
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

const WS_A = randomUUID();
const WS_B = randomUUID();
const COMPANY_A = randomUUID();
const FINGERPRINT = "a".repeat(64);

function signalData(overrides = {}) {
  return {
    workspaceId: WS_A,
    companyId: COMPANY_A,
    providerKey: "rss",
    signalKind: "rss_item",
    sourceUrl: "https://example.test/news",
    title: "Spec signal",
    excerpt: null,
    observedAt: new Date("2026-11-10T09:30:00.000Z"),
    fingerprint: FINGERPRINT,
    ingestKey: `rss:${FINGERPRINT}`,
    ...overrides,
  };
}

describe("company_signal tenant RLS and app_user grants", () => {
  let owner;
  let app;
  let signalId;

  before(async () => {
    owner = client(requireUrl("DATABASE_URL", OWNER_URL));
    app = client(requireUrl("APP_DATABASE_URL", APP_URL));
    await owner.workspace.create({ data: { id: WS_A, name: "P1-18 A" } });
    await owner.workspace.create({ data: { id: WS_B, name: "P1-18 B" } });
    await owner.canonicalCompany.create({
      data: {
        id: COMPANY_A,
        workspaceId: WS_A,
        name: "Nees Pumpen",
        domain: "nees-pumpen.de",
        dedupeKey: `domain:nees-pumpen.de:${COMPANY_A.slice(0, 8)}`,
      },
    });
  });

  after(async () => {
    if (owner) {
      await owner.companySignal.deleteMany({ where: { workspaceId: { in: [WS_A, WS_B] } } }).catch(() => {});
      await owner.canonicalCompany.deleteMany({ where: { id: COMPANY_A } }).catch(() => {});
      await owner.workspace.deleteMany({ where: { id: { in: [WS_A, WS_B] } } }).catch(() => {});
    }
    await Promise.allSettled([owner?.$disconnect(), app?.$disconnect()]);
  });

  it("app_user：上下文内可插入/读取/更新；跨 workspace 不可见；无上下文读空", async () => {
    const created = await withWorkspace(app, WS_A, (tx) => tx.companySignal.create({ data: signalData() }));
    signalId = created.id;
    assert.equal(created.workspaceId, WS_A);
    assert.equal(created.companyId, COMPANY_A);

    const own = await withWorkspace(app, WS_A, (tx) => tx.companySignal.findMany({ where: { id: signalId } }));
    assert.equal(own.length, 1);

    const other = await withWorkspace(app, WS_B, (tx) => tx.companySignal.findMany({ where: { id: signalId } }));
    assert.equal(other.length, 0);

    const unscoped = await app.companySignal.findMany({ where: { id: signalId } });
    assert.equal(unscoped.length, 0);

    const updated = await withWorkspace(app, WS_A, (tx) =>
      tx.companySignal.updateMany({ where: { id: signalId }, data: { title: "updated" } }),
    );
    assert.equal(updated.count, 1);
  });

  it("跨租户写入被 WITH CHECK 拒绝（row-level security）", async () => {
    await assert.rejects(
      withWorkspace(app, WS_B, (tx) =>
        tx.companySignal.create({
          data: signalData({ ingestKey: `rss:${"b".repeat(64)}`, fingerprint: "b".repeat(64) }),
        }),
      ),
      (error) => {
        assert.match(String(error?.message), /row-level security/u);
        return true;
      },
    );
  });

  it("无上下文插入被 WITH CHECK 拒绝", async () => {
    await assert.rejects(
      app.companySignal.create({
        data: signalData({ ingestKey: `rss:${"c".repeat(64)}`, fingerprint: "c".repeat(64) }),
      }),
      (error) => {
        assert.match(String(error?.message), /row-level security/u);
        return true;
      },
    );
  });

  it("唯一 (workspace_id, ingest_key) 生效；app_user 无 DELETE", async () => {
    await assert.rejects(
      withWorkspace(app, WS_A, (tx) =>
        tx.companySignal.create({
          data: signalData({ sourceUrl: "https://example.test/other", title: "dupe" }),
        }),
      ),
      (error) => {
        assert.match(String(error?.message), /Unique constraint/u);
        return true;
      },
    );
    await assert.rejects(
      withWorkspace(app, WS_A, (tx) => tx.companySignal.deleteMany({ where: { id: signalId } })),
      (error) => {
        assert.match(String(error?.message), /permission denied/u);
        return true;
      },
    );
  });
});
