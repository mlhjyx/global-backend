import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  HUMAN_PROMPT_HASH,
  claimReviewTask,
  enqueueReviewTask,
  getJudgment,
  judgmentReviewStats,
  listReviewTasks,
  resolveReviewTask,
} from "../../../apps/api/src/discovery/judgment/review-queue";

/**
 * P3 J17 人工复核队列的库上生命周期（service 组，迁移后的一次性库）：
 * enqueue → list（含公司名/判定）→ claim → resolve（新 human judgment_record +
 * golden label candidate + 任务 resolved）→ stats（overturn）。
 *
 * 权限面（append-only / RLS）由 apps/api/src/prisma/app-user-table-privileges
 * .postgres.spec.ts 单独覆盖；这里用 owner 连接 + `set_config` 走与生产相同的
 * withWorkspace 语义，验证编排本身。
 */

const OWNER_URL = process.env.DATABASE_URL;

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

const digest = (seed) => seed.repeat(64).slice(0, 64);

async function seedTenant(owner, suffix) {
  const workspaceId = randomUUID();
  await owner.workspace.create({ data: { id: workspaceId, name: `j17 ${suffix}` } });
  const seller = await owner.companyProfile.create({
    data: { workspaceId, name: `Seller ${suffix}` },
  });
  const company = await owner.canonicalCompany.create({
    data: {
      workspaceId,
      name: `Muster Metallbau ${suffix}`,
      domain: `muster-${suffix}.example`,
      dedupeKey: `domain:muster-${suffix}.example`,
    },
  });
  const icp = await owner.icpDefinition.create({
    data: { workspaceId, companyId: seller.id, name: `ICP ${suffix}` },
  });
  return { workspaceId, companyId: company.id, icpId: icp.id };
}

async function insertJudgmentRecord(owner, tenant, overrides = {}) {
  const seed = randomUUID().replaceAll("-", "");
  return owner.judgmentRecord.create({
    data: {
      workspaceId: tenant.workspaceId,
      icpId: tenant.icpId,
      canonicalCompanyId: tenant.companyId,
      judgeLevel: 2,
      verdict: "UNKNOWN",
      verdictProposed: "FIT",
      criteria: [
        {
          id: "C1_MATERIAL",
          applicable: true,
          score: 6,
          label: "weak",
          evidence: [],
          rationale: "borderline",
        },
      ],
      evidenceCompleteness: true,
      rubricVersion: "fit-v2",
      promptHash: digest("a"),
      schemaVersion: "judge-output/v2",
      inputDigest: digest(seed.slice(0, 16)),
      outputDigest: digest("c"),
      modelRequested: "deepseek-v4-pro",
      modelResolved: "deepseek-v4-pro",
      sampling: {},
      attempt: 1,
      ...overrides,
    },
  });
}

describe("judgment review queue lifecycle (P3 J17)", () => {
  let owner;

  before(async () => {
    assert.ok(OWNER_URL, "DATABASE_URL is required");
    owner = client(OWNER_URL);
    await owner.$queryRaw`SELECT 1`;
  });

  after(async () => {
    await owner?.$disconnect();
  });

  it("enqueue → list → claim → resolve → stats 端到端", async () => {
    const tenant = await seedTenant(owner, `q-${randomUUID().slice(0, 6)}`);
    const record = await insertJudgmentRecord(owner, tenant);

    // enqueue（幂等：同 record+reason 只建一条）
    const first = await enqueueReviewTask(owner, tenant.workspaceId, {
      reason: "UNKNOWN",
      recordId: record.id,
      highValue: true,
    });
    assert.equal(first.created, true);
    const second = await enqueueReviewTask(owner, tenant.workspaceId, {
      reason: "UNKNOWN",
      recordId: record.id,
    });
    assert.equal(second.created, false);
    assert.equal(second.id, first.id);

    // list：P0（高价值 UNKNOWN）、公司名与判定可见
    const listed = await listReviewTasks(owner, tenant.workspaceId, { limit: 10 });
    assert.equal(listed.items.length, 1);
    assert.equal(listed.items[0].id, first.id);
    assert.equal(listed.items[0].priority, 0);
    assert.equal(listed.items[0].status, "queued");
    assert.equal(listed.items[0].verdictAtJudge, "UNKNOWN");
    assert.ok(listed.items[0].companyName.startsWith("Muster Metallbau"));

    // claim：queued → in_review；同人重复认领幂等；别人再认领冲突
    await claimReviewTask(owner, tenant.workspaceId, first.id, "reviewer-1");
    await claimReviewTask(owner, tenant.workspaceId, first.id, "reviewer-1");
    await assert.rejects(
      claimReviewTask(owner, tenant.workspaceId, first.id, "reviewer-2"),
      /cannot claim review task in status in_review/,
    );

    // resolve：写新 human record + golden label candidate + 任务 resolved
    const resolved = await resolveReviewTask(
      owner,
      tenant.workspaceId,
      first.id,
      {
        verdict: "NOT_FIT",
        note: "证据显示为竞品",
        criterionOverrides: [{ id: "C1_MATERIAL", score: 2, label: "fail" }],
      },
      "reviewer-1",
    );

    const humanRecord = await owner.judgmentRecord.findUnique({
      where: { id: resolved.recordId },
    });
    assert.equal(humanRecord.verdict, "NOT_FIT");
    assert.equal(humanRecord.modelRequested, "human");
    assert.equal(humanRecord.promptHash, HUMAN_PROMPT_HASH);
    assert.equal(humanRecord.attempt, 2);
    assert.equal(humanRecord.verdictProposed, "UNKNOWN");
    assert.equal(humanRecord.criteria[0].score, 2);
    assert.equal(humanRecord.criteria[0].label, "fail");

    const label = await owner.judgmentGoldenLabel.findUnique({
      where: { id: resolved.goldenLabelId },
    });
    assert.equal(label.label, "NOT_FIT");
    assert.equal(label.labelSource, "review");
    assert.equal(label.split, "candidate");
    assert.equal(label.reviewTaskId, first.id);

    const task = await owner.judgmentReviewTask.findUnique({ where: { id: first.id } });
    assert.equal(task.status, "resolved");
    assert.equal(task.resolvedVerdict, "NOT_FIT");
    assert.equal(task.resolvedBy, "reviewer-1");
    assert.equal(task.reflowedLabelId, resolved.goldenLabelId);

    // 重复 resolve 被状态机拒绝
    await assert.rejects(
      resolveReviewTask(
        owner,
        tenant.workspaceId,
        first.id,
        { verdict: "FIT" },
        "reviewer-1",
      ),
      /must be in_review/,
    );

    // 单条明细可读
    const detail = await getJudgment(owner, tenant.workspaceId, resolved.recordId);
    assert.equal(detail?.verdict, "NOT_FIT");

    // stats：resolved=1 且 human 结论与原判定不同 → overturn rate = 1
    const stats = await judgmentReviewStats(owner, tenant.workspaceId, 7);
    assert.equal(stats.byStatus.resolved, 1);
    assert.equal(stats.overturn.resolved, 1);
    assert.equal(stats.overturn.rate, 1);
  });

  it("跨租户隔离：另一个 workspace 看不到队列与判定", async () => {
    const a = await seedTenant(owner, `a-${randomUUID().slice(0, 6)}`);
    const b = await seedTenant(owner, `b-${randomUUID().slice(0, 6)}`);
    const recordA = await insertJudgmentRecord(owner, a, {
      inputDigest: digest(randomUUID().replaceAll("-", "").slice(0, 16)),
    });
    await enqueueReviewTask(owner, a.workspaceId, {
      reason: "BORDERLINE",
      recordId: recordA.id,
    });

    const listB = await listReviewTasks(owner, b.workspaceId, {});
    assert.equal(listB.items.length, 0);
    const detailB = await getJudgment(owner, b.workspaceId, recordA.id);
    assert.equal(detailB, null);
    await assert.rejects(
      enqueueReviewTask(owner, b.workspaceId, {
        reason: "APPEAL",
        recordId: recordA.id,
      }),
      /review task not found/,
    );
  });
});
