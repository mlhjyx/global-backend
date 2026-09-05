import * as fs from "node:fs";
import * as path from "node:path";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import {
  DELETION_RULE_VERSION,
  buildDeletionCompletedPayload,
  classifyDeletionCompleted,
  countsFromLocated,
} from "./deletion-snapshot";
import { ErasureCounts, LocatedErasureTargets } from "./deletion.types";

function deletionCompletedSchemaPath(): string {
  return path.resolve(
    __dirname,
    "../../../../packages/contracts/events/payloads/deletion-completed.v1.schema.json",
  );
}

function deletionCompletedValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(
    JSON.parse(fs.readFileSync(deletionCompletedSchemaPath(), "utf8")),
  );
}

const zero: ErasureCounts = {
  contactsErased: 0,
  contactPointsErased: 0,
  fieldEvidenceErased: 0,
  signalsRevoked: 0,
  companiesSuppressed: 0,
  leadsRescoreRequested: 0,
};

function schemaPayload(patentCacheErased?: number) {
  return buildDeletionCompletedPayload({
    deletionRequestId: "11111111-1111-4111-8111-111111111111",
    subjectType: "contact",
    subjectId: "22222222-2222-4222-8222-222222222222",
    counts: { ...zero, patentCacheErased },
    erasedAt: "2026-09-05T12:00:00.000Z",
  });
}

const located: LocatedErasureTargets = {
  subjectType: "company",
  subjectId: "c1",
  contactIds: ["a", "b"],
  contactPointsCount: 5,
  fieldEvidenceCount: 7,
  companyIdsToSuppress: ["c1"],
  signalsToRevoke: 0,
  affectedIcpIds: ["i1", "i2"],
};

describe("deletion-snapshot", () => {
  it("validates the real builder payload against the strict v1 event schema", () => {
    const validate = deletionCompletedValidator();
    const payload = schemaPayload();

    expect(payload.patent_cache_erased).toBe(0);
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
  });

  it("accepts positive patent-cache counts and historical v1 payloads without the optional field", () => {
    const validate = deletionCompletedValidator();
    const payload = schemaPayload(3);
    const legacyPayload = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== "patent_cache_erased"),
    );

    expect(payload.patent_cache_erased).toBe(3);
    expect(validate(payload), JSON.stringify(validate.errors)).toBe(true);
    expect(validate(legacyPayload), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([-1, 1.5])(
    "rejects patent-cache erasure count %s because it is not a non-negative integer",
    (patentCacheErased) => {
      const validate = deletionCompletedValidator();
      expect(validate(schemaPayload(patentCacheErased))).toBe(false);
    },
  );

  it.each([
    ["an unknown count field", { unexpected_count: 1 }],
    ["a PII-shaped email field", { email: "not-personal@example.invalid" }],
  ])("rejects %s under the closed v1 payload shape", (_label, extra) => {
    const validate = deletionCompletedValidator();
    expect(validate({ ...schemaPayload(0), ...extra })).toBe(false);
  });

  it("derives counts from the located snapshot", () => {
    expect(countsFromLocated(located)).toEqual({
      contactsErased: 2,
      contactPointsErased: 5,
      fieldEvidenceErased: 7,
      signalsRevoked: 0,
      companiesSuppressed: 1,
      leadsRescoreRequested: 2,
    });
  });

  it("builds a minimized payload with only counts + refs — no PII keys", () => {
    const p = buildDeletionCompletedPayload({
      deletionRequestId: "req1",
      subjectType: "contact",
      subjectId: "subj1",
      counts: countsFromLocated(located),
      erasedAt: "2026-07-11T00:00:00.000Z",
    });
    expect(p.snapshot_version).toBe(1);
    expect(p.deletion_request_id).toBe("req1");
    expect(p.subject_type).toBe("contact");
    expect(p.subject_ref).toBe("subj1");
    expect(p.contacts_erased).toBe(2);
    expect(p.signals_revoked).toBe(0);
    expect(p.rule_version).toBe(DELETION_RULE_VERSION);
    expect(p.erased_at).toBe("2026-07-11T00:00:00.000Z");
    // 🔴 内容最小化：payload 键里绝不出现 name/email/value/full 之类 PII 字段名
    expect(Object.keys(p).join(",")).not.toMatch(/name|email|value|full/i);
  });

  it("专利缓存擦除计数流入 payload（Art.17 审计链补齐，scale-safe #89）", () => {
    const p = buildDeletionCompletedPayload({
      deletionRequestId: "req1",
      subjectType: "contact",
      subjectId: "subj1",
      counts: { ...zero, contactsErased: 1, patentCacheErased: 3 },
      erasedAt: "2026-07-11T00:00:00.000Z",
    });
    expect(p.patent_cache_erased).toBe(3);
  });

  it("counts 无 patentCacheErased（located 回退）→ payload patent_cache_erased 缺省 0", () => {
    const p = buildDeletionCompletedPayload({
      deletionRequestId: "req1",
      subjectType: "contact",
      subjectId: "subj1",
      counts: countsFromLocated(located),
      erasedAt: "2026-07-11T00:00:00.000Z",
    });
    expect(p.patent_cache_erased).toBe(0);
  });

  it("classifies erasure touching a named person as RESTRICTED, else CONFIDENTIAL", () => {
    expect(classifyDeletionCompleted({ ...zero, contactsErased: 1 })).toBe(
      "RESTRICTED",
    );
    expect(classifyDeletionCompleted({ ...zero, companiesSuppressed: 1 })).toBe(
      "CONFIDENTIAL",
    );
    expect(classifyDeletionCompleted(zero)).toBe("CONFIDENTIAL");
  });
});
