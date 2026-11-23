import { describe, expect, it } from "vitest";
import { TypedProjectionRegistry } from "./typed-projection.registry";
import { registerSourceResultProjections } from "./source-result-projections";
import {
  CONTACT_EMAIL_VERIFICATION_PROVIDERS as PROVIDERS,
  CONTACT_EMAIL_VERIFICATION_SCHEMAS as SCHEMAS,
  registerContactEmailVerificationProjections,
} from "./contact-email-verification-projections";
const vote = (providerKey: string) => ({
  providerKey,
  state: "VALID",
  catchAll: "not_catch_all",
  catchAllClass: "not_catch_all",
  score: 90,
  acceptAll: false,
  disposable: false,
  role: false,
  reason: "provider_verdict",
  costBasis: "estimated_upper_bound",
});
const result = (provider: string, micro = "1780") => ({
  data: vote(provider),
  costMicrousd: micro,
  costCents: Number(BigInt(micro)) / 10000,
});
const registry = () =>
  registerContactEmailVerificationProjections(new TypedProjectionRegistry());
describe("closed three-provider controlled votes; no address, invoice or global reliability claim", () => {
  it("registers exactly the three fixed typed schemas and not finder or arbitrary vendor schemas", () => {
    const r = registry();
    for (const provider of PROVIDERS)
      expect(r.has(SCHEMAS[provider])).toBe(true);
    expect(r.has("contact-email-find-hunter/v1")).toBe(false);
    expect(r.has("contact-email-verify-truelist/v1")).toBe(false);
  });
  for (const provider of PROVIDERS) {
    it.each(["1780", "1700"])(
      "roundtrips " +
        provider +
        " exact micro %s without losing fractional-cent display",
      (micro) => {
        const raw = result(provider, micro);
        const r = registry();
        const envelope = r.project(SCHEMAS[provider], raw);
        expect(r.restore(JSON.parse(JSON.stringify(envelope)))).toEqual(raw);
        expect(JSON.stringify(envelope)).not.toContain("example.invalid");
      },
    );
    it.each([
      (raw: ReturnType<typeof result>) => ({ ...raw, costCents: 0 }),
      (raw: ReturnType<typeof result>) => ({ ...raw, costMicrousd: "01" }),
      (raw: ReturnType<typeof result>) => ({
        ...raw,
        costMicrousd: "150001",
        costCents: 15.0001,
      }),
      (raw: ReturnType<typeof result>) => ({ ...raw, costMicrousd: 1780 }),
      (raw: ReturnType<typeof result>) => ({
        data: raw.data,
        costCents: 0.178,
      }),
      (raw: ReturnType<typeof result>) => ({
        ...raw,
        data: { ...raw.data, email: "sentinel@example.invalid" },
      }),
      (raw: ReturnType<typeof result>) => ({
        ...raw,
        data: { ...raw.data, detail: "raw provider detail" },
      }),
      (raw: ReturnType<typeof result>) => ({
        ...raw,
        data: { ...raw.data, reason: "arbitrary upstream words" },
      }),
      (raw: ReturnType<typeof result>) => ({
        ...raw,
        data: { ...raw.data, costBasis: "provider_reported" },
      }),
      (raw: ReturnType<typeof result>) => ({
        ...raw,
        data: { ...raw.data, providerKey: "different-vendor" },
      }),
      (raw: ReturnType<typeof result>) => ({
        ...raw,
        data: { ...raw.data, state: "RISKY" },
      }),
      (raw: ReturnType<typeof result>) => ({
        ...raw,
        provenance: { sourceUrl: "https://sentinel.example.invalid" },
      }),
    ])("rejects malformed/PII/price-shadow " + provider + " %#", (change) => {
      const r = registry();
      expect(() =>
        r.project(SCHEMAS[provider], change(result(provider))),
      ).toThrow();
    });
    it("rejects " + provider + " accessors before evaluating them", () => {
      const raw = result(provider);
      let reads = 0;
      Object.defineProperty(raw.data, "providerKey", {
        enumerable: true,
        get() {
          reads += 1;
          return provider;
        },
      });
      const r = registry();
      expect(() => r.project(SCHEMAS[provider], raw)).toThrow();
      expect(reads).toBe(0);
    });
    it("does not restore a tampered " + provider + " envelope", () => {
      const r = registry();
      const envelope = JSON.parse(
        JSON.stringify(r.project(SCHEMAS[provider], result(provider))),
      );
      envelope.data.data.score = 1;
      expect(() => r.restore(envelope)).toThrow();
    });
  }
  it("leaves an existing source codec integer-cent-only and rejects its new micro shadow", () => {
    const r = registerSourceResultProjections(new TypedProjectionRegistry());
    const valid = { data: { notices: [] }, costCents: 1 };
    expect(r.restore(r.project("samgov-search/v1", valid))).toEqual(valid);
    expect(() =>
      r.project("samgov-search/v1", { ...valid, costCents: 0.178 }),
    ).toThrow();
    expect(() =>
      r.project("samgov-search/v1", { ...valid, costMicrousd: "10000" }),
    ).toThrow();
  });
});
