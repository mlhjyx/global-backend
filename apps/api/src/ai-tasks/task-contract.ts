/**
 * A domain AI Task (controlled "agent") — PRD 9.4. NOT a monolithic super-agent:
 * each task has a narrow goal, a declared I/O schema, a model policy, a risk
 * level, and a human gate. Workflows (Temporal) sequence tasks; policy/tools
 * constrain them. Adding an agent = adding a contract here.
 */
export interface AiTaskContract {
  id: string; // e.g. 'company_understanding.extract_claims'
  description: string;
  outputSchema: Record<string, unknown>; // JSON Schema the model output must satisfy
  model: string; // model name the 中转站 resolves (business-need selection; can be a model-group with its own fallback)
  risk: 'low' | 'medium' | 'high';
  humanGate: boolean; // output requires human approval before outbound use?
}
