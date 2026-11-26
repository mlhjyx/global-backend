import { normalizeEnrichedEmail as originalNormalizeEnrichedEmail } from "../../../enrichment/finders/email-enrichment-provider";
import { GenericOperationArtifactExecution } from "../generic-operation-artifact.execution";
import type { PersistGenericOperationArtifactInput } from "../generic-operation-artifact.service";
import type { Tool } from "../../../tools/tool-contract";
import type { BudgetReservation } from "../../../tools/budget-store";
import type { DurableExecutionReceipt } from "../../durable-execution-receipt";
import {
  parseArtifactExpectedFactsForResultSchema,
  artifactExpectedFactsColumns,
  parseArtifactExpectedFactsColumns,
} from "../artifact-expected-facts";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { PII_PURPOSE, encryptPii, decryptPii } from "../../../compliance/pii-crypto";

const TEST_WS = "00000000-0000-4000-8000-000000000002";
import { contentAddressedObjectKey } from "../artifact-key";
import type { GenericOperationArtifactManifest } from "../artifact.types";
import {
  CONTACT_EMAIL_FIND_HUNTER_SCHEMA as SCHEMA,
  parseContactEmailFindPayload,
  serializeContactEmailFindPayload,
  decodeContactEmailFindBody,
  createContactEmailFindMaterializer,
} from "./contact-email-find.materializer";
const hit = () => ({
  status: "hit",
  email: "person@synthetic.example.invalid",
  providerConfidence: 95,
  acceptAll: false,
  pattern: "{first}.{last}",
  reason: "candidate_found",
});
const miss = () => ({
  status: "miss",
  email: null,
  providerConfidence: null,
  acceptAll: null,
  pattern: null,
  reason: "no_match",
});
function manifest(
  body: string,
  changes: Partial<GenericOperationArtifactManifest> = {},
): GenericOperationArtifactManifest {
  const sha256 = createHash("sha256").update(body).digest("hex");
  return {
    schemaVersion: "generic-operation-artifact/v1",
    artifactId: "00000000-0000-4000-8000-000000000001",
    scopeKind: "workspace",
    workspaceId: "00000000-0000-4000-8000-000000000002",
    authorityId: "00000000-0000-4000-8000-000000000003",
    operationId: "00000000-0000-4000-8000-000000000004",
    resultSchema: SCHEMA,
    objectKey: contentAddressedObjectKey(sha256, "PERSONAL_DATA", {
      scopeKind: "workspace",
      workspaceId: "00000000-0000-4000-8000-000000000002",
    }),
    sha256,
    sizeBytes: String(Buffer.byteLength(body)),
    mediaType: "application/octet-stream",
    privacyClass: "PERSONAL_DATA",
    sourceDigest: null,
    createdAt: "2026-11-22T00:00:00.000Z",
    expiresAt: "2026-11-23T00:00:00.000Z",
    ...changes,
  };
}
async function* stream(body: string) {
  yield Buffer.from(body);
}
describe("closed encrypted Hunter payload, explicit test key and fake bounded-reader port", () => {
  it.each([hit(), miss()])(
    "accepts only a closed normalized hit/miss %#",
    (payload) => {
      const parsed = parseContactEmailFindPayload(payload);
      expect(parsed).toEqual(payload);
      expect(Object.isFrozen(parsed)).toBe(true);
    },
  );
  it("encrypts via existing PII crypto and decodes only the explicit ciphertext path", () => {
    const body = serializeContactEmailFindPayload(hit(), TEST_WS);
    expect(body.startsWith("enc:v2:k1:")).toBe(true);
    expect(body).not.toContain("person@");
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16384);
    expect(JSON.parse(decryptPii(body, { workspaceId: TEST_WS, purpose: PII_PURPOSE.CONTACT_EMAIL_FIND_PAYLOAD }))).toEqual(hit());
    expect(decodeContactEmailFindBody(body, TEST_WS)).toEqual(hit());
  });
  it("refuses plaintext passthrough both in default crypto and even when migration plaintext read is enabled", () => {
    expect(() =>
      decryptPii(JSON.stringify(hit()), { workspaceId: TEST_WS, purpose: PII_PURPOSE.CONTACT_EMAIL_FIND_PAYLOAD }),
    ).toThrow(/PII_PLAINTEXT_FALLBACK_FORBIDDEN/);
    const prevAllow = process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ;
    try {
      process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ = "true";
      expect(
        decryptPii(JSON.stringify(hit()), { workspaceId: TEST_WS, purpose: PII_PURPOSE.CONTACT_EMAIL_FIND_PAYLOAD }),
      ).toBe(JSON.stringify(hit()));
      expect(() => decodeContactEmailFindBody(JSON.stringify(hit()), TEST_WS)).toThrow();
    } finally {
      if (prevAllow === undefined) delete process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ;
      else process.env.PII_ALLOW_LEGACY_PLAINTEXT_READ = prevAllow;
    }
  });
  it.each([
    { ...hit(), status: "error" },
    { ...hit(), raw: { email: "PII" } },
    { ...hit(), providerConfidence: 101 },
    { ...hit(), pattern: "x".repeat(257) },
    { ...hit(), email: "invalid" },
    { ...hit(), email: " Person@Synthetic.Example.Invalid " },
    { ...miss(), email: "person@synthetic.example.invalid" },
    { ...hit(), reason: "arbitrary vendor detail" },
  ])("rejects noncanonical or out-of-contract body %#", (payload) =>
    expect(() => parseContactEmailFindPayload(payload)).toThrow(),
  );
  it("rejects getters before executing payload code", () => {
    const p = hit();
    let calls = 0;
    Object.defineProperty(p, "email", {
      enumerable: true,
      get() {
        calls += 1;
        return hit().email;
      },
    });
    expect(() => parseContactEmailFindPayload(p)).toThrow();
    expect(calls).toBe(0);
  });
  it("holds missing/wrong key and ciphertext tamper rather than returning plaintext", () => {
    const body = encryptPii(JSON.stringify(hit()), { workspaceId: TEST_WS, purpose: PII_PURPOSE.CONTACT_EMAIL_FIND_PAYLOAD });
    const keyring = process.env.PII_KEYRING_JSON;
    const key = process.env.PII_ENCRYPTION_KEY;
    delete process.env.PII_KEYRING_JSON;
    delete process.env.PII_ENCRYPTION_KEY;
    try {
      expect(() => decodeContactEmailFindBody(body, TEST_WS)).toThrow();
      expect(() => serializeContactEmailFindPayload(hit(), TEST_WS)).toThrow();
      process.env.PII_KEYRING_JSON = JSON.stringify({ activeKeyId: "k1", keys: { k1: "1".repeat(64) } });
      expect(() => decodeContactEmailFindBody(body, TEST_WS)).toThrow();
    } finally {
      if (keyring === undefined) delete process.env.PII_KEYRING_JSON;
      else process.env.PII_KEYRING_JSON = keyring;
      if (key === undefined) delete process.env.PII_ENCRYPTION_KEY;
      else process.env.PII_ENCRYPTION_KEY = key;
    }
    const parts = body.split(":");
    const raw = Buffer.from(parts[5]!, "base64");
    raw[raw.length - 1] ^= 1;
    parts[5] = raw.toString("base64");
    expect(() =>
      decodeContactEmailFindBody(parts.join(":"), TEST_WS),
    ).toThrow();
    expect(() =>
      decodeContactEmailFindBody(body, "00000000-0000-4000-8000-000000000099"),
    ).toThrow();
  });
  it("materializes only ciphertext after the bounded-reader port, not a real S3/SQL/hash proof", async () => {
    const body = encryptPii(JSON.stringify(hit()), { workspaceId: TEST_WS, purpose: PII_PURPOSE.CONTACT_EMAIL_FIND_PAYLOAD });
    const readBounded = vi.fn(async (input: AsyncIterable<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      for await (const c of input) chunks.push(c);
      return Buffer.concat(chunks).toString("utf8");
    });
    const materializer = createContactEmailFindMaterializer({
      readBounded,
      now: () => new Date("2026-11-22T12:00:00.000Z"),
    });
    expect(materializer.resultSchema).toBe(SCHEMA);
    await expect(
      materializer.materialize(stream(body), manifest(body), undefined),
    ).resolves.toEqual(hit());
    expect(readBounded).toHaveBeenCalledTimes(1);
  });
  it.each([
    { resultSchema: "http-get/v1" },
    { mediaType: "text/plain" },
    { privacyClass: "PUBLIC_ORGANIZATION" as const },
    { scopeKind: "platform" as const, workspaceId: null },
    { expiresAt: "2020-01-01T00:00:00.000Z" },
    { sizeBytes: "16385" },
  ])(
    "holds wrong scope/schema/media/retention/size before decrypt %#",
    async (changes) => {
      const body = encryptPii(JSON.stringify(hit()), { workspaceId: TEST_WS, purpose: PII_PURPOSE.CONTACT_EMAIL_FIND_PAYLOAD });
      const readBounded = vi.fn(async () => body);
      const materializer = createContactEmailFindMaterializer({
        readBounded,
        now: () => new Date("2026-11-22T12:00:00.000Z"),
      });
      await expect(
        materializer.materialize(
          stream(body),
          manifest(body, changes),
          undefined,
        ),
      ).rejects.toThrow();
      expect(readBounded).not.toHaveBeenCalled();
    },
  );
  it("does not accept invented HTTP facts for the encrypted finder schema", async () => {
    const body = encryptPii(JSON.stringify(hit()), { workspaceId: TEST_WS, purpose: PII_PURPOSE.CONTACT_EMAIL_FIND_PAYLOAD });
    const readBounded = vi.fn(async () => body);
    const materializer = createContactEmailFindMaterializer({
      readBounded,
      now: () => new Date("2026-11-22T12:00:00.000Z"),
    });
    await expect(
      materializer.materialize(stream(body), manifest(body), { status: 200 }),
    ).rejects.toThrow();
    expect(readBounded).not.toHaveBeenCalled();
  });
});

const noHttpFacts = {
  expectedHttpStatus: null,
  expectedHttpOk: null,
  expectedSanitizedUrl: null,
  expectedContentHash: null,
  expectedBlockedCode: null,
  expectedRobotsBlocked: null,
};
describe("exact encrypted finder facts branch, not a wildcard schema allowance", () => {
  it("requires undefined facts and all six persisted HTTP columns NULL for the fixed Hunter schema", () => {
    expect(
      parseArtifactExpectedFactsForResultSchema(SCHEMA, undefined),
    ).toBeUndefined();
    expect(artifactExpectedFactsColumns(SCHEMA, undefined)).toEqual(
      noHttpFacts,
    );
    expect(
      parseArtifactExpectedFactsColumns(SCHEMA, noHttpFacts),
    ).toBeUndefined();
    expect(() =>
      parseArtifactExpectedFactsForResultSchema(SCHEMA, {}),
    ).toThrow();
  });
  it.each(Object.keys(noHttpFacts))(
    "rejects non-NULL persisted HTTP fact %s",
    (key) =>
      expect(() =>
        parseArtifactExpectedFactsColumns(SCHEMA, {
          ...noHttpFacts,
          [key]: key === "expectedHttpOk" ? true : 1,
        }),
      ).toThrow(),
  );
  it("does not extend the undefined-facts exception to arbitrary schemas", () => {
    expect(() =>
      parseArtifactExpectedFactsForResultSchema(
        "unregistered-finder/v1",
        undefined,
      ),
    ).toThrow();
    expect(() =>
      parseArtifactExpectedFactsColumns("unregistered-finder/v1", noHttpFacts),
    ).toThrow();
  });
});

it("requires the complete exact six-NULL column record, not an empty or extra-key object", () => {
  expect(() =>
    parseArtifactExpectedFactsColumns(SCHEMA, {} as never),
  ).toThrow();
  expect(() =>
    parseArtifactExpectedFactsColumns(SCHEMA, {
      ...noHttpFacts,
      extra: null,
    } as never),
  ).toThrow();
});

function artifactExecutionPorts() {
  const W = "00000000-0000-4000-8000-000000000002",
    A = "00000000-0000-4000-8000-000000000003",
    OP = "00000000-0000-4000-8000-000000000004",
    CONTACT = "00000000-0000-4000-8000-000000000005";
  const records: Array<
    PersistGenericOperationArtifactInput & {
      bytes: Buffer;
      manifest: GenericOperationArtifactManifest;
    }
  > = [];
  const reservation: BudgetReservation = {
    workspaceId: W,
    accountKey: "original-account-key",
    operationId: OP,
    estimatedMicrousd: 1780n,
    authorityId: A,
    replay: false,
  };
  const tool = {
    id: "contact_email.find.hunter",
    durableResultStrategy: {
      kind: "artifact_reference",
      schema: SCHEMA,
      maxBytes: 16384,
      mediaTypes: ["application/octet-stream"],
      privacyClass: "PERSONAL_DATA",
      ttlSeconds: 3600,
    },
  } as Tool;
  const receipt = (
    m: GenericOperationArtifactManifest,
  ): DurableExecutionReceipt => ({
    schemaVersion: "durable-execution-receipt/v1",
    scopeKey: W,
    authorityId: A,
    accountId: "00000000-0000-4000-8000-000000000006",
    operationId: OP,
    operationKey: "original-operation-key",
    resultStrategy: "artifact_reference",
    resultSchema: SCHEMA,
    resultDigest: m.sha256,
    artifactId: m.artifactId,
    usage: {
      currency: "USD",
      unit: "microusd",
      callCount: 1,
      upperBoundMicrousd: "1780",
    },
    costBasis: "estimated_upper_bound",
    status: "SETTLED",
  });
  const reference = (m: GenericOperationArtifactManifest) => ({
    schemaVersion: "generic-operation-artifact-ref/v1" as const,
    artifactId: m.artifactId,
    operationId: OP,
    resultSchema: SCHEMA,
    sha256: m.sha256,
    sizeBytes: m.sizeBytes,
    mediaType: m.mediaType,
    expiresAt: m.expiresAt,
  });
  const persist = vi.fn(async (input: PersistGenericOperationArtifactInput) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of input.source.body) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const m = manifest(bytes.toString("utf8"), { expiresAt: input.expiresAt });
    records.push({ ...input, bytes, manifest: m });
    return { reference: reference(m), durableReceipt: receipt(m) };
  });
  const readVerified = vi.fn(async () => {
    const last = records.at(-1)!;
    return {
      manifest: last.manifest,
      expectedFacts: last.expectedFacts,
      body: (async function* () {
        yield last.bytes;
      })(),
    };
  });
  const finder = createContactEmailFindMaterializer({
    readBounded: async (input) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of input) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    },
    now: () => new Date("2026-11-22T00:00:00.000Z"),
  });
  const materializers = {
    materialize: async <T>(
      schema: string,
      input: AsyncIterable<Uint8Array>,
      m: GenericOperationArtifactManifest,
      facts: unknown,
    ): Promise<T> => {
      expect(schema).toBe(SCHEMA);
      return finder.materialize(input, m, facts) as Promise<T>;
    },
  };
  const execution = new GenericOperationArtifactExecution({
    withWorkspace: async () => {
      throw new Error("unexpected_subject_transaction_in_persist_test");
    },
    binding: {
      resolveForExecution: async () => ({
        status: "BOUND" as const,
        subjectRef: { subjectType: "contact" as const, subjectId: CONTACT },
      }),
    },
    service: { persist, readVerified },
    materializers,
    now: () => new Date("2026-11-22T00:00:00.000Z"),
  });
  return {
    execution,
    records,
    persist,
    readVerified,
    reservation,
    tool,
    subjectRef: { subjectType: "contact" as const, subjectId: CONTACT },
    receipt,
    reference,
  };
}
describe("actual artifact execution class with explicit fake persistence/materializer ports, NOT S3/SQL proof", () => {
  it("persists Hunter ciphertext with exact 1780 micro and no HTTP facts, then replays with no new charge", async () => {
    const x = artifactExecutionPorts();
    const first = await x.execution.persist({
      reservation: x.reservation,
      tool: x.tool,
      input: { stepId: "private-step" },
      result: { data: hit(), costCents: 0.178, costMicrousd: "1780" },
      subjectRef: x.subjectRef,
    });
    expect(first.data).toEqual(hit());
    expect(first.costMicrousd).toBe("1780");
    const saved = x.records[0]!;
    expect(saved.observedMicrousd).toBe(1780n);
    expect(saved.expectedFacts).toBeUndefined();
    expect(saved.source.mediaType).toBe("application/octet-stream");
    expect(saved.bytes.toString("utf8").startsWith("enc:v2:k1:")).toBe(true);
    expect(saved.bytes.toString("utf8")).not.toContain("person@");
    expect(saved.expiresAt).toBe("2026-11-22T01:00:00.000Z");
    const originalReceipt = x.receipt(saved.manifest);
    const replay = await x.execution.replay({
      reservation: {
        ...x.reservation,
        replay: true,
        replayResult: {
          resultStrategy: "artifact_reference",
          reference: x.reference(saved.manifest),
        },
        receipt: originalReceipt,
      },
      tool: x.tool,
    });
    expect(replay.data).toEqual(hit());
    expect(replay.costCents).toBe(0);
    expect(replay.costMicrousd).toBe("0");
    expect(replay.durableReceipt).toBe(originalReceipt);
    expect(replay.durableReceipt?.usage.upperBoundMicrousd).toBe("1780");
    expect(x.persist).toHaveBeenCalledTimes(1);
  });
  it("does not persist a Hunter result without the exact micro/quote/shadow/contact binding", async () => {
    for (const changes of [
      { costMicrousd: undefined },
      { costMicrousd: "1700" },
      { costCents: 0 },
    ]) {
      const x = artifactExecutionPorts();
      await expect(
        x.execution.persist({
          reservation: x.reservation,
          tool: x.tool,
          input: { stepId: "private-step" },
          result: {
            data: hit(),
            costCents: 0.178,
            costMicrousd: "1780",
            ...changes,
          },
          subjectRef: x.subjectRef,
        }),
      ).rejects.toThrow();
      expect(x.persist).not.toHaveBeenCalled();
    }
    const x = artifactExecutionPorts();
    await expect(
      x.execution.persist({
        reservation: x.reservation,
        tool: x.tool,
        input: { stepId: "private-step" },
        result: { data: hit(), costCents: 0.178, costMicrousd: "1780" },
        subjectRef: {
          subjectType: "company",
          subjectId: x.subjectRef.subjectId,
        },
      }),
    ).rejects.toThrow();
    expect(x.persist).not.toHaveBeenCalled();
  });
  it("does not reinterpret the four original artifact schemas through a new optional micro field", async () => {
    const x = artifactExecutionPorts();
    const tool = {
      id: "http.get",
      durableResultStrategy: {
        kind: "artifact_reference",
        schema: "http-get/v1",
        maxBytes: 3000000,
        mediaTypes: ["text/plain"],
        privacyClass: "PERSONAL_DATA",
        ttlSeconds: 3600,
      },
    } as Tool;
    await expect(
      x.execution.persist({
        reservation: x.reservation,
        tool,
        input: { url: "https://example.com/" },
        result: {
          data: {
            status: 200,
            ok: true,
            mediaType: "text/plain",
            text: "bounded",
            finalUrl: "https://example.com/",
          },
          costCents: 1,
          costMicrousd: "10000",
        },
        subjectRef: x.subjectRef,
      }),
    ).rejects.toThrow();
    expect(x.persist).not.toHaveBeenCalled();
  });
});

describe("stored-body email shape refactor preserves the original self-domain normalizer acceptance", () => {
  it.each([
    "a@example.com",
    "用户@例子.测试",
    " A@Example.Com ",
    "a@example.com.",
    "a@www.example.com",
    "a@@example.com",
    "a" + String.fromCharCode(0) + "@example.com",
    ".a..b@example.com",
  ])("matches original canonical-body acceptance %#", (email) => {
    const domain = email.slice(email.lastIndexOf("@") + 1);
    const hasControl = Array.from(email).some((char) => {
      const code = char.charCodeAt(0);
      return code < 32 || code === 127;
    });
    const expected =
      email.length <= 320 &&
      !hasControl &&
      originalNormalizeEnrichedEmail(email, domain) === email;
    let accepted = true;
    try {
      parseContactEmailFindPayload({ ...hit(), email });
    } catch {
      accepted = false;
    }
    expect(accepted).toBe(expected);
  });
});
