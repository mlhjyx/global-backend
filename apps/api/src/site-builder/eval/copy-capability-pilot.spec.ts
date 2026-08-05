import { describe, expect, it } from "vitest";

import {
  COPY_CAPABILITY_PILOT_PLAN,
  validateCopyCapabilityPilotPlan,
} from "./copy-capability-pilot";

describe("Copy capability pilot preparation contract", () => {
  it("freezes one zero-call probe plan per current Copy candidate", () => {
    expect(COPY_CAPABILITY_PILOT_PLAN).toMatchObject({
      schemaVersion: "site-builder-copy-capability-pilot-plan/2026-08-05-v2",
      planId: "site-builder-copy-capability-pilot/2026-08-05-v2",
      executionStatus:
        "FAKE_GATEWAY_DURABLE_RUNNER_READY_REAL_DISPATCH_BLOCKED",
      dispatchAuthorization: "NOT_AUTHORIZED",
      observedModelWireCalls: 0,
      observedModelCost: { CNY: 0, USD: 0 },
      evidenceClassification: "CAPABILITY_ONLY_NOT_QUALITY_EVIDENCE",
      taskId: "site_builder.copy",
      plannedExecutions: 3,
      maximumWireCalls: 6,
      maximumRepairCallsPerExecution: 1,
      cachePolicy: "disabled",
      settlementPolicy: "known_per_physical_call_required",
      fixedCommitPolicy: "separate_create_only_manifest_required",
      credentialPolicy: "finite_exact_alias_protocol_allowlist_required",
      completedTestOnlyGates: [
        "append_only_hash_chained_execution_ledger",
        "unique_execution_and_wire_claim",
        "runtime_receipt_bound_to_completed_ledger",
        "global_execution_and_wire_caps",
        "post_wire_failure_durably_freezes_campaign",
        "structured_output_failure_cannot_be_business_validated",
        "loopback_only_native_adapter_factory",
      ],
      blockingGates: [
        "real_gateway_fixed_commit_manifest",
        "real_gateway_credential_attestation",
        "real_gateway_authorization_reservation",
        "real_gateway_settlement_observer",
        "real_gateway_post_wire_freeze",
        "real_gateway_repair_payload_binding",
      ],
    });
    expect(COPY_CAPABILITY_PILOT_PLAN.executions).toEqual([
      expect.objectContaining({
        alias: "gpt-5.6-terra",
        protocol: "openai_responses",
        reasoning: "medium",
      }),
      expect.objectContaining({
        alias: "gpt-5.6-sol",
        protocol: "openai_responses",
        reasoning: "high",
      }),
      expect.objectContaining({
        alias: "claude-sonnet-5",
        protocol: "anthropic_messages",
        reasoning: "medium",
      }),
    ]);
    for (const execution of COPY_CAPABILITY_PILOT_PLAN.executions) {
      expect(execution).toMatchObject({
        kind: "capability_probe",
        fixtureId: "copy-factual-claims",
        maximumWireCalls: 2,
        maximumRepairCalls: 1,
        maximumOutputTokens: 4000,
        timeoutMs: 120_000,
        requirements: {
          structuredOutput: true,
          reportsUsage: true,
          reportsModel: true,
          reportsRequestId: true,
          exactReportedModel: true,
          knownSettlement: true,
          noProviderWarnings: true,
        },
      });
    }
    expect(COPY_CAPABILITY_PILOT_PLAN.source).toEqual(
      expect.objectContaining({
        fixtureId: "copy-factual-claims",
        taskContractVersion: "site-builder-task-contract/site_builder.copy/v2",
        inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        outputSchemaDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
        promptDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(() =>
      validateCopyCapabilityPilotPlan(COPY_CAPABILITY_PILOT_PLAN),
    ).not.toThrow();
    expect(Object.isFrozen(COPY_CAPABILITY_PILOT_PLAN)).toBe(true);
    expect(Object.isFrozen(COPY_CAPABILITY_PILOT_PLAN.executions)).toBe(true);
  });

  it.each([
    ["authorization", { dispatchAuthorization: "AUTHORIZED" }],
    ["wire cap", { maximumWireCalls: 7 }],
    [
      "candidate",
      { executions: COPY_CAPABILITY_PILOT_PLAN.executions.slice(1) },
    ],
  ])("rejects %s drift before a future dispatcher", (_name, mutation) => {
    expect(() =>
      validateCopyCapabilityPilotPlan({
        ...COPY_CAPABILITY_PILOT_PLAN,
        ...mutation,
      }),
    ).toThrow("COPY_CAPABILITY_PILOT_PLAN_DRIFT");
  });
});
