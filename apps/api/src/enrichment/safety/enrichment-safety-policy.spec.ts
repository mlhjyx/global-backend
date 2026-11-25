import { describe, expect, it } from "vitest";
import {
  CONTROLLED_ENRICHMENT_FINDERS,
  CONTROLLED_ENRICHMENT_PROVIDERS,
  CONTROLLED_ENRICHMENT_VERIFIERS,
  aggregateEnrichmentHeadStatus,
  areOriginalStepFactsCoherent,
  controlledFinderResultSchema,
  controlledVerificationResultSchema,
  findCommittedContactDecision,
  isActiveOriginalEnrichmentFact,
  isClosedOriginalEnrichmentStep,
  isControlledEnrichmentFinder,
  isControlledEnrichmentProvider,
  isControlledEnrichmentVerifier,
  isControlledEnrichmentVerifierOrSmtp,
  isControlledFinderResultSchema,
  isReadyOriginalEnrichmentStep,
  isSupportedControlledEnrichmentSlot,
  isTerminalEnrichmentDispatchPhase,
} from "./enrichment-safety-policy";
import type { EnrichmentContactApplyDecision } from "./enrichment-domain-commit";

const CONTACT_A = "00000000-0000-4000-8000-000000000001";
const CONTACT_B = "00000000-0000-4000-8000-000000000002";

function appliedDecision(
  contactId: string,
  status: EnrichmentContactApplyDecision["status"] = "APPLIED",
): EnrichmentContactApplyDecision {
  return {
    status,
    contactId,
    reasonCode: status === "SAVE_PENDING" ? "INPUT_CONFLICT" : "STORED",
    state: status === "SAVE_PENDING" ? null : "VALID",
    pointRefs: [],
    eventRefs: [],
    attemptRefs: [],
    newCandidatePoints: 0,
  };
}

describe("enrichment-safety-policy (single source of truth)", () => {
  it("exposes closed controlled finder/verifier sets and schemas consistently", () => {
    expect(CONTROLLED_ENRICHMENT_FINDERS).toEqual(["hunter", "prospeo"]);
    expect(CONTROLLED_ENRICHMENT_VERIFIERS).toEqual([
      "millionverifier",
      "emailable",
      "zerobounce",
    ]);
    expect(CONTROLLED_ENRICHMENT_PROVIDERS).toEqual([
      "hunter",
      "prospeo",
      "millionverifier",
      "emailable",
      "zerobounce",
    ]);

    expect(isControlledEnrichmentFinder("hunter")).toBe(true);
    expect(isControlledEnrichmentFinder("prospeo")).toBe(true);
    expect(isControlledEnrichmentFinder("findymail")).toBe(false);
    expect(isControlledEnrichmentFinder("apollo")).toBe(false);

    expect(isControlledEnrichmentVerifier("millionverifier")).toBe(true);
    expect(isControlledEnrichmentVerifier("emailable")).toBe(true);
    expect(isControlledEnrichmentVerifier("zerobounce")).toBe(true);
    expect(isControlledEnrichmentVerifier("truelist")).toBe(false);
    expect(isControlledEnrichmentVerifierOrSmtp("smtp_self")).toBe(true);
    expect(isControlledEnrichmentVerifierOrSmtp("truelist")).toBe(false);

    expect(isControlledEnrichmentProvider("prospeo")).toBe(true);
    expect(isControlledEnrichmentProvider("pdl")).toBe(false);

    expect(controlledFinderResultSchema("hunter")).toBe(
      "contact-email-find-hunter/v1",
    );
    expect(controlledFinderResultSchema("prospeo")).toBe(
      "contact-email-find-prospeo/v1",
    );
    expect(isControlledFinderResultSchema("contact-email-find-hunter/v1")).toBe(
      true,
    );
    expect(
      isControlledFinderResultSchema("contact-email-find-prospeo/v1"),
    ).toBe(true);
    expect(
      isControlledFinderResultSchema("contact-email-find-findymail/v1"),
    ).toBe(false);

    expect(controlledVerificationResultSchema("SMTP", "smtp_self")).toBe(
      "smtp-probe-verdict/v1",
    );
    expect(
      controlledVerificationResultSchema("VERIFY", "millionverifier"),
    ).toBe("contact-email-verify-millionverifier/v1");
    expect(controlledVerificationResultSchema("VERIFY", "truelist")).toBeNull();
  });

  it("validates controlled enrichment slots fail-closed", () => {
    expect(
      isSupportedControlledEnrichmentSlot({
        phase: "FINDER",
        provider: "hunter",
        toolId: "contact_email.find.hunter",
      }),
    ).toBe(true);
    expect(
      isSupportedControlledEnrichmentSlot({
        phase: "FINDER",
        provider: "prospeo",
        toolId: "contact_email.find.prospeo",
      }),
    ).toBe(true);
    expect(
      isSupportedControlledEnrichmentSlot({
        phase: "FINDER",
        provider: "findymail",
        toolId: "contact_email.find.findymail",
      }),
    ).toBe(false);
    expect(
      isSupportedControlledEnrichmentSlot({
        phase: "SMTP",
        provider: "smtp_self",
        toolId: "smtp.rcpt_probe",
      }),
    ).toBe(true);
    expect(
      isSupportedControlledEnrichmentSlot({
        phase: "VERIFY",
        provider: "emailable",
        toolId: "contact_email.verify.emailable",
      }),
    ).toBe(true);
    expect(
      isSupportedControlledEnrichmentSlot({
        phase: "VERIFY",
        provider: "emailable",
        toolId: "contact_email.verify.zerobounce",
      }),
    ).toBe(false);
  });

  it("reads a committed contact decision from snapshot or returns null cleanly", () => {
    expect(findCommittedContactDecision(null, CONTACT_A)).toBeNull();
    expect(findCommittedContactDecision({}, CONTACT_A)).toBeNull();
    const decision = appliedDecision(CONTACT_A);
    expect(
      findCommittedContactDecision({ contacts: [decision] }, CONTACT_A),
    ).toEqual(decision);
    expect(
      findCommittedContactDecision({ contacts: [decision] }, CONTACT_B),
    ).toBeNull();
  });

  it("evaluates step-fact coherence and head-status aggregation consistently", () => {
    expect(isTerminalEnrichmentDispatchPhase("SETTLED")).toBe(true);
    expect(isTerminalEnrichmentDispatchPhase("SETTLED_WAITING_APPLY")).toBe(
      true,
    );
    expect(isTerminalEnrichmentDispatchPhase("RESERVED")).toBe(false);

    const closedFact = {
      operationId: "op-1",
      status: "SETTLED",
      dispatchPhase: "SETTLED",
      domainState: "APPLIED",
    };
    const waitingApplyFact = {
      operationId: "op-2",
      status: "SETTLED",
      dispatchPhase: "SETTLED_WAITING_APPLY",
      domainState: "PENDING",
    };
    const releasedFact = {
      operationId: "op-3",
      status: "RELEASED",
      dispatchPhase: "RELEASED",
      domainState: "PENDING",
    };

    expect(isClosedOriginalEnrichmentStep(closedFact)).toBe(true);
    expect(isReadyOriginalEnrichmentStep(waitingApplyFact)).toBe(true);
    expect(isActiveOriginalEnrichmentFact(closedFact)).toBe(false);
    expect(isActiveOriginalEnrichmentFact(releasedFact)).toBe(false);
    expect(isActiveOriginalEnrichmentFact(waitingApplyFact)).toBe(true);
    expect(areOriginalStepFactsCoherent([closedFact, releasedFact])).toBe(true);
    expect(areOriginalStepFactsCoherent([closedFact, waitingApplyFact])).toBe(
      false,
    );

    expect(
      aggregateEnrichmentHeadStatus(
        [appliedDecision(CONTACT_A)],
        [
          {
            contact_id: CONTACT_A,
            dispatch_phase: "SETTLED",
            domain_state: "APPLIED",
            operation_id: "op-1",
            operation_status: "SETTLED",
          },
        ],
        0,
        1,
      ),
    ).toBe("COMPLETED");

    expect(
      aggregateEnrichmentHeadStatus(
        [appliedDecision(CONTACT_A)],
        [
          {
            contact_id: CONTACT_A,
            dispatch_phase: "SETTLED_WAITING_APPLY",
            domain_state: "PENDING",
            operation_id: "op-2",
            operation_status: "SETTLED",
          },
        ],
        1,
        1,
      ),
    ).toBe("APPLY_PENDING");

    expect(
      aggregateEnrichmentHeadStatus(
        [appliedDecision(CONTACT_A)],
        [
          {
            contact_id: CONTACT_A,
            dispatch_phase: "SETTLED",
            domain_state: "APPLIED",
            operation_id: "op-1",
            operation_status: "SETTLED",
          },
        ],
        1,
        2,
      ),
    ).toBe("RUNNING");
  });
});
