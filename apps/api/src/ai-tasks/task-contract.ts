/**
 * A domain AI Task (controlled "agent") — PRD 9.4/9.13. NOT a monolithic
 * super-agent: each task has a narrow goal, a declared I/O schema, a model
 * policy, a bounded tool whitelist, a budget, a risk level, and a human gate.
 * Workflows (Temporal) sequence tasks; the ToolBroker enforces the whitelist,
 * budget, compliance and rate limits at the call site (9.11). Adding an agent =
 * adding a contract here.
 */
export interface AiTaskContract {
  id: string; // e.g. 'company_understanding.extract_claims'
  description: string;
  /** JSON Schema the model output must satisfy (validated + one repair retry). */
  outputSchema: Record<string, unknown>;
  /** Optional JSON Schema for the task input (documents/validates the prompt payload). */
  inputSchema?: Record<string, unknown>;
  /** Model name the 中转站 resolves (business-need selection; may be a model-group with fallback). */
  model: string;
  risk: 'low' | 'medium' | 'high';
  /** Output requires human approval before outbound use? */
  humanGate: boolean;
  /**
   * Bounded tool whitelist (PRD 9.11): the ToolBroker rejects any tool call
   * whose id is not listed here. Empty/omitted = pure generation task with NO
   * tool access. This is what makes "bounded tools" enforced in code, not prose.
   */
  allowedTools?: string[];
  /** Hard budget ceiling for one task invocation (reserve-then-settle in the broker). */
  maxCostCents?: number;
  /** Per-invocation timeout for the model call. */
  timeoutMs?: number;
  /** Retry budget for transient failures (broker/activity level). */
  retry?: number;
  /** Max concurrent tool invocations this task may hold. */
  concurrency?: number;
  /** Pinned tool-contract version compatibility (semver range or exact). */
  toolVersion?: string;
}
