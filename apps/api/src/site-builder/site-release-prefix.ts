export function siteReleaseArtifactPrefix(
  workspaceId: string,
  siteId: string,
  releaseId: string,
): string {
  return `ws/${workspaceId}/sites/${siteId}/releases/${releaseId}`;
}

export function legacySiteReleaseArtifactPrefix(
  siteId: string,
  releaseId: string,
): string {
  return `sites/${siteId}/releases/${releaseId}`;
}

export function isAllowedSiteReleaseArtifactPrefix(
  artifactPrefix: unknown,
  workspaceId: unknown,
  siteId: unknown,
  releaseId: unknown,
): boolean {
  if (
    typeof artifactPrefix !== 'string' ||
    typeof workspaceId !== 'string' ||
    typeof siteId !== 'string' ||
    typeof releaseId !== 'string'
  ) {
    return false;
  }
  return (
    artifactPrefix === siteReleaseArtifactPrefix(workspaceId, siteId, releaseId) ||
    artifactPrefix === legacySiteReleaseArtifactPrefix(siteId, releaseId)
  );
}
