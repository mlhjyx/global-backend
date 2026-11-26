import { enrichmentInputVersion } from "../finders/email-enrichment-provider";
import { describe, expect, it } from "vitest";
import {
  buildTargetSnapshot,
  contactTargetBeforeDigest,
  smtpPhysicalInputFingerprint,
  finderPhysicalInputFingerprint,
  verificationPhysicalInputFingerprint,
} from "./enrichment-target-snapshot";
const target = (n = 0) => ({
  contactId: "c" + n,
  contactOrdinal: n,
  inputVersion: "input-v1",
  beforeDigest: "a".repeat(64),
  pointRefs: ["p" + n],
});
describe("bounded target snapshot without identity or address", () => {
  it("copies and freezes the complete original metadata without aliasing", () => {
    const source = [target()];
    const snap = buildTargetSnapshot(source);
    source[0]!.pointRefs.push("changed");
    expect(snap).toEqual([target()]);
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap[0]!.pointRefs)).toBe(true);
  });
  it("accepts exactly ten targets with one hundred references each when within bytes", () => {
    const source = Array.from({ length: 10 }, (_, n) => ({
      ...target(n),
      pointRefs: Array.from({ length: 100 }, (_, p) => "p" + n + "-" + p),
    }));
    expect(buildTargetSnapshot(source)).toEqual(source);
  });
  it.each([
    [target(), { ...target(1), contactId: "c0" }],
    [target(), { ...target(1), contactOrdinal: 0 }],
    [{ ...target(), pointRefs: ["p0", "p0"] }],
    [
      {
        ...target(),
        pointRefs: Array.from({ length: 101 }, (_, n) => "p" + n),
      },
    ],
    [{ ...target(), fullName: "PII_SENTINEL" }],
    [{ ...target(), beforeDigest: "not-a-digest" }],
    Array.from({ length: 11 }, (_, n) => target(n)),
  ])("rejects ambiguous, truncated or unbounded targets %#", (value) =>
    expect(() => buildTargetSnapshot(value)).toThrow(),
  );
  it("rejects a canonical UTF8 snapshot beyond 65536 bytes rather than truncating references", () => {
    const source = Array.from({ length: 10 }, (_, n) => ({
      ...target(n),
      pointRefs: Array.from(
        { length: 100 },
        (_, p) => "p" + n + "-" + p + "-" + "x".repeat(100),
      ),
    }));
    expect(() => buildTargetSnapshot(source)).toThrow();
  });
});

describe("target snapshot dense own-data arrays", () => {
  it("rejects sparse target and point arrays", () => {
    expect(() => buildTargetSnapshot(new Array(1))).toThrow();
    expect(() =>
      buildTargetSnapshot([{ ...target(), pointRefs: new Array(1) }]),
    ).toThrow();
  });
  it("rejects extra array properties rather than dropping a hidden payload", () => {
    const refs = ["p1"];
    Object.defineProperty(refs, "email", { value: "PII_SENTINEL" });
    expect(() =>
      buildTargetSnapshot([{ ...target(), pointRefs: refs }]),
    ).toThrow();
  });
});

const fingerprintFinder = () => ({
  workspaceId: "w1",
  contactId: "c1",
  inputVersion: enrichmentInputVersion({
    fullName: "Synthetic Person",
    domain: "synthetic.example.invalid",
  }),
});
const fingerprintVerify = () => ({
  workspaceId: "w1",
  contactId: "c1",
  provider: "millionverifier" as const,
  email: "person@synthetic.example.invalid",
  providerTimeoutSeconds: 8,
});
describe("physical input blind fingerprints, not candidate receipt or financial identities", () => {
  it("uses the original normalized finder input version and emits only an opaque digest", () => {
    const a = fingerprintFinder();
    const b = {
      ...a,
      inputVersion: enrichmentInputVersion({
        fullName: " Synthetic Person ",
        domain: "SYNTHETIC.EXAMPLE.INVALID",
      }),
    };
    const hash = finderPhysicalInputFingerprint(a);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(finderPhysicalInputFingerprint(b)).toBe(hash);
    expect(hash).not.toContain(a.inputVersion);
  });
  it("isolates finder workspace/contact/input version but takes no account, grant, quote or receipt", () => {
    const a = fingerprintFinder();
    const hash = finderPhysicalInputFingerprint(a);
    for (const b of [
      { ...a, workspaceId: "w2" },
      { ...a, contactId: "c2" },
      { ...a, inputVersion: "b".repeat(64) },
    ])
      expect(finderPhysicalInputFingerprint(b)).not.toBe(hash);
    for (const extra of [
      { authorityId: "other-authority" },
      { accountKey: "other-account" },
      { generation: 2 },
      { pricingVersion: "other-price" },
      { receiptId: "different-receipt" },
    ])
      expect(() =>
        finderPhysicalInputFingerprint({ ...a, ...extra }),
      ).toThrow();
  });
  it("keeps a canonical verification address and actual provider query options in the same fingerprint", () => {
    const a = fingerprintVerify();
    const hash = verificationPhysicalInputFingerprint(a);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      verificationPhysicalInputFingerprint({
        ...a,
        email: " Person@Synthetic.Example.Invalid ",
      }),
    ).toBe(hash);
    expect(
      verificationPhysicalInputFingerprint({ ...a, providerTimeoutSeconds: 9 }),
    ).not.toBe(hash);
    expect(
      verificationPhysicalInputFingerprint({
        ...a,
        email: "other@synthetic.example.invalid",
      }),
    ).not.toBe(hash);
  });
  it("separates workspace/contact/provider while excluding receipt and money switches", () => {
    const a = fingerprintVerify();
    const hash = verificationPhysicalInputFingerprint(a);
    for (const b of [
      { ...a, workspaceId: "w2" },
      { ...a, contactId: "c2" },
      { ...a, provider: "emailable" as const, providerTimeoutSeconds: null },
    ])
      expect(verificationPhysicalInputFingerprint(b)).not.toBe(hash);
    for (const extra of [
      { authorityId: "a" },
      { accountKey: "b" },
      { generation: 2 },
      { quoteMicrousd: "1780" },
      { candidateReceipt: "new-receipt" },
      { retryOrdinal: 2 },
    ])
      expect(() =>
        verificationPhysicalInputFingerprint({ ...a, ...extra }),
      ).toThrow();
  });
  it.each(["emailable", "zerobounce"] as const)(
    "does not invent a timeout query option for %s",
    (provider) => {
      const a = {
        ...fingerprintVerify(),
        provider,
        providerTimeoutSeconds: null,
      };
      expect(verificationPhysicalInputFingerprint(a)).toMatch(/^[a-f0-9]{64}$/);
      expect(() =>
        verificationPhysicalInputFingerprint({
          ...a,
          providerTimeoutSeconds: 8,
        }),
      ).toThrow();
    },
  );
  it.each([0, 31, 1.5, NaN])(
    "rejects an unresolved or unbounded provider wire timeout %s",
    (providerTimeoutSeconds) =>
      expect(() =>
        verificationPhysicalInputFingerprint({
          ...fingerprintVerify(),
          providerTimeoutSeconds,
        }),
      ).toThrow(),
  );
  it("does not accept malformed addresses or an unsupported provider", () => {
    expect(() =>
      verificationPhysicalInputFingerprint({
        ...fingerprintVerify(),
        email: "not-email",
      }),
    ).toThrow();
    expect(() =>
      verificationPhysicalInputFingerprint({
        ...fingerprintVerify(),
        provider: "truelist" as never,
      }),
    ).toThrow();
  });
  it("fails closed without the existing PII blind-index key, never falls back to a public hash", () => {
    const originalKeyring = process.env.PII_KEYRING_JSON;
    const originalLegacy = process.env.PII_ENCRYPTION_KEY;
    delete process.env.PII_KEYRING_JSON;
    delete process.env.PII_ENCRYPTION_KEY;
    try {
      expect(() =>
        finderPhysicalInputFingerprint(fingerprintFinder()),
      ).toThrow();
      expect(() =>
        verificationPhysicalInputFingerprint(fingerprintVerify()),
      ).toThrow();
    } finally {
      if (originalKeyring === undefined) delete process.env.PII_KEYRING_JSON;
      else process.env.PII_KEYRING_JSON = originalKeyring;
      if (originalLegacy === undefined) delete process.env.PII_ENCRYPTION_KEY;
      else process.env.PII_ENCRYPTION_KEY = originalLegacy;
    }
  });
});

describe("original SMTP physical identity is independent of account-derived catch-all nonce", () => {
  const originalInput = {
    domain: "company.example.invalid",
    mxHost: "mx.company.example.invalid",
    rcptTo: [
      "person@company.example.invalid",
      "x-verify-0123456789abcdef0123@company.example.invalid",
    ],
  };
  const base = { workspaceId: "w1", contactId: "c1", originalInput };
  it("is a keyed blind digest and never a raw address", () => {
    expect(smtpPhysicalInputFingerprint(base)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("does not let another account catch-all nonce escape the existing pending fence", () => {
    expect(smtpPhysicalInputFingerprint(base)).toBe(
      smtpPhysicalInputFingerprint({
        ...base,
        originalInput: {
          ...originalInput,
          rcptTo: [
            originalInput.rcptTo[0]!,
            "x-verify-fedcba9876543210fedc@company.example.invalid",
          ],
        },
      }),
    );
  });
  it.each(["workspaceId", "contactId"] as const)(
    "changes for a different %s",
    (key) => {
      expect(smtpPhysicalInputFingerprint(base)).not.toBe(
        smtpPhysicalInputFingerprint({ ...base, [key]: "different" }),
      );
    },
  );
  it("changes for a different real address or MX target", () => {
    expect(smtpPhysicalInputFingerprint(base)).not.toBe(
      smtpPhysicalInputFingerprint({
        ...base,
        originalInput: {
          ...originalInput,
          rcptTo: ["other@company.example.invalid", originalInput.rcptTo[1]!],
        },
      }),
    );
    expect(smtpPhysicalInputFingerprint(base)).not.toBe(
      smtpPhysicalInputFingerprint({
        ...base,
        originalInput: {
          ...originalInput,
          mxHost: "other.company.example.invalid",
        },
      }),
    );
  });
  it.each([
    { ...originalInput, rcptTo: [originalInput.rcptTo[0]] },
    {
      ...originalInput,
      rcptTo: [...originalInput.rcptTo, "extra@company.example.invalid"],
    },
    {
      ...originalInput,
      rcptTo: [originalInput.rcptTo[0], "arbitrary@company.example.invalid"],
    },
    { ...originalInput, domain: "different.example.invalid" },
    { ...originalInput, receiptId: "must-not-enter-physical-identity" },
  ])("rejects non-original or ambiguous SMTP inputs %#", (input) => {
    expect(() =>
      smtpPhysicalInputFingerprint({ ...base, originalInput: input as never }),
    ).toThrow();
  });
  it("rejects an account field instead of hashing it into the physical identity", () => {
    expect(() =>
      smtpPhysicalInputFingerprint({
        ...base,
        accountKey: "new-account",
      } as never),
    ).toThrow();
  });
});


describe('frozen beforeDigest over complete bounded current point state', () => {
  const point = { id: '00000000-0000-4000-8000-000000000001', type: 'phone', value: 'SYNTHETIC_PII_VALUE', status: 'UNVERIFIED', verificationState: 'UNKNOWN', validSince: null, verifiedAt: null, nextReverifyAt: null, lastVerificationEventId: null, confidence: null };
  const input = { inputVersion: 'a'.repeat(64), points: [point] };
  it('returns only an opaque existing-key blind digest, including an empty point set', () => {
    expect(contactTargetBeforeDigest(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(contactTargetBeforeDigest({ ...input, points: [] })).toMatch(/^[a-f0-9]{64}$/);
  });
  it('does not make database row order a state change', () => {
    const second = { ...point, id: '00000000-0000-4000-8000-000000000002' };
    expect(contactTargetBeforeDigest({ ...input, points: [point, second] })).toBe(contactTargetBeforeDigest({ ...input, points: [second, point] }));
  });
  it('binds the original finder input version and every live selected point state field', () => {
    const original = contactTargetBeforeDigest(input);
    for (const patch of [{ value: 'changed' }, { type: 'email' }, { status: 'BLOCKED' }, { verificationState: 'VALID' }, { confidence: 20 }, { verifiedAt: '2026-11-22T00:00:00.000Z' }, { lastVerificationEventId: '00000000-0000-4000-8000-000000000003' }]) expect(contactTargetBeforeDigest({ ...input, points: [{ ...point, ...patch }] })).not.toBe(original);
    expect(contactTargetBeforeDigest({ ...input, inputVersion: 'b'.repeat(64) })).not.toBe(original);
  });
  it('rejects duplicate/overlarge/extra-data snapshots instead of dropping fields or points', () => {
    for (const points of [[point, point], Array.from({ length: 101 }, () => point), [{ ...point, rawResponse: 'not-metadata' }], [{ ...point, value: 'x'.repeat(4097) }]]) expect(() => contactTargetBeforeDigest({ ...input, points } as never)).toThrow();
  });
  it('rejects an account or receipt field as a before-state parameter', () => { expect(() => contactTargetBeforeDigest({ ...input, accountKey: 'not-state' } as never)).toThrow(); });
});
