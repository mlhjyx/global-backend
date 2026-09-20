import { describe, expect, it } from "vitest";
import { canonicalizePlatformAuthorityRequestBodyV1, PLATFORM_AUTHORITY_ISSUE_REQUEST_SCHEMA_V1 } from "../../../../packages/contracts/src/platform-authority/canonical-request";

const body = {
  schema_version: "platform-authority-issue-request/v1", purpose: "platform.acquisition",
  temporal_namespace: "platform-automation", schedule_id: "acq-sweep",
  workflow_type: "acquisitionSweepWorkflow", workflow_id: "platform-acquisition-test",
  workflow_run_id: "11111111-1111-4111-8111-111111111111",
  schedule_request_sha256: "a".repeat(64), policy_artifact_sha256: "b".repeat(64),
  technical_policy_revision: "c".repeat(64),
};
const parse = (raw: string, contentType = "application/json") => canonicalizePlatformAuthorityRequestBodyV1({
  schema: PLATFORM_AUTHORITY_ISSUE_REQUEST_SCHEMA_V1, contentType, rawBody: Buffer.from(raw),
});
describe("platform authority issue request", () => {
  it("binds policy, Schedule and exact run with canonical key ordering", () => {
    const expected = JSON.stringify(Object.fromEntries(Object.entries(body).sort(([a], [b]) => a.localeCompare(b))));
    expect(parse(JSON.stringify(body)).canonicalBodyUtf8).toBe(expected);
    expect(parse(JSON.stringify(Object.fromEntries(Object.entries(body).reverse()))).canonicalBodyUtf8).toBe(expected);
  });
  it.each([
    { ...body, cap_microusd: "1" }, { ...body, technical_policy_revision: "invalid" },
    { ...body, policy_artifact_sha256: "A".repeat(64) }, { ...body, temporal_namespace: "default" },
    { ...body, schema_version: "platform-execution-technical-quote-request/v1" },
    { ...body, workflow_run_id: "wrong" },
  ])("rejects substituted or expanded issue scope", (value) => {
    expect(() => parse(JSON.stringify(value))).toThrow();
  });
  it("rejects duplicate members and content-type parameters", () => {
    expect(() => parse(JSON.stringify(body).replace('"purpose":', '"purpose":"other","purpose":'))).toThrow();
    expect(() => parse(JSON.stringify(body), "application/json; charset=utf-8")).toThrow();
  });
});
