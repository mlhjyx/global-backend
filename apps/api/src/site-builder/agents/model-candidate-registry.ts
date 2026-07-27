import type { ModelCandidateRoute } from '@global/contracts';

import {
  getModelCandidateCatalogEntry,
  getModelProfileCandidatePool,
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
} from './model-candidate-baseline';
import type { SiteBuilderModelProfileId } from './model-profiles';

export function modelCandidateRoutesFromBaseline(
  profileId: SiteBuilderModelProfileId,
): readonly ModelCandidateRoute[] {
  const pool = getModelProfileCandidatePool(profileId);
  if (!pool) return [];
  return pool.candidates.map((candidate) => {
    const catalog = getModelCandidateCatalogEntry(candidate.alias);
    return {
      state: 'targetCandidate',
      lifecycle: catalog.status === 'preview' ? 'preview_only' : 'candidate',
      route: { primary: candidate.alias, fallbacks: [] },
      activation: pool.activation,
      notes: [
        `candidateBaselineId=${SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID}`,
        `status=${catalog.status}`,
        `expectedProtocol=${candidate.expectedProtocol}`,
        `gate=${candidate.gate}`,
      ].join('; '),
    };
  });
}
