import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { PrismaClient } from "@prisma/client";

import {
  JudgmentRecordReplayConflictError,
  judgmentInputDigest,
  judgmentOutputDigest,
  recordJudgment,
} from "../../../apps/api/src/discovery/judgment/judgment-record";

/**
 * P3 J06 判定记录写入器的库上语义（service 组，迁移后的一次性库）：
 * 新写入一尝试一行；同 attempt 重试命中 replay key 不翻行；同输入不同 verdict
 * 抛冲突；不同 attempt 正常追加。append-only/RLS 权限面由 J04 的
 * app-user-table-privileges spec 覆盖，这里验证写入器编排。
 */

const OWNER_URL = process.env.DATABASE_URL;

function client(url) {
  return new PrismaClient({ datasources: { db: { url } } });
}

function sha(seed) {
  return createHash("sha256").update(seed).digest("hex");
}

async function seedTenant(owner, suffix) {
  const workspaceId = randomUUID();
  await owner.workspace.create({ data: { id: workspaceId, name: `j06 ${suffix}` } });
  const seller = await owner.companyProfile.create({
    data: { workspaceId, name: `Seller ${suffix}` },
  });
  const company = await owner.canonicalCompany.create({
    data: {
      workspaceId,
      name: `Muster Metallbau ${suffix}`,
      domain: `j06-${suffix}.example`,
      dedupeKey: `domain:j06-${suffix}.example`,
    },
  });
  const icp = await owner.icpDefinition.create({
    data: { workspaceId, companyId: seller.id, name: `ICP ${suffix}` },
  });
  return { workspaceId, companyId: company.id, icpId: icp.id };
}

function criteria(score = 8) {
  return [
    { id: "C1_MATERIAL", applicable: true, score, label: "pass", evidence: [], rationale: "ok" },
    { id: "C2_ROLE", applicable: true, score, label: "pass", evidence: [], rationale: "ok" },
    { id: "C3_PROCESS", applicable: true, score, label: "pass", evidence: [], rationale: "ok" },
    { id: "C4_BUSINESS_MODEL", applicable: true, score, label: "pass", evidence: [], rationale: "ok" },
    { id: "C5_SIZE", applicable: false, score: null, label: "not_applicable", evidence: [], rationale: "n/a" },
  ];
}

function recordInput(tenant, overrides = {}) {
  const baseCriteria = overrides.criteria ?? criteria();
  return {
    workspaceId: tenant.workspaceId,
    companyId: tenant.companyId,
    icpId: tenant.icpId,
    judgeLevel: 2,
    verdict: "FIT",
    criteria: baseCriteria,
    evidenceCompleteness: true,
    inputDigest: overrides.inputDigest ?? judgmentInputDigest({ tenant: tenant.workspaceId }),
    outputDigest: judgmentOutputDigest(baseCriteria),
    promptHash: sha("prompt"),
    model: { requested: "deepseek-v4-pro", resolved: "deepseek-v4-pro" },
    sampling: { temperature: 0.7, k: 3 },
    latencyMs: 8500,
    inputTokens: 1888,
    outputTokens: 1317,
    costMicros: 9900n,
    attempt: overrides.attempt ?? 1,
    ...(overrides.verdict ? { verdict: overrides.verdict } : {}),
  };
}

async function withWorkspace(owner, workspaceId, fn) {
  return owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_workspace_id', ${workspaceId}, true)`;
    return fn(tx);
  });
}

describe("judgment_record writer lifecycle (P3 J06)", () => {
  let owner;

  before(async () => {
    assert.ok(OWNER_URL, "DATABASE_URL is required");
    owner = client(OWNER_URL);
    await owner.$queryRaw`SELECT 1`;
  });

  after(async () => {
    await owner?.$disconnect();
  });

  it("新写入一尝试一行 → 同 attempt 重试不翻行 → 冲突 verdict 抛错 → 新 attempt 追加", async () => {
    const tenant = await seedTenant(owner, randomUUID().slice(0, 6));
    const input = recordInput(tenant);

    const first = await withWorkspace(owner, tenant.workspaceId, (tx) =>
      recordJudgment(tx, input),
    );
    assert.equal(first.replayed, false);

    const replay = await withWorkspace(owner, tenant.workspaceId, (tx) =>
      recordJudgment(tx, input),
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.recordId, first.recordId);

    const rows = await owner.judgmentRecord.findMany({
      where: { workspaceId: tenant.workspaceId },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].modelRequested, "deepseek-v4-pro");
    assert.equal(rows[0].costMicros, 9900n);
    assert.equal(rows[0].stage, null);

    await assert.rejects(
      withWorkspace(owner, tenant.workspaceId, (tx) =>
        recordJudgment(tx, { ...input, verdict: "NOT_FIT" }),
      ),
      JudgmentRecordReplayConflictError,
    );

    const nextAttempt = await withWorkspace(owner, tenant.workspaceId, (tx) =>
      recordJudgment(tx, { ...input, attempt: 2, verdict: "NOT_FIT" }),
    );
    assert.equal(nextAttempt.replayed, false);
    const afterRows = await owner.judgmentRecord.findMany({
      where: { workspaceId: tenant.workspaceId },
      orderBy: { attempt: "asc" },
    });
    assert.equal(afterRows.length, 2);
    assert.deepEqual(afterRows.map((row) => row.verdict), ["FIT", "NOT_FIT"]);
  });

  it("失败码会派生 stage/outcome/retryable 列", async () => {
    const tenant = await seedTenant(owner, randomUUID().slice(0, 6));
    const base = recordInput(tenant);
    await withWorkspace(owner, tenant.workspaceId, (tx) =>
      recordJudgment(tx, {
        ...base,
        verdict: "UNKNOWN",
        failure: { code: "PROVIDER_HTTP_429" },
      }),
    );
    const row = await owner.judgmentRecord.findFirst({
      where: { workspaceId: tenant.workspaceId },
    });
    assert.equal(row.failureCode, "PROVIDER_HTTP_429");
    assert.equal(row.stage, "provider");
    assert.equal(row.outcome, "retry");
    assert.equal(row.retryable, true);
  });
});
