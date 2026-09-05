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
