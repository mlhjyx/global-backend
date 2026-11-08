import { describe, expect, it, vi } from "vitest";
import type { ScreenMatch, ScreenResult } from "../../sanctions/sanctions-screening.service";
import {
  parseSanctionsScreenInput,
  runSanctionsScreen,
  SANCTIONS_SCREEN_ALGORITHM_VERSION,
  SanctionsScreenInputError,
  SanctionsScreenResultError,
} from "./sanctions-screen";

const MATCH: ScreenMatch = {
  externalId: "eu-123456",
  sourceKey: "eu-consolidated",
  matchedName: "Nordwind Trading LLC",
  aliasQuality: "primary",
  score: 0.97,
  nameScore: 0.98,
  entityCountry: "AE",
  countryMatch: "same",
  listVersion: "2026-11-01",
};

function screenReturning(result: ScreenResult) {
  return vi.fn(() => result);
}

describe("parseSanctionsScreenInput", () => {
  it("accepts the documented shape and normalizes defaults", () => {
    expect(parseSanctionsScreenInput({ companyName: "  Acme GmbH ", country: "DE" })).toEqual({
      companyName: "Acme GmbH",
      country: "DE",
    });
    expect(parseSanctionsScreenInput({ companyName: "Acme", country: null, threshold: 0.8 })).toEqual({
      companyName: "Acme",
      country: null,
      threshold: 0.8,
    });
  });

  it("rejects junk", () => {
    for (const input of [
      null,
      [],
      {},
      { companyName: "" },
      { companyName: "x".repeat(501) },
      { companyName: "Acme", country: 7 },
      { companyName: "Acme", threshold: 0 },
      { companyName: "Acme", threshold: 1.5 },
      { companyName: "Acme", threshold: "0.8" },
    ]) {
      expect(() => parseSanctionsScreenInput(input), JSON.stringify(input)).toThrow(
        SanctionsScreenInputError,
      );
    }
  });
});

describe("runSanctionsScreen", () => {
  it("passes the parsed input to the index and stamps the algorithm version", () => {
    const screen = screenReturning({
      status: "potential_match",
      matches: [MATCH],
      listVersions: { "eu-consolidated": "2026-11-01" },
    });
    const out = runSanctionsScreen({ companyName: "Nordwind", country: "AE", threshold: 0.7 }, screen);
    expect(screen).toHaveBeenCalledWith("Nordwind", "AE", { threshold: 0.7 });
    expect(out.status).toBe("potential_match");
    expect(out.algorithmVersion).toBe(SANCTIONS_SCREEN_ALGORITHM_VERSION);
    expect(out.matches).toHaveLength(1);
    expect(out.listVersions).toEqual({ "eu-consolidated": "2026-11-01" });
  });

  it("never fabricates a clear when the index is inactive", () => {
    const screen = screenReturning({ status: "not_screened", matches: [], listVersions: {} });
    const out = runSanctionsScreen({ companyName: "Acme" }, screen);
    expect(screen).toHaveBeenCalledWith("Acme", null, {});
    expect(out.status).toBe("not_screened");
  });

  it("caps the returned matches at 50 and flags the truncation", () => {
    const matches = Array.from({ length: 80 }, (_, index) => ({ ...MATCH, nameScore: index / 100 }));
    const out = runSanctionsScreen(
      { companyName: "Acme" },
      screenReturning({ status: "potential_match", matches, listVersions: {} }),
    );
    expect(out.matches).toHaveLength(50);
    expect(out.truncated).toBe(true);
  });

  it("never screens a name with no comparable tokens", () => {
    const screen = screenReturning({ status: "clear", matches: [], listVersions: {} });
    for (const companyName of ["!!!", "---", "###"]) {
      const out = runSanctionsScreen({ companyName }, screen);
      expect(out.status, companyName).toBe("not_screened");
      expect(out.matches, companyName).toEqual([]);
      expect(out.truncated, companyName).toBe(false);
    }
    expect(screen).not.toHaveBeenCalled();
  });

  it("fails closed on an unknown index status with a result error", () => {
    expect(() =>
      runSanctionsScreen(
        { companyName: "Acme" },
        screenReturning({ status: "ok" as ScreenResult["status"], matches: [], listVersions: {} }),
      ),
    ).toThrow(SanctionsScreenResultError);
  });
});
