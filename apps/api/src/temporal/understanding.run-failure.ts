import {
  describeRunFailure,
  type RunFailureDescription,
} from './discovery.run-failure';

/**
 * Stages of the understanding workflow that can stop it with an error no retry
 * absorbed. The names match the activities, except `extract`, which covers the
 * per-page claim and offering extraction that runs as one step.
 */
export const UNDERSTANDING_STAGES = [
  'crawlWebsite',
  'selectSubpages',
  'crawlPages',
  'extract',
  'persistClaims',
  'persistOfferings',
  'persistPublicContacts',
  'extractProfile',
] as const;
export type UnderstandingStage = (typeof UNDERSTANDING_STAGES)[number];

/**
 * What company_profile records about the error that stopped understanding: a
 * stage and a failure type, never a message or anything crawled.
 */
export interface UnderstandingFailure extends RunFailureDescription {
  readonly stage: UnderstandingStage;
}

export function describeUnderstandingFailure(
  stage: UnderstandingStage,
  error: unknown,
): UnderstandingFailure {
  return { stage, ...describeRunFailure(error) };
}

/** One closed token, the shape the shared run-failure classifier produces. */
const FAILURE_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;

/**
 * The `stage:errorType` text `company_profile.understanding_last_error` keeps,
 * or null when the failure is not a known stage plus a closed type. Then
 * nothing is written: the column never carries free text, and the migration's
 * CHECK admits only this shape.
 */
export function understandingFailureLabel(failure: unknown): string | null {
  if (!failure || typeof failure !== 'object') return null;
  const { stage, errorType } = failure as { stage?: unknown; errorType?: unknown };
  if (
    typeof stage !== 'string' ||
    !(UNDERSTANDING_STAGES as readonly string[]).includes(stage)
  ) {
    return null;
  }
  if (typeof errorType !== 'string' || !FAILURE_TYPE.test(errorType)) return null;
  return `${stage}:${errorType}`;
}
