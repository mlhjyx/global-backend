import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { IntakeDto } from "./intake.dto";

const BASE = {
  company: { nameZh: "杭州爱克姆泵业有限公司", nameEn: "Acme Pump" },
  industry: "isic-2813",
  products: ["pump"],
  targetMarkets: ["DE"],
  hasWebsite: false,
  businessEmail: "sales@example.com",
};

function websiteErrors(websiteUrl: unknown) {
  return validateSync(
    plainToInstance(IntakeDto, { ...BASE, websiteUrl }),
  ).filter((error) => error.property === "websiteUrl");
}

describe("IntakeDto websiteUrl contract", () => {
  it.each([42, { href: "https://example.com" }, "not-a-url"])(
    "hasWebsite=false 仍拒绝非 URI websiteUrl：%j",
    (websiteUrl) => {
      expect(websiteErrors(websiteUrl)).not.toEqual([]);
    },
  );

  it.each([undefined, null, "https://example.com"])(
    "允许 websiteUrl 缺省/null/合法 URI：%j",
    (websiteUrl) => {
      expect(websiteErrors(websiteUrl)).toEqual([]);
    },
  );
});
