import { describe, expect, it } from "vitest";
import {
  canonicalizeSuppressionValue,
  canonicalizeSuppressionValues,
  companyMatchesSuppression,
} from "./suppression-value";

describe("canonicalizeSuppressionValue", () => {
  it("canonicalizes safe equivalent values to one matching key", () => {
    expect(canonicalizeSuppressionValue("email", " Sales@EXAMPLE.COM ")).toBe(
      "sales@example.com",
    );
    expect(
      canonicalizeSuppressionValue("domain", "https://www.Example.COM./path"),
    ).toBe("example.com");
    expect(
      canonicalizeSuppressionValue("company_name", "  ACME\t GmbH  "),
    ).toBe("acme gmbh");
  });

  it.each([
    ["domain", "127.0.0.1"],
    ["domain", "https://[::1]/"],
    ["email", "person@-bad.example"],
    ["email", ".person@example.com"],
    ["email", "person..alias@example.com"],
    ["email", `${"a".repeat(2049)}@example.com`],
    ["company_name", `ACME\u0000GmbH`],
    ["company_name", "x".repeat(2049)],
  ])(
    "rejects unsafe or unbounded %s value before persistence",
    (type, value) => {
      expect(canonicalizeSuppressionValue(type, value)).toBeNull();
    },
  );

  it("canonicalizes legacy stored rows with the same keys used for new candidates", () => {
    expect(
      canonicalizeSuppressionValues("email", [
        " SALES@Example.com ",
        "invalid",
      ]),
    ).toEqual(new Set(["sales@example.com"]));
    expect(
      canonicalizeSuppressionValues("domain", ["https://www.Example.com/path"]),
    ).toEqual(new Set(["example.com"]));
    expect(
      canonicalizeSuppressionValues("company_name", ["  ACME   GmbH "]),
    ).toEqual(new Set(["acme gmbh"]));
    expect(
      companyMatchesSuppression(
        [{ type: "domain", value: " HTTPS://WWW.EXAMPLE.COM/path " }],
        { domain: "example.com", name: "Different Co" },
      ),
    ).toBe(true);
  });

  describe("A2 literal SQL-parity suppression vectors", () => {
    it("keeps a canonical ASCII domain unchanged", () => {
      expect(canonicalizeSuppressionValue("domain", "example.com")).toBe(
        "example.com",
      );
    });

    it("removes an HTTPS protocol prefix", () => {
      expect(
        canonicalizeSuppressionValue("domain", "HTTPS://Example.COM"),
      ).toBe("example.com");
    });

    it("removes a www prefix", () => {
      expect(canonicalizeSuppressionValue("domain", "www.Example.COM")).toBe(
        "example.com",
      );
    });

    it("removes a path suffix", () => {
      expect(
        canonicalizeSuppressionValue("domain", "Example.COM/directory"),
      ).toBe("example.com");
    });

    it("removes a trailing domain dot", () => {
      expect(canonicalizeSuppressionValue("domain", "Example.COM.")).toBe(
        "example.com",
      );
    });

    it("rejects a malformed domain", () => {
      expect(
        canonicalizeSuppressionValue("domain", "999.999.999.999"),
      ).toBeNull();
    });

    it("rejects an IPv4 address", () => {
      expect(canonicalizeSuppressionValue("domain", "127.0.0.1")).toBeNull();
    });

    it("rejects an IPv6 address", () => {
      expect(
        canonicalizeSuppressionValue("domain", "https://[2001:db8::1]/"),
      ).toBeNull();
    });

    it("rejects an overlong domain label", () => {
      expect(
        canonicalizeSuppressionValue(
          "domain",
          "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.example.com",
        ),
      ).toBeNull();
    });

    it("normalizes a decomposed Unicode company name to NFC", () => {
      expect(
        canonicalizeSuppressionValue("company_name", "A\u0308cme GmbH"),
      ).toBe("äcme gmbh");
    });

    it("folds company-name whitespace to one canonical key", () => {
      expect(
        canonicalizeSuppressionValue("company_name", "  ACME\t GmbH  "),
      ).toBe("acme gmbh");
    });

    it("matches a presentation-variant stored domain through the canonical key", () => {
      expect(
        companyMatchesSuppression(
          [{ type: "domain", value: " HTTPS://WWW.EXAMPLE.COM/path " }],
          { domain: "example.com", name: "Different Co" },
        ),
      ).toBe(true);
    });

    it("matches a whitespace-variant stored company name through the canonical key", () => {
      expect(
        companyMatchesSuppression(
          [{ type: "company_name", value: "  ACME   GmbH " }],
          { domain: null, name: "Acme GmbH" },
        ),
      ).toBe(true);
    });

    it("fails closed for legacy noncanonical company domains instead of treating raw stored text as a key", () => {
      expect(
        companyMatchesSuppression(
          [{ type: "domain", value: "not a canonical domain" }],
          { domain: "example.com", name: "Acme GmbH" },
        ),
      ).toBe(false);
    });
  });
});
