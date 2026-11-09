import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  goldenLabelSummary,
  promoteGoldenLabels,
  retireGoldenLabels,
} from "../../../apps/api/src/discovery/judgment/golden-label";

/**
 * P3 J18 金标晋升/退役的库上语义（service 组）：append-only 追加新 split、
 * 幂等重跑、季度轮换保留最新 N 行、跨租户不可见。
 */

const OWNER_URL = process.env.DATABASE_URL;

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

async function seedTenant(owner, suffix) {
  const workspaceId = randomUUID();
  await owner.workspace.create({ data: { id: workspaceId, name: `j18 ${suffix}` } });
  const seller = await owner.companyProfile.create({
    data: { workspaceId, name: `Seller ${suffix}` },
  });
  const company = await owner.canonicalCompany.create({
    data: {
      workspaceId,
      name: `Muster ${suffix}`,
      domain: `j18-${suffix}.example`,
      dedupeKey: `domain:j18-${suffix}.example`,
    },
  });
  const icp = await owner.icpDefinition.create({
    data: { workspaceId, companyId: seller.id, name: `ICP ${suffix}` },
  });
  return { workspaceId, companyId: company.id, icpId: icp.id };
}

async function seedCandidate(owner, tenant, index) {
  return owner.judgmentGoldenLabel.create({
    data: {
      workspaceId: tenant.workspaceId,
      canonicalCompanyId: tenant.companyId,
      icpId: tenant.icpId,
      label: "FIT",
      labelSource: "review",
      rubricVersion: "fit-v2",
      inputDigest: `${String(index).padStart(2, "0")}${"a".repeat(62)}`,
      split: "candidate",
      labeledAt: new Date(Date.UTC(2026, 10, 1, 0, index)),
    },
  });
}

describe("golden label promotion lifecycle (P3 J18)", () => {
  let owner;

  before(async () => {
    assert.ok(OWNER_URL, "DATABASE_URL is required");
    owner = client(OWNER_URL);
    await owner.$queryRaw`SELECT 1`;
  });

  after(async () => {
    await owner?.$disconnect();
  });

  it("candidate → test 晋升：追加新行、原行不变、重跑幂等；retire 保留最新", async () => {
    const tenant = await seedTenant(owner, randomUUID().slice(0, 6));
    for (let index = 1; index <= 3; index += 1) {
      await seedCandidate(owner, tenant, index);
    }

    const first = await promoteGoldenLabels(owner, {
      workspaceId: tenant.workspaceId,
      to: "test",
      limit: 2,
    });
    assert.equal(first.promoted, 2);

    const candidates = await owner.judgmentGoldenLabel.count({
      where: { workspaceId: tenant.workspaceId, split: "candidate" },
    });
    assert.equal(candidates, 3, "append-only：原 candidate 行不变");
    const testRows = await owner.judgmentGoldenLabel.findMany({
      where: { workspaceId: tenant.workspaceId, split: "test" },
      orderBy: { labeledAt: "asc" },
    });
    assert.equal(testRows.length, 2);

    const rerun = await promoteGoldenLabels(owner, {
      workspaceId: tenant.workspaceId,
      to: "test",
      limit: 2,
    });
    assert.equal(rerun.promoted, 1, "重跑只晋升剩余候选（已晋升的幂等跳过）");
    assert.ok(rerun.skipped.some((entry) => entry.reason === "already-in-target"));

    const retire = await retireGoldenLabels(owner, {
      workspaceId: tenant.workspaceId,
      split: "test",
      keep: 1,
    });
    assert.equal(retire.retired, 2, "test 共 3 行，keep=1 → 退役 2 行");
    assert.equal(retire.kept, 1);
    const retiredRows = await owner.judgmentGoldenLabel.count({
      where: { workspaceId: tenant.workspaceId, split: "retired" },
    });
    assert.equal(retiredRows, 2);
    const retireRerun = await retireGoldenLabels(owner, {
      workspaceId: tenant.workspaceId,
      split: "test",
      keep: 1,
    });
    assert.equal(retireRerun.retired, 0, "退役同样幂等");

    const summary = await goldenLabelSummary(owner, tenant.workspaceId);
    const bySplit = Object.fromEntries(summary.map((row) => [row.split, row.count]));
    assert.deepEqual(bySplit, { candidate: 3, test: 3, retired: 2 });
  });

  it("跨租户：另一个 workspace 的 summary 看不到别人的金标", async () => {
    const a = await seedTenant(owner, `a-${randomUUID().slice(0, 6)}`);
    const b = await seedTenant(owner, `b-${randomUUID().slice(0, 6)}`);
    await seedCandidate(owner, a, 1);
    const summaryB = await goldenLabelSummary(owner, b.workspaceId);
    assert.deepEqual(summaryB, []);
    const summaryA = await goldenLabelSummary(owner, a.workspaceId);
    assert.equal(summaryA.length, 1);
  });
});
