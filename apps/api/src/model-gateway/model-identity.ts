export interface ModelIdentityProvenance {
  requestedModel: string;
  reportedModel?: string | null;
  resolvedModel: string;
  transport?: string;
}

interface TrustedModelIdentityAlias {
  reportedModel: string;
  transport: string;
}

const TRUSTED_MODEL_IDENTITY_ALIASES: Readonly<
  Record<string, readonly TrustedModelIdentityAlias[]>
> = Object.freeze({
  'gemini-3.5-flash': Object.freeze([
    {
      reportedModel: 'gemini-default',
      transport: 'google-generate-content',
    },
  ]),
  // OpenOx (observed 2026-10-07): the same DeepSeek v4 pro model is reported
  // with a provider prefix in stream chunks and as a dated GA build in plain
  // chat-completions bodies. Any other name, including another vendor family,
  // still fails closed.
  'deepseek-v4-pro': Object.freeze([
    {
      reportedModel: 'deepseek.deepseek-v4-pro',
      transport: 'openai-chat-completions',
    },
    {
      reportedModel: 'deepseek-v4-pro-ga-260813',
      transport: 'openai-chat-completions',
    },
  ]),
  // OpenOx (observed 2026-10-10/11): requests for deepseek-v4-pro were at
  // times served by DeepSeek V4 Flash and reported under this build name. The
  // alias proves only a flash identity; a pro request accepts it solely through
  // a deployment-approved substitution (model-identity-substitutes.ts).
  'deepseek-v4-flash': Object.freeze([
    {
      reportedModel: 'deepseek-ai/DeepSeek-V4-Flash-0731',
      transport: 'openai-chat-completions',
    },
  ]),
});

const REPORTED_MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/u;

/**
 * Treat the provider response as hostile input. Only identifiers that fit the
 * durable model projection may cross into errors, traces or spend metadata.
 * The return value is a new bounded snapshot; callers must never retain the
 * original response field.
 */
export function canonicalReportedModelIdentifier(
  value: unknown,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (
    !REPORTED_MODEL_IDENTIFIER.test(trimmed) ||
    Buffer.byteLength(trimmed, 'utf8') > 120
  ) {
    return undefined;
  }
  return trimmed;
}

/**
 * Resolve only repository-reviewed upstream aliases. Alias resolution requires
 * the exact protocol that produced the reviewed response shape; callers that
 * cannot prove transport may accept only an exact reported model.
 */
export function resolveReportedModelIdentity(
  requestedModel: string,
  reportedModel?: string | null,
  transport?: string,
): string | undefined {
  const reported = canonicalReportedModelIdentifier(reportedModel);
  if (!reported) return undefined;
  if (reported === requestedModel) return requestedModel;
  if (!transport) return undefined;
  const aliases = TRUSTED_MODEL_IDENTITY_ALIASES[requestedModel];
  const alias = aliases?.find(
    (candidate) =>
      candidate.reportedModel === reported && candidate.transport === transport,
  );
  return alias ? requestedModel : undefined;
}

/** Models whose upstream identity this repository has reviewed. */
export function isReviewedModelIdentity(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(
    TRUSTED_MODEL_IDENTITY_ALIASES,
    model,
  );
}

/**
 * Resolve a reported identity to the requested model or, failing that, to one
 * of the substitutes the caller was explicitly allowed for this call. Each
 * candidate resolves only through its own exact name or reviewed aliases.
 */
export function resolveReportedModelIdentityAmong(
  requestedModel: string,
  substitutes: readonly string[],
  reportedModel?: string | null,
  transport?: string,
): string | undefined {
  const requested = resolveReportedModelIdentity(
    requestedModel,
    reportedModel,
    transport,
  );
  if (requested) return requested;
  for (const substitute of substitutes) {
    if (substitute === requestedModel) continue;
    const resolved = resolveReportedModelIdentity(
      substitute,
      reportedModel,
      transport,
    );
    if (resolved) return resolved;
  }
  return undefined;
}

export function hasTrustedModelIdentity(
  provenance: ModelIdentityProvenance,
): boolean {
  return (
    provenance.resolvedModel === provenance.requestedModel &&
    resolveReportedModelIdentity(
      provenance.requestedModel,
      provenance.reportedModel,
      provenance.transport,
    ) === provenance.resolvedModel
  );
}
