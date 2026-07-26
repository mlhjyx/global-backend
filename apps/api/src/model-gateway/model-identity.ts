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
  if (!reportedModel) return undefined;
  if (reportedModel === requestedModel) return requestedModel;
  if (!transport) return undefined;
  const aliases = TRUSTED_MODEL_IDENTITY_ALIASES[requestedModel];
  const alias = aliases?.find(
    (candidate) =>
      candidate.reportedModel === reportedModel &&
      candidate.transport === transport,
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
