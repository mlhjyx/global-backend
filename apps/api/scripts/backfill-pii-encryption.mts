/**
 * 收口⑥ 存量 PII 加密回填（一次性数据迁移，必须在 PII 加密代码上线时/后立即跑）。
 * 把历史明文 canonical_contact.full_name / contact_point.value / field_evidence PII 副本加密为 enc:v1:，
 * 并把 **canonical_contact.dedupe_key 盲化为 bi:v1:**（收口⑥ PR #60 补丁：原文去重键 `e:<email>` /
 * `c:<companyKey>:<人名>` 含 PII，换成不可逆 HMAC 盲索引，去 PII 明文）。
 * 幂等：已加密/已盲化行跳过（isEncryptedPii / isBlindedContactKey）。确定性密文/盲值使唯一键成立。
 *
 * 🔴 盲化撞键合并（Codex PR #65 P1）：若新盲化写路径（createContact）已为**同一身份**先建了 `bi:v1:` 行，
 * 而 legacy 明文行（`e:`/`c:`）尚存，则盲化 legacy 行的 dedupe_key 会与既有 `bi:v1:` 行撞
 * `(workspace_id, dedupe_key)` 唯一键——bare update 会**崩掉整个迁移**并把 PII 明文键留在库里。故盲化前先探
 * 撞键：命中既有另一行则**合并** legacy 行进存活行（移 contact_point 保验证态 + 移 field_evidence + 删 legacy），
 * 而非 update。同租户两条**不同** legacy 明文键经确定性 HMAC 盲化后仍互异，故 legacy↔legacy 不撞（仅 legacy↔既有盲行会）。
 *
 * 🔴 验证态保全（#60 P2）：contact_point 去重（历史误 upsert 的密文 dup、或合并折叠同值点）删行前，
 * 把更强的验证态（VALID>RISKY>INVALID>UNVERIFIED，同级取更近 verifiedAt）折叠到保留行——绝不让
 * VALID/verifiedAt 因删重复行而丢失（reachability/评分靠它）。
 *
 * ⚠️ 未跑此回填则：新 upsert 的 where.value/dedupe_key 被加密/盲化后匹配不到旧明文行 → 造重复行 +
 * 旧明文 PII 永留库。故须与新代码上线同步跑（与既有 contact_point 回填同一运维步）。
 * 默认零写入：必须显式 `--verify-only` 或 `--apply`，并提供独立
 * PII_BACKFILL_* 授权环境变量；不读取 .env，也不回退 DATABASE_URL。
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  encryptPii,
  isEncryptedPii,
  blindContactKey,
  isBlindedContactKey,
} from "../src/compliance/pii-crypto";
import {
  encryptFieldEvidenceValue,
  isEncryptedFieldEvidenceValue,
} from "../src/compliance/pii-crypto.extension";
import {
  resolvePiiBackfillAuthorization,
  type PiiBackfillAuthorization,
} from "../src/compliance/pii-backfill-admission";
import { scrubSensitiveText } from "../src/common/sensitive-data-scrubber";
import { verifyPiiBackfillSourceIdentity } from "../src/compliance/pii-backfill-source-identity";

const PII_TYPES = ['email', 'phone', 'linkedin'];
export const PII_BACKFILL_TRANSACTION_TIMEOUT_MS = 15 * 60 * 1_000;
const REPOSITORY_ROOT = realpathSync(
  fileURLToPath(new URL('../../../', import.meta.url)),
);
type BackfillDatabase = PrismaClient | Prisma.TransactionClient;

/** 验证态强弱序：VALID（可达）> RISKY（探测存疑）> INVALID（探测为坏）> UNVERIFIED（从未探测）。 */
const STATUS_RANK: Record<string, number> = { VALID: 3, RISKY: 2, INVALID: 1, UNVERIFIED: 0 };

export interface BackfillCounts {
  names: number;
  dedupeKeys: number;
  merges: number;
  points: number;
  dedup: number;
  evidence: number;
  suppressions: number;
}

export interface PlaintextResidueCounts {
  names: number;
  dedupeKeys: number;
  points: number;
  evidence: number;
  suppressions: number;
}

export interface BackfillOutcome extends BackfillCounts {
  residue: PlaintextResidueCounts;
  actualBuildSha: string;
}

async function assertBackfillTarget(
  owner: BackfillDatabase,
  authorization: PiiBackfillAuthorization,
): Promise<void> {
  const databaseRows = await owner.$queryRawUnsafe<
    Array<{ databaseName: string }>
  >('SELECT current_database()::text AS "databaseName"');
  if (
    databaseRows.length !== 1 ||
    databaseRows[0].databaseName !== authorization.expectedDatabaseName
  ) {
    throw new Error("PII_BACKFILL_DATABASE_IDENTITY_MISMATCH");
  }
  const [contacts, points, evidence, suppressions] = await Promise.all([
    owner.canonicalContact.count(),
    owner.contactPoint.count({ where: { type: { in: PII_TYPES } } }),
    owner.fieldEvidence.count({
      where: { dataClass: { in: ["amber", "red"] } },
    }),
    owner.suppressionRecord.count({ where: { type: "email" } }),
  ]);
  if (contacts + points + evidence + suppressions > authorization.maxRows) {
    throw new Error("PII_BACKFILL_ROW_CAP_EXCEEDED");
  }
}

export async function scanPlaintextResidue(
  owner: BackfillDatabase,
): Promise<PlaintextResidueCounts> {
  const rows = await owner.$queryRawUnsafe<
    Array<{
      names: bigint;
      dedupeKeys: bigint;
      points: bigint;
      evidence: bigint;
      suppressions: bigint;
    }>
  >(`
    SELECT
      (SELECT count(*) FROM "canonical_contact"
        WHERE "full_name" NOT LIKE 'enc:v1:%')::bigint AS "names",
      (SELECT count(*) FROM "canonical_contact"
        WHERE "dedupe_key" NOT LIKE 'bi:v1:%')::bigint AS "dedupeKeys",
      (SELECT count(*) FROM "contact_point"
        WHERE "type" IN ('email', 'phone', 'linkedin')
          AND "value" NOT LIKE 'enc:v1:%')::bigint AS "points",
      (SELECT count(*) FROM "field_evidence"
        WHERE "data_class" IN ('amber', 'red')
          AND NOT (
            jsonb_typeof("value") = 'object'
            AND "value"->>'schemaVersion' = 'field-evidence-pii/v1'
            AND "value"->>'ciphertext' LIKE 'enc:v1:%'
          ))::bigint AS "evidence",
      (SELECT count(*) FROM "suppression_record"
        WHERE "type" = 'email'
          AND "value" NOT LIKE 'enc:v1:%')::bigint AS "suppressions"
  `);
  if (rows.length !== 1) throw new Error("PII_BACKFILL_RESIDUE_UNVERIFIED");
  const result = Object.fromEntries(
    Object.entries(rows[0]).map(([key, value]) => {
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error("PII_BACKFILL_RESIDUE_UNVERIFIED");
      }
      return [key, count];
    }),
  ) as unknown as PlaintextResidueCounts;
  return result;
}

async function verifyOnly(
  authorization: PiiBackfillAuthorization,
): Promise<{
  residue: PlaintextResidueCounts;
  actualBuildSha: string;
}> {
  const sourceIdentity = verifyPiiBackfillSourceIdentity({
    expectedBuildSha: authorization.expectedBuildSha,
    expectedRepositoryRoot: REPOSITORY_ROOT,
  });
  const owner = new PrismaClient({ datasourceUrl: authorization.databaseUrl });
  try {
    const residue = await owner.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          "SET LOCAL statement_timeout = '14min'",
        );
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
        await tx.$queryRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtextextended('global:pii-backfill:v1', 0))",
        );
        await assertBackfillTarget(tx, authorization);
        return scanPlaintextResidue(tx);
      },
      {
        maxWait: 5_000,
        timeout: PII_BACKFILL_TRANSACTION_TIMEOUT_MS,
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );
    return { residue, actualBuildSha: sourceIdentity.actualBuildSha };
  } finally {
    await owner.$disconnect();
  }
}

/**
 * 去重合并两条同一 (contact,type,value) 的 contact_point 时，保留行应写入的更强验证态（#60 P2）。
 * incoming 更强（或同级但 verifiedAt 更近）→ 返回要写到**保留行**的 {status, verifiedAt}；
 * 保留行已至少一样强 → 返回 null（免多余写，幂等）。
 */
function strongerVerification(
  kept: { status: string; verifiedAt: Date | null },
  incoming: { status: string; verifiedAt: Date | null },
): { status: string; verifiedAt: Date | null } | null {
  const rk = STATUS_RANK[kept.status] ?? 0;
  const ri = STATUS_RANK[incoming.status] ?? 0;
  if (ri > rk) return { status: incoming.status, verifiedAt: incoming.verifiedAt };
  if (ri === rk) {
    const iv = incoming.verifiedAt?.getTime() ?? -1;
    const kv = kept.verifiedAt?.getTime() ?? -1;
    if (iv > kv) return { status: kept.status, verifiedAt: incoming.verifiedAt };
  }
  return null;
}

/** contact_point 归一键：PII 类型按确定性密文比对（跨明文/密文识同一值），其余按原值。 */
function pointNormKey(pt: { type: string; value: string }): string {
  const v = PII_TYPES.includes(pt.type) ? encryptPii(pt.value) : pt.value;
  return `${pt.type} ${v}`;
}

/**
 * 把 legacy 联系人 fromId **合并进**存活联系人 toId（盲化撞唯一键时走此路，替代会崩迁移的 bare update）：
 *  - contact_point 逐点移交：目标已有等价点（归一密文相同）→ 折叠更强验证态到保留点再删本点（#60 P2）；
 *    否则改挂 contactId 到 toId（归一不同 ⟹ (contactId,type,value) 唯一键必不冲突）。折叠后**回写 toByKey**：
 *    防同一 legacy 的另一同值点（明文+密文并存）据陈旧态把已折叠的更强验证态降级。
 *  - 标量字段 title/seniority/department **有则补空**到 survivor（绝不覆盖已有非空，照 contact-persist.mergeIntoContact
 *    的不可变合并语义，迁移不静默丢失职务元数据；full_name 非空必填且已在 survivor，无需补）。
 *  - field_evidence（entityType=contact）改挂到 toId（无 FK，手动迁移防孤儿；append-only 审计，同既有写路径不跨行去重）。
 *  - 无 contact 型 identity_link（写路径仅建 company 型）⟹ 无需迁移。
 *  - 最后硬删 fromId（其 contact_point 已全部移走/删除）。
 */
async function mergeContactInto(owner: BackfillDatabase, fromId: string, toId: string): Promise<void> {
  const [fromPoints, toPoints, from, to] = await Promise.all([
    owner.contactPoint.findMany({ where: { contactId: fromId } }),
    owner.contactPoint.findMany({ where: { contactId: toId } }),
    owner.canonicalContact.findUnique({ where: { id: fromId }, select: { title: true, seniority: true, department: true } }),
    owner.canonicalContact.findUnique({ where: { id: toId }, select: { title: true, seniority: true, department: true } }),
  ]);
  const toByKey = new Map(toPoints.map((pt) => [pointNormKey(pt), pt]));
  for (const fp of fromPoints) {
    const key = pointNormKey(fp);
    const match = toByKey.get(key);
    if (match) {
      const upd = strongerVerification(match, fp);
      if (upd) {
        await owner.contactPoint.update({ where: { id: match.id }, data: upd });
        // 回写 map：后续同键点按**已折叠**的态比较，杜绝陈旧态降级（如先折 VALID、再来 RISKY 覆盖）。
        toByKey.set(key, { ...match, status: upd.status, verifiedAt: upd.verifiedAt });
      }
      await owner.contactPoint.delete({ where: { id: fp.id } });
    } else {
      await owner.contactPoint.update({ where: { id: fp.id }, data: { contactId: toId } });
      toByKey.set(key, { ...fp, contactId: toId });
    }
  }
  // 标量字段有则补空（不覆盖 survivor 已有非空）——迁移合并不丢职务元数据。
  const patch: { title?: string; seniority?: string; department?: string } = {};
  if (from?.title && !to?.title) patch.title = from.title;
  if (from?.seniority && !to?.seniority) patch.seniority = from.seniority;
  if (from?.department && !to?.department) patch.department = from.department;
  if (Object.keys(patch).length > 0) await owner.canonicalContact.update({ where: { id: toId }, data: patch });
  await owner.fieldEvidence.updateMany({
    where: { entityType: 'contact', entityId: fromId },
    data: { entityId: toId },
  });
  await owner.canonicalContact.delete({ where: { id: fromId } });
}

async function executeBackfill(
  owner: Prisma.TransactionClient,
  authorization: PiiBackfillAuthorization,
): Promise<Omit<BackfillOutcome, 'actualBuildSha'>> {
  let names = 0;
  let dedupeKeys = 0;
  let merges = 0;
  let points = 0;
  let dedup = 0;
  let evidence = 0;
  let suppressions = 0;

  await assertBackfillTarget(owner, authorization);
    // 1. canonical_contact：full_name 加密 + dedupe_key 盲化（一次遍历，各自幂等）。
    //    盲化前探撞键：命中既有另一（盲化）行 → 合并本 legacy 行进去（不 update 崩迁移，见文件头）。
    const contacts = await owner.canonicalContact.findMany({
      select: { id: true, workspaceId: true, fullName: true, dedupeKey: true },
    });
    for (const c of contacts) {
      const needName = !isEncryptedPii(c.fullName);
      const needKey = !isBlindedContactKey(c.dedupeKey);
      if (!needName && !needKey) continue; // 两者都已处理 → 跳过（幂等重跑）

      if (needKey) {
        const blinded = blindContactKey(c.dedupeKey);
        // 盲值是否已被**另一**联系人占用（新写路径先建的同一身份 bi:v1: 行）？
        const survivor = await owner.canonicalContact.findFirst({
          where: { workspaceId: c.workspaceId, dedupeKey: blinded, NOT: { id: c.id } },
          select: { id: true },
        });
        if (survivor) {
          await mergeContactInto(owner, c.id, survivor.id);
          merges++;
          continue; // 本行已删；full_name 加密由 survivor 自身遍历处理
        }
      }

      const data: { fullName?: string; dedupeKey?: string } = {};
      if (needName) data.fullName = encryptPii(c.fullName);
      if (needKey) data.dedupeKey = blindContactKey(c.dedupeKey);
      await owner.canonicalContact.update({ where: { id: c.id }, data });
      if (data.fullName) names++;
      if (data.dedupeKey) dedupeKeys++;
    }

    // 2. contact_point.value（PII 类型；确定性密文 → 冲突则删明文消重，删前保全更强验证态）。
    const pts = await owner.contactPoint.findMany({
      where: { type: { in: PII_TYPES } },
      select: { id: true, contactId: true, type: true, value: true, status: true, verifiedAt: true },
    });
    for (const p of pts) {
      if (isEncryptedPii(p.value)) continue;
      const ct = encryptPii(p.value);
      const existing = await owner.contactPoint.findFirst({
        where: { contactId: p.contactId, type: p.type, value: ct },
        select: { id: true, status: true, verifiedAt: true },
      });
      if (existing && existing.id !== p.id) {
        // #60 P2：删明文重复行前，把其更强验证态折叠到保留（密文）行——VALID/verifiedAt 绝不因删重丢分。
        const upd = strongerVerification(existing, p);
        if (upd) await owner.contactPoint.update({ where: { id: existing.id }, data: upd });
        await owner.contactPoint.delete({ where: { id: p.id } });
        dedup++;
      } else {
        await owner.contactPoint.update({ where: { id: p.id }, data: { value: ct } });
        points++;
      }
    }

    // 3. All amber/red FieldEvidence values use the same versioned envelope as
    // the runtime writer. Existing manually encrypted nested values are wrapped
    // as-is; no plaintext JSON remains after the final residue scan.
    const sensitiveEvidence = await owner.fieldEvidence.findMany({
      where: { dataClass: { in: ["amber", "red"] } },
      select: { id: true, value: true },
    });
    for (const row of sensitiveEvidence) {
      if (isEncryptedFieldEvidenceValue(row.value)) continue;
      await owner.fieldEvidence.update({
        where: { id: row.id },
        data: { value: encryptFieldEvidenceValue(row.value) },
      });
      evidence++;
    }

    // 4. Suppression email values remain queryable through deterministic
    // encryption while no longer persisting the address in plaintext. A
    // ciphertext collision is not auto-merged because the two append-only
    // records may encode different legal reasons or review histories.
    const emailSuppressions = await owner.suppressionRecord.findMany({
      where: { type: "email" },
      select: { id: true, workspaceId: true, value: true },
    });
    for (const row of emailSuppressions) {
      if (isEncryptedPii(row.value)) continue;
      const encryptedValue = encryptPii(row.value);
      const collision = await owner.suppressionRecord.findUnique({
        where: {
          workspaceId_type_value: {
            workspaceId: row.workspaceId,
            type: "email",
            value: encryptedValue,
          },
        },
        select: { id: true },
      });
      if (collision && collision.id !== row.id) {
        throw new Error("PII_BACKFILL_SUPPRESSION_COLLISION");
      }
      await owner.suppressionRecord.update({
        where: { id: row.id },
        data: { value: encryptedValue },
      });
      suppressions++;
    }

  const residue = await scanPlaintextResidue(owner);
  return {
    names,
    dedupeKeys,
    merges,
    points,
    dedup,
    evidence,
    suppressions,
    residue,
  };
}

export async function runBackfill(
  authorization: PiiBackfillAuthorization,
): Promise<BackfillOutcome> {
  if (authorization.mode !== "APPLY") {
    throw new Error("PII_BACKFILL_APPLY_AUTHORIZATION_REQUIRED");
  }
  if (!process.env.PII_ENCRYPTION_KEY) {
    throw new Error("PII_ENCRYPTION_KEY 未配置——无法回填");
  }
  const sourceIdentity = verifyPiiBackfillSourceIdentity({
    expectedBuildSha: authorization.expectedBuildSha,
    expectedRepositoryRoot: REPOSITORY_ROOT,
  });
  // Raw owner client (no PII extension). The exact clean source identity is
  // verified before this client is constructed or any network connection can
  // begin.
  const owner = new PrismaClient({ datasourceUrl: authorization.databaseUrl });
  try {
    const result = await owner.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          "SET LOCAL statement_timeout = '14min'",
        );
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '5s'");
        await tx.$queryRawUnsafe(
          "SELECT pg_advisory_xact_lock(hashtextextended('global:pii-backfill:v1', 0))",
        );
        return executeBackfill(tx, authorization);
      },
      {
        maxWait: 5_000,
        timeout: PII_BACKFILL_TRANSACTION_TIMEOUT_MS,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
    return { ...result, actualBuildSha: sourceIdentity.actualBuildSha };
  } finally {
    await owner.$disconnect();
  }
}

async function main(): Promise<void> {
  const authorization = resolvePiiBackfillAuthorization(
    process.argv.slice(2),
    process.env,
  );
  const completed =
    authorization.mode === "APPLY"
      ? await runBackfill(authorization)
      : await verifyOnly(authorization);
  const { actualBuildSha, ...result } = completed;
  const report = {
    schemaVersion: "pii-backfill-receipt/v1",
    authorizationId: authorization.authorizationId,
    mode: authorization.mode,
    expectedDatabaseName: authorization.expectedDatabaseName,
    expectedBuildSha: authorization.expectedBuildSha,
    actualBuildSha,
    verifiedAt: new Date().toISOString(),
    result,
  };
  const artifactDigest = createHash("sha256")
    .update(JSON.stringify(report))
    .digest("hex");
  console.log(JSON.stringify({ ...report, artifactDigest }));
  const residue = result.residue;
  if (Object.values(residue).some((count) => count !== 0)) {
    throw new Error("PII_BACKFILL_PLAINTEXT_RESIDUE_REMAINS");
  }
}

// 直接执行才跑（被 verify 脚本 import 时不自动触发全表迁移）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(scrubSensitiveText(String(e), { maxLength: 500 }));
    process.exit(1);
  });
}
