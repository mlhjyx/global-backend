import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  COPY_SONNET_NATIVE_QUALITY_PROMOTION_EVIDENCE,
  modelPolicyRegistry,
} from './model-policy.registry';
import { resolveTaskRoute } from './task-routes';

function artifactBytes(repoRelativePath: string): Buffer {
  return readFileSync(
    new URL(`../../../../../${repoRelativePath}`, import.meta.url),
  );
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('Copy Sonnet native quality promotion approval', () => {
  it('binds the Git-reviewed 12/12 quality evidence that predates separate route adoption', () => {
    const evidence = COPY_SONNET_NATIVE_QUALITY_PROMOTION_EVIDENCE;
    const bytes = artifactBytes(evidence.acceptanceArtifactPath);
    const acceptance = JSON.parse(bytes.toString('utf8')) as {
      classification: string;
      acceptedEvidence: {
        path: string;
        fileSha256: string;
        artifactDigest: string;
      };
      gitReview: {
        pullRequest: number;
        mergeCommit: string;
        mergeMethod: string;
        requiredChecksResult: string;
        unresolvedReviewThreads: number;
      };
      acceptedBoundary: {
        acceptedExecutions: number;
        candidate: {
          alias: string;
          evaluationProtocol: string;
          transportProtocol: string;
        };
        modelPromotion: string;
        productionRouteAdoption: string;
      };
    };

    expect(sha256(bytes)).toBe(evidence.acceptanceArtifactSha256);
    expect(acceptance).toMatchObject({
      classification: 'GIT_REVIEWED_NATIVE_QUALITY_EVIDENCE',
      acceptedEvidence: {
        path: evidence.qualityArtifactPath,
        fileSha256: evidence.qualityArtifactSha256,
        artifactDigest: evidence.qualityArtifactDigest,
      },
      gitReview: {
        pullRequest: 396,
        mergeCommit: 'd49f4642868243b2bfb912d2b830ef866d42b13b',
        mergeMethod: 'MERGE_COMMIT',
        requiredChecksResult: 'PASS',
        unresolvedReviewThreads: 0,
      },
      acceptedBoundary: {
        acceptedExecutions: 12,
        candidate: {
          alias: 'claude-sonnet-5',
          evaluationProtocol: 'anthropic_messages',
          transportProtocol: 'anthropic-messages',
        },
        modelPromotion: 'APPROVED_FOR_SEPARATE_ROUTE_ADOPTION',
        productionRouteAdoption: 'NOT_ADOPTED',
      },
    });
  });

  it('keeps the approved Sonnet Messages route immutable for the separate adoption gate', () => {
    expect(
      modelPolicyRegistry.getApprovedTaskPromotion('site_builder.copy'),
    ).toEqual({
      taskId: 'site_builder.copy',
      profile: 'copy.premium',
      route: { primary: 'claude-sonnet-5', fallbacks: [] },
      transport: 'anthropic-messages',
      reasoningEffort: 'medium',
      promotionEvidenceId:
        'site-builder-copy-sonnet-native-quality-promotion/2026-08-12-v1',
      routeAdoption: 'active',
    });

    expect(resolveTaskRoute('site_builder.copy').policy).toMatchObject({
      promotionEvidenceId:
        'site-builder-copy-sonnet-native-quality-promotion/2026-08-12-v1',
    });
  });
});
