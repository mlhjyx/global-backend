// Test intent source-mined from tugjvnh@70885cdb; rewritten without Organization Identity v2.
import { describe, expect, it } from "vitest";
import {
  validateSecEdgarDirectoryRawPayload,
  validateSecEdgarSubmissionObservation,
} from "./sec-edgar-submission-observation";

const provenance = Object.freeze({
  sourceUrl: "https://data.sec.gov/submissions/CIK0000000123.json",
  fetchedAt: "2026-08-26T00:00:00.000Z",
  contentHash: "a".repeat(64),
  parserVersion: "sec-edgar-submissions/2",
});

function observation() {
  return {
    externalId: "sec-edgar-submission:0000000123",
    name: "ACME CORPORATION",
    identifier: { scheme: "cik", value: "0000000123" },
    attributes: {
      sec_edgar_submission: {
        schema_version: "sec-edgar-submission-observation/v1",
        cik: "0000000123",
        entity_type: "operating",
        semantic_scope: "sec_filer_classification_only",
      },
    },
    license: "US-GOV-PUBLIC-INFO",
    provenance,
  };
}

describe("SEC EDGAR persisted-observation boundary", () => {
  it("accepts a directory Raw only when name and CIK match the active canonical binding", () => {
    expect(
      validateSecEdgarDirectoryRawPayload(
        {
          externalId: "sec-edgar:0000000123",
          name: "ACME CORPORATION",
          identifier: { scheme: "cik", value: "0000000123" },
          attributes: { sec_edgar: { cik: "0000000123", ticker: "ACME" } },
        },
        {
          companyName: "ACME CORPORATION",
          activeCik: "0000000123",
        },
      ),
    ).toEqual({ name: "ACME CORPORATION", cik: "0000000123" });

    for (const payload of [
      {
        externalId: "sec-edgar:0000000123",
        name: "OTHER",
        identifier: { scheme: "cik", value: "0000000123" },
      },
      {
        externalId: "sec-edgar:0000000999",
        name: "ACME CORPORATION",
        identifier: { scheme: "cik", value: "0000000999" },
      },
      {
        externalId: "sec-edgar:0000000123",
        name: "ACME CORPORATION",
        identifier: { scheme: "lei", value: "0000000123" },
      },
      { externalId: "sec-edgar:0000000123", name: "ACME CORPORATION" },
    ]) {
      expect(() =>
        validateSecEdgarDirectoryRawPayload(payload, {
          companyName: "ACME CORPORATION",
          activeCik: "0000000123",
        }),
      ).toThrow("SEC_EDGAR_DIRECTORY_RAW_BINDING_INVALID");
    }
  });

  it("admits only the bounded filer-classification projection", () => {
    expect(
      validateSecEdgarSubmissionObservation(observation(), {
        companyName: "ACME CORPORATION",
        activeCik: "0000000123",
        provenance,
      }),
    ).toEqual(observation());
  });

  it.each([
    ["filings", { recent: { form: ["10-K"] } }],
    ["formerNames", [{ name: "PERSON" }]],
    ["addresses", { business: { street1: "SECRET" } }],
    ["ein", "12-3456789"],
    ["phone", "555-0100"],
    ["website", "https://untrusted.example"],
    ["unknown", "forbidden"],
  ])(
    "rejects the unknown or personal field %s instead of persisting it",
    (key, value) => {
      expect(() =>
        validateSecEdgarSubmissionObservation(
          {
            ...observation(),
            [key]: value,
          },
          {
            companyName: "ACME CORPORATION",
            activeCik: "0000000123",
            provenance,
          },
        ),
      ).toThrow("SEC_EDGAR_SUBMISSION_OBSERVATION_INVALID");
    },
  );
});
