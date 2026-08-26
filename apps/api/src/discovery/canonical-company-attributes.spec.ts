import { describe, expect, it } from "vitest";
import { sanitizeCanonicalCompanyAttributes } from "./canonical-company-attributes";

describe("CanonicalCompany derived-attribute sanitizer parity", () => {
  it("keeps exact FDA product codes and controlled terms but rejects secret-shaped uppercase tokens", () => {
    expect(
      sanitizeCanonicalCompanyAttributes({
        products: ["pump", "LLZ", "SECRET", "LLZ1", "AB"],
      }),
    ).toEqual({ products: ["pump", "LLZ"] });
  });

  it("rejects Unicode-decimal local phones in all retained scalar namespaces", () => {
    expect(
      sanitizeCanonicalCompanyAttributes({
        digital_footprint: {
          safe: "industrial",
          nested: {
            name: "Acme ٥٥٥-٠١٠٠",
            url: "https://acme.example/company/٥٥٥-٠١٠٠",
          },
        },
      }),
    ).toEqual({ digital_footprint: { safe: "industrial" } });
  });
});
