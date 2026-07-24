import type { ModelExecutionTrace } from '@global/contracts';
import type { PaidCostContext } from '../site-builder/site-build-cost-ledger';

/** Context threaded into every model call — for routing, tenancy, cost, trace. */
export interface AiContext {
  /** 必须是真实 workspace uuid（ai_trace/usage_ledger @db.Uuid 列；伪值=记账静默失败）。 */
  workspaceId: string;
  userId?: string;
  /** 预算归账键（BudgetLedger reserve-then-settle 按 runId ?? workspaceId 归账）。 */
  runId?: string;
  correlationId?: string;
  /** Optional Site Builder policy evidence; copied to every gateway trace row. */
  modelPolicy?: ModelExecutionTrace;
  /** R4-B durable paid-operation namespace. Presence requires a persistent ledger. */
  paidCost?: PaidCostContext;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export type ModelResolutionSource = 'upstream_response' | 'requested_fallback';

export interface ModelResult<T> {
  data: T;
  provider: string; // which provider served it
  model: string;
  /** Model identifier reported by the upstream response, when present. */
  reportedModel?: string;
  /** Distinguishes upstream proof from a local requested-model fallback. */
  modelResolutionSource?: ModelResolutionSource;
  usage?: ModelUsage;
  /** 本次结果实际发生的模型调用数（generateStructured 校验-修复重试=2；缺省视为 1）——
   *  供**无 usage 上报**时按调用数结算预算，防修复调用被少记（否则退还预留的另一半，硬上界形同虚设）。 */
  callCount?: number;
}

export interface GenerateTextInput {
  task: string; // task id (trace/routing key), e.g. 'company_understanding.extract_claims'
  prompt: string;
  system?: string;
  model?: string; // model name for the 中转站 to resolve; omit → provider default
  maxTokens?: number;
  temperature?: number;
  /** reasoning 模型的思考预算（OpenAI 兼容 reasoning_effort）。copy 类任务 🔴 必配 low（02 §6）。 */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Per-call ceiling from the resolved task policy; takes precedence over legacy registry defaults. */
  maxCostCents?: number;
  /** 调用方超时/取消信号，透传到底层 fetch——超时即真 abort，不留后台弃单继续烧钱。 */
  signal?: AbortSignal;
}

export interface GenerateStructuredInput {
  task: string;
  prompt: string;
  system?: string;
  model?: string;
  schema: Record<string, unknown>; // JSON Schema the output must satisfy
  /**
   * Optional task-level deterministic output gate. The router executes it after
   * schema validation/repair but before recording an OK trace, so a rejected
   * artifact remains an observable, billable failed attempt.
   */
  validateOutput?: (data: unknown) => void;
  /**
   * Permit the router's single structured-output repair call to correct a
   * schema-valid artifact rejected by the deterministic task gate. The repair
   * remains subject to the same schema and task gate; callers must opt in.
   */
  repairTaskOutput?: boolean;
  maxTokens?: number;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Per-call ceiling from the resolved task policy; takes precedence over legacy registry defaults. */
  maxCostCents?: number;
  /** 调用方超时/取消信号，透传到底层 fetch（含网关内修复重试的两次调用）。 */
  signal?: AbortSignal;
}

export const VISION_REVIEW_MATERIAL_CLASSES = [
  'workspace_site_screenshot',
  'model_eval_fixture',
] as const;

export type VisionReviewMaterialClass =
  (typeof VISION_REVIEW_MATERIAL_CLASSES)[number];

export interface VisionReviewImage {
  /** Bounded provenance only; callers pass bytes, never a URL or filesystem path. */
  materialClass: VisionReviewMaterialClass;
  /** Required for runtime screenshots; forbidden for immutable eval fixtures. */
  workspaceId?: string;
  artifactId: string;
  sha256: string;
  mimeType: 'image/png';
  bytes: Uint8Array;
  target: {
    locale: string;
    pageId: string;
    breakpoint: 375 | 768 | 1440;
  };
}

/**
 * Explicit evaluation/runtime seam for screenshot review. It is deliberately
 * separate from generateStructured so text-only callers cannot smuggle remote
 * image URLs into generic prompts.
 */
export interface ReviewVisionInput {
  task: string;
  prompt: string;
  system?: string;
  /** Required: vision calls never inherit a provider default or alias silently. */
  model: string;
  schema: Record<string, unknown>;
  images: readonly VisionReviewImage[];
  validateOutput?: (data: unknown) => void;
  maxTokens: number;
  maxCostCents: number;
  signal?: AbortSignal;
}

export interface EmbedInput {
  task: string;
  input: string[];
}

export type ModelOp =
  | 'generateText'
  | 'generateStructured'
  | 'reviewVision'
  | 'embed';

export interface HealthStatus {
  healthy: boolean;
  detail?: string;
}
