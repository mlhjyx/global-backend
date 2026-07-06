/** Context threaded into every model call — for routing, tenancy, cost, trace. */
export interface AiContext {
  workspaceId: string;
  userId?: string;
  correlationId?: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface ModelResult<T> {
  data: T;
  provider: string; // which provider served it
  model: string;
  usage?: ModelUsage;
}

export interface GenerateTextInput {
  task: string; // routing key, e.g. 'company_understanding'
  prompt: string;
  system?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GenerateStructuredInput {
  task: string;
  prompt: string;
  system?: string;
  schema: Record<string, unknown>; // JSON Schema the output must satisfy
  maxTokens?: number;
}

export interface EmbedInput {
  task: string;
  input: string[];
}

export type ModelOp = 'generateText' | 'generateStructured' | 'embed';

export interface HealthStatus {
  healthy: boolean;
  detail?: string;
}
