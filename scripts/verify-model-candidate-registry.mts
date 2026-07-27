import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

import {
  getModelCandidateCatalogEntry,
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE,
  SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
} from '../apps/api/src/site-builder/agents/model-candidate-baseline';
import { modelPolicyRegistry } from '../apps/api/src/site-builder/agents/model-policy.registry';
import {
  SITE_BUILDER_MODEL_PROFILES,
  type SiteBuilderModelProfileId,
} from '../apps/api/src/site-builder/agents/model-profiles';

type CandidateReader = typeof modelPolicyRegistry.getCandidates;

export function verifyModelCandidateRegistry(
  readRegisteredCandidates: CandidateReader = (profile) =>
    modelPolicyRegistry.getCandidates(profile),
): void {
  assert.notEqual(
    SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID,
    'site-builder-model-policy/v3',
    'candidateBaselineId must remain independent from execution policy v3',
  );

  for (const profile of Object.keys(
    SITE_BUILDER_MODEL_PROFILES,
  ) as SiteBuilderModelProfileId[]) {
    const pool =
      SITE_BUILDER_MODEL_CANDIDATE_BASELINE.profileCandidatePools.find(
        (candidatePool) => candidatePool.profile === profile,
      );
    const expected =
      pool?.candidates.map((candidate) => {
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
      }) ?? [];
    assert.deepEqual(
      readRegisteredCandidates(profile),
      expected,
      `${profile} actual registry candidates differ from the machine baseline`,
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  verifyModelCandidateRegistry();
  console.log(
    `model candidate registry PASS — ${SITE_BUILDER_MODEL_CANDIDATE_BASELINE_ID}`,
  );
}
