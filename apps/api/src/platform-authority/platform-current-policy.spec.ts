import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CurrentPlatformChannelCrawlPolicy,
  CurrentPlatformExecutionPolicy,
} from "./platform-current-policy";
import {
  PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256,
  loadVerifiedPlatformAuthorityPolicyAsset,
} from "./platform-authority-policy-asset";

const corpus = JSON.parse(readFileSync(new URL("../../../../packages/contracts/fixtures/platform-authority/platform-execution-technical-quote-v1.json", import.meta.url), "utf8"));
const vector = corpus.vectors.find((row: { input: { schedule_id: string } }) => row.input.schedule_id === "acq-sweep");
function authority(source = vector) {
  return { purpose: source.input.purpose, scheduleId: source.input.schedule_id,
    workflowId: source.input.workflow_id, workflowRunId: source.input.workflow_run_id,
    scheduleRequestSha256: source.input.schedule_request_sha256,
    technicalPolicyRevision: source.expected_quote.policy_revision,
    authorizedCapMicrousd: BigInt(source.expected_quote.required_cap_per_run_microusd) };
}
const selected = { kind: "tool" as const, toolId: "tradefair.algolia", toolVersion: "1.0.0" };
describe("current platform execution policy projection", () => {
  it.each([
    { schedule: "intent-sweep", tool: "crawl4ai.render", cap: 10000000n, reservation: 10000n },
    { schedule: "sanctions-refresh", tool: "sanctions.download", cap: 1n, reservation: 0n },
  ])("projects the actual closed envelope for $schedule", ({ schedule, tool, cap, reservation }) => {
    const source = corpus.vectors.find((row: { input: { schedule_id: string } }) => row.input.schedule_id === schedule);
    const result = new CurrentPlatformExecutionPolicy().attest(authority(source), { kind: "tool", toolId: tool, toolVersion: "1.0.0" }, new Date());
    expect(result.requiredCapMicrousd).toBe(cap);
    expect(result.operationReservationMicrousd).toBe(reservation);
    expect(result.policyRevision).toBe(source.expected_quote.policy_revision);
  });
  it("keeps the disabled patents envelope unable to dispatch even with a valid old quote", () => {
    const source = corpus.vectors.find((row: { input: { schedule_id: string } }) => row.input.schedule_id === "patents-cache-refresh");
    expect(() => new CurrentPlatformExecutionPolicy().attest(authority(source), { kind: "tool", toolId: "google_patents.search", toolVersion: "1.0.0" }, new Date()))
      .toThrow("PLATFORM_EGRESS_CURRENT_POLICY_UNAVAILABLE");
  });
  it("reuses the official run policy without treating fresh quote timestamps as drift", () => {
    const policy = new CurrentPlatformExecutionPolicy();
    const first = policy.attest(authority(), selected, new Date(Number(vector.input.now_epoch_seconds) * 1000));
    const later = policy.attest(authority(), selected, new Date((Number(vector.input.now_epoch_seconds) + 60) * 1000));
    expect(first).toEqual(later);
    expect(first.policyRevision).toBe(vector.expected_quote.policy_revision);
    expect(first.requiredCapMicrousd).toBe(1n);
    expect(first.operationReservationMicrousd).toBe(0n);
    expect(first.executionEnvelopeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.policyArtifactSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it.each([
    { workflowRunId: "99999999-9999-4999-8999-999999999999" },
    { technicalPolicyRevision: "f".repeat(64) }, { authorizedCapMicrousd: 2n },
    { scheduleRequestSha256: "e".repeat(64) }, { purpose: "platform.sanctions" },
  ])("rejects signed/current scope or cap drift", mutation => {
    expect(() => new CurrentPlatformExecutionPolicy().attest({ ...authority(), ...mutation }, selected, new Date())).toThrow();
  });
  it.each([
    { ...selected, toolVersion: "new-version" }, { ...selected, toolId: "sanctions.download" },
    { kind: "model", modelOp: "generateText", taskId: "invented", providerId: "new-api" },
  ])("rejects execution outside the current closed tool envelope", execution => {
    expect(() => new CurrentPlatformExecutionPolicy().attest(authority(), execution, new Date())).toThrow("PLATFORM_EGRESS_CURRENT_POLICY_UNAVAILABLE");
  });
});

describe("current platform channel-crawl policy projection (P4-P4)", () => {
  const crawlAuthority = {
    purpose: "platform.channel_crawl",
    subjectType: "source_channel",
    subjectId: "55555555-5555-4555-8555-555555555555",
    requestSha256: "a".repeat(64),
    crawlRunId: "66666666-6666-4666-8666-666666666666",
    technicalPolicyRevision: PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256,
    authorizedCapMicrousd: 5_000_000n,
  };
  const crawlExecution = { kind: "tool" as const, toolId: "crawl4ai.render", toolVersion: "1.0.0" };

  it("pins the reviewed-v3 channel_crawl envelope digest shared with gain-saas", () => {
    expect(PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256).toBe(
      "e22cfd856be8698114106b1b24dd39232151c80b2ca22d3fd067b0caad15aa72",
    );
  });

  it("projects the crawl envelope with the frozen artifact identity and tool reservation", () => {
    const projection = new CurrentPlatformChannelCrawlPolicy().attest(crawlAuthority, crawlExecution);
    expect(projection).toEqual({
      policyRevision: PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256,
      executionEnvelopeSha256: PLATFORM_CHANNEL_CRAWL_ENVELOPE_SHA256,
      policyArtifactSha256: loadVerifiedPlatformAuthorityPolicyAsset().sha256,
      requiredCapMicrousd: 5_000_000n,
      operationReservationMicrousd: expect.any(BigInt),
    });
  });

  it.each([
    [{ purpose: "platform.acquisition" }],
    [{ subjectType: "schedule" }],
    [{ subjectId: "not-a-uuid" }],
    [{ crawlRunId: "not-a-uuid" }],
    [{ requestSha256: "short" }],
    [{ technicalPolicyRevision: "f".repeat(64) }],
    [{ authorizedCapMicrousd: 0n }],
  ])("rejects a malformed crawl authority case %#", (override) => {
    expect(() =>
      new CurrentPlatformChannelCrawlPolicy().attest({ ...crawlAuthority, ...override } as never, crawlExecution),
    ).toThrow("PLATFORM_EGRESS_CURRENT_POLICY_UNAVAILABLE");
  });

  it.each([
    [{ kind: "model", modelOp: "generateText" }],
    [{ kind: "tool", toolId: "http.get", toolVersion: "1.0.0" }],
    [{ kind: "tool", toolId: "crawl4ai.render", toolVersion: "2.0.0" }],
  ])("rejects execution outside the closed crawl tool envelope %#", (execution) => {
    expect(() =>
      new CurrentPlatformChannelCrawlPolicy().attest(crawlAuthority, execution as never),
    ).toThrow("PLATFORM_EGRESS_CURRENT_POLICY_UNAVAILABLE");
  });
});
