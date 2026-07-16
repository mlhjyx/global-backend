import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import {
  PROFILE_MAX_BYTES,
  assertProfileSize,
  profileEtag,
  resolveProfilePrecondition,
  validateProfilePatch,
} from "./profile-contract";

const V0 = "11111111-1111-4111-8111-111111111111";

function statusOf(error: unknown): number | undefined {
  return error instanceof HttpException ? error.getStatus() : undefined;
}

describe("R2-A3 profile contract", () => {
  it("accepts and normalizes all five bounded groups without persisting baseVersionId", () => {
    const validated = validateProfilePatch({
      baseVersionId: V0,
      companyProfile: {
        foundedYear: 2008,
        employeeCountRange: { min: 50, max: 100 },
        businessType: "manufacturer",
        city: " Shenzhen ",
        annualExportRevenue: {
          currency: "usd",
          min: 1_000_000,
          max: 2_000_000,
        },
        exportMarkets: ["us", "DE"],
        capacityDescription: " 20,000 units / month ",
        productionLines: ["Assembly A"],
        moq: "100 units",
        leadTime: "30 days",
      },
      trustAssets: {
        certifications: [{ name: "ISO 9001", certificateAssetIds: [V0] }],
        patents: [{ number: "CN-123" }],
        customerCases: [
          { displayLabel: "European OEM", anonymized: true, assetIds: [V0] },
        ],
        exhibitions: [{ name: "Hannover Messe", year: 2026, country: "de" }],
      },
      onlineAssets: {
        storefronts: [
          {
            platform: "alibaba",
            url: "HTTPS://Example.COM:443/store#top",
            importAuthorized: true,
          },
        ],
        socialProfiles: [
          { platform: "linkedin", url: "https://linkedin.com/company/acme" },
        ],
        googleBusinessProfiles: ["https://maps.google.com/?cid=1"],
      },
      brand: {
        logoAssetId: V0,
        colors: ["#0E5FA8"],
        referenceSites: ["https://example.com/"],
        slogan: "Built to last",
      },
      contact: {
        publicEmails: ["Sales@Example.com"],
        whatsappNumbers: ["+8613812345678"],
        phoneNumbers: ["+4930123456"],
        inquiryRecipientEmails: ["rfq@example.com"],
        displaySocialLinks: [
          {
            platform: "linkedin",
            url: "https://linkedin.com/company/acme",
            label: "Company",
          },
        ],
      },
    });

    expect(validated.baseVersionId).toBe(V0);
    expect(validated.groups.companyProfile).toMatchObject({
      city: "Shenzhen",
      annualExportRevenue: { currency: "USD" },
      exportMarkets: ["US", "DE"],
    });
    expect(validated.groups.onlineAssets).toMatchObject({
      storefronts: [
        {
          url: "https://example.com/store",
          platform: "alibaba",
          importAuthorized: true,
        },
      ],
    });
    expect(validated.groups.contact).toMatchObject({
      publicEmails: ["sales@example.com"],
    });
    expect(validated.groups).not.toHaveProperty("baseVersionId");
  });

  it.each([
    [{ brand: { unknown: true } }, "unknown nested field"],
    [{ unknownGroup: {} }, "unknown top-level field"],
    [
      { brand: { referenceSites: ["javascript:alert(1)"] } },
      "unsafe URL scheme",
    ],
    [
      {
        onlineAssets: {
          socialProfiles: [
            { platform: "linkedin", url: "https://user:pass@example.com" },
          ],
        },
      },
      "URL userinfo",
    ],
    [{ contact: { phoneNumbers: ["0049 30 123"] } }, "non-E.164 phone"],
    [{ trustAssets: { patents: [{}] } }, "empty patent"],
    [
      { companyProfile: { employeeCountRange: { min: 101, max: 100 } } },
      "reversed range",
    ],
    [
      {
        brand: {
          referenceSites: ["https://example.com", "https://EXAMPLE.com/#x"],
        },
      },
      "normalized duplicate URL",
    ],
    [
      { contact: { publicEmails: ["sales@example.com", "SALES@example.com"] } },
      "normalized duplicate email",
    ],
  ])("rejects %s (%s) with stable 422 profile validation", (input) => {
    try {
      validateProfilePatch(input);
      throw new Error("expected validation failure");
    } catch (error) {
      expect(statusOf(error)).toBe(422);
      expect((error as HttpException).getResponse()).toMatchObject({
        error: { code: "PROFILE_VALIDATION_FAILED" },
      });
    }
  });

  it("rejects max+1 list items, control characters, empty patch and raw body overflow", () => {
    const invalid = [
      { brand: { colors: Array.from({ length: 6 }, () => "#000000") } },
      { brand: { slogan: "unsafe\u0000text" } },
      { baseVersionId: V0 },
      { brand: { slogan: "界".repeat(PROFILE_MAX_BYTES) } },
    ];
    for (const input of invalid)
      expect(() => validateProfilePatch(input)).toThrow(HttpException);
  });

  it("enforces the merged 64 KiB boundary, not only the incoming patch", () => {
    const justOver = {
      companyProfile: { capacityDescription: "x".repeat(PROFILE_MAX_BYTES) },
    };
    expect(() => assertProfileSize(justOver)).toThrow(HttpException);
  });

  it("uses one strong resource-scoped ETag and deterministic precondition precedence", () => {
    expect(profileEtag(V0)).toBe(`"profile:${V0}"`);
    expect(
      resolveProfilePrecondition(`  "profile:${V0}"  `, undefined),
    ).toEqual({
      expectedVersionId: V0,
      source: "if-match",
    });
    expect(resolveProfilePrecondition(undefined, V0)).toEqual({
      expectedVersionId: V0,
      source: "baseVersionId",
    });
    expect(resolveProfilePrecondition(`"profile:${V0}"`, V0)).toEqual({
      expectedVersionId: V0,
      source: "if-match",
    });
  });

  it.each([
    ["*"],
    [`W/"profile:${V0}"`],
    [`profile:${V0}`],
    [`"other:${V0}"`],
    [`"profile:${V0}", "profile:22222222-2222-4222-8222-222222222222"`],
  ])("rejects malformed If-Match %s with 400", (header) => {
    try {
      resolveProfilePrecondition(header, undefined);
      throw new Error("expected malformed ETag");
    } catch (error) {
      expect(statusOf(error)).toBe(400);
    }
  });

  it("returns 428 when both preconditions are absent and 400 when they disagree", () => {
    try {
      resolveProfilePrecondition(undefined, undefined);
      throw new Error("expected precondition failure");
    } catch (error) {
      expect(statusOf(error)).toBe(428);
      expect((error as HttpException).getResponse()).toMatchObject({
        error: { code: "PRECONDITION_REQUIRED" },
      });
    }

    expect(() =>
      resolveProfilePrecondition(
        `"profile:${V0}"`,
        "22222222-2222-4222-8222-222222222222",
      ),
    ).toThrow(HttpException);
  });
});
