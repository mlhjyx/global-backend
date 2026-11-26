import { describe, expect, it } from "vitest";
import { scrubPii, scrubPiiKeepingTaxIds } from "./pii";

describe("scrubPii / scrubPiiKeepingTaxIds", () => {
  it("redacts phones after lowercase European prepositions (no PII leak regression)", () => {
    expect(scrubPiiKeepingTaxIds("Call us at 030 1234567")).toBe(
      "Call us at [redacted-phone]",
    );
    expect(scrubPiiKeepingTaxIds("Reach me at 555-123-4567")).toBe(
      "Reach me at [redacted-phone]",
    );
    expect(scrubPiiKeepingTaxIds("Tel. de 01 23 45 67 89")).toBe(
      "Tel. de [redacted-phone]",
    );
    expect(scrubPiiKeepingTaxIds("Fax it 030 1234567")).toBe(
      "Fax it [redacted-phone]",
    );
  });

  it("redacts uppercase phone cues and invalid VAT checksums", () => {
    expect(scrubPiiKeepingTaxIds("CALL US AT 030 1234567")).toBe(
      "CALL US AT [redacted-phone]",
    );
    expect(scrubPiiKeepingTaxIds("TEL. DE 01 23 45 67 89")).toBe(
      "TEL. DE [redacted-phone]",
    );
    expect(scrubPiiKeepingTaxIds("FAX IT 030 1234567")).toBe(
      "FAX IT [redacted-phone]",
    );
    expect(scrubPiiKeepingTaxIds("TEL. DE 136695976")).toBe(
      "TEL. DE [redacted-phone]",
    );
    expect(scrubPiiKeepingTaxIds("USt-IdNr.: DE136695977")).toBe(
      "USt-IdNr.: DE[redacted-phone]",
    );
    expect(scrubPiiKeepingTaxIds("P.IVA 04553650988")).toBe(
      "P.IVA [redacted-phone]",
    );
    expect(scrubPiiKeepingTaxIds("P.IVA 00000000000")).toBe(
      "P.IVA [redacted-phone]",
    );
    expect(scrubPiiKeepingTaxIds("BTW: NL123456789B01")).toBe(
      "BTW: NL[redacted-phone]B01",
    );
  });

  it("preserves valid EU/CH VAT identifiers and valid labeled Italian P.IVA while redacting emails and phones", () => {
    const input = [
      "USt-IdNr.: DE136695976 / DE 136695976",
      "P.IVA e C.F. 04553650989",
      "VAT: IT05503370289",
      "UID: ATU12345678",
      "TVA: FR44732829320",
      "BTW: BE0403199702",
      "BTW: NL004495445B01 / NL000099998B57",
      "NIP: PL5260250995",
      "UID: CHE-123.456.789 MWST",
      "Tel. +39 030 1234567 | info@effeenergy.it",
    ].join("\n");

    const kept = scrubPiiKeepingTaxIds(input);
    expect(kept).toContain("DE136695976");
    expect(kept).toContain("DE 136695976");
    expect(kept).toContain("P.IVA e C.F. 04553650989");
    expect(kept).toContain("IT05503370289");
    expect(kept).toContain("ATU12345678");
    expect(kept).toContain("FR44732829320");
    expect(kept).toContain("BE0403199702");
    expect(kept).toContain("NL004495445B01");
    expect(kept).toContain("NL000099998B57");
    expect(kept).toContain("PL5260250995");
    expect(kept).toContain("CHE-123.456.789");
    expect(kept).toContain("[redacted-phone]");
    expect(kept).toContain("[redacted-email]");
    expect(kept).not.toContain("+39 030 1234567");
    expect(kept).not.toContain("info@effeenergy.it");

    // Plain scrubPii remains unchanged and still redacts all digit runs.
    expect(scrubPii("USt-IdNr.: DE136695976")).toBe(
      "USt-IdNr.: DE[redacted-phone]",
    );
  });
});
