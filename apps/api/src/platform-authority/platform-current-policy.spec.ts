import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CurrentPlatformExecutionPolicy } from "./platform-current-policy";

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
