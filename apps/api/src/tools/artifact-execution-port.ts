import type { BudgetReservation } from "./budget-store";
import type { Tool, ToolResult } from "./tool-contract";

/**
 * Company/contact row id an artifact-producing call is bound to (G3 spec
 * 2026-09-24 §4.1). Carries ids only, never identity text.
 */
export interface ArtifactSubjectRef {
  readonly subjectType: "company" | "contact";
  readonly subjectId: string;
}

export type ArtifactExecutionDenialReason =
  | "SUBJECT_BINDING_INVALID"
  | "SUBJECT_TOMBSTONED"
  | "SUBJECT_SUPPRESSED"
  | "SUBJECT_BINDING_HOLD";

export type ArtifactExecutionAdmission =
  | Readonly<{ status: "BOUND"; subjectRef: ArtifactSubjectRef }>
  | Readonly<{ status: "DENIED"; reason: ArtifactExecutionDenialReason }>;

/**
 * The one physical-execution surface for PERSONAL_DATA artifact producers.
 * ToolBroker owns the ordering (reserve → admit → limiter → execute →
 * persist); this port owns the RLS subject checks, object persistence,
 * atomic manifest settlement and verified replay.
 */
export interface ArtifactExecutionPort {
  /** Pre-wire: subject exists in the workspace, is not tombstoned or suppressed. */
  admit(input: {
    readonly workspaceId: string;
    readonly resultSchema: string;
    readonly subjectRef: ArtifactSubjectRef;
  }): Promise<ArtifactExecutionAdmission>;
  /**
   * Post-wire: persist the bounded artifact and settle the reservation with
   * its closed reference. Returns the exact shape a later replay materializes.
   */
  persist<I, O>(input: {
    readonly reservation: BudgetReservation;
    readonly tool: Tool<I, O>;
    readonly input: I;
    readonly result: ToolResult<O>;
    readonly subjectRef: ArtifactSubjectRef;
  }): Promise<ToolResult<O>>;
  /** Replays a settled artifact operation from verified object bytes. */
  replay<I, O>(input: {
    readonly reservation: BudgetReservation;
    readonly tool: Tool<I, O>;
  }): Promise<ToolResult<O>>;
}
