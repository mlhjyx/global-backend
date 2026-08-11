import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { VERIFIED_GATEWAY_MODEL_TRANSPORTS } from '../../model-gateway/model-transports';
import { canonicalDigest } from '../../model-runtime/context-engine';
import { modelPolicyRegistry } from './model-policy.registry';
import { resolveTaskRoute } from './task-routes';

function artifactBytes(repoRelativePath: string): Buffer {
  return readFileSync(
    new URL(`../../../../../${repoRelativePath}`, import.meta.url),
  );
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('Copy Sonnet native production route adoption', () => {
  it('records the route adoption only after the reviewed route merge', () => {
    const path =
      'docs/evidence/site-builder/m1-g-copy-sonnet-native-route-adoption-git-review-acceptance-2026-08-12.json';
    const bytes = artifactBytes(path);
    const artifact = JSON.parse(bytes.toString('utf8')) as {
      classification: string;
      acceptedRouteAdoption: {
        promotionAcceptanceArtifact: { fileSha256: string; artifactDigest: string };
        route: { taskId: string; primary: string; transport: string; reasoningEffort: string; fallbacks: string[] };
        rollback: { env: string; primary: string; fallbacks: string[]; reasoningEffort: string };
      };
      gitReview: {
        pullRequest: number;
        reviewedHeadCommit: string;
        mergeCommit: string;
        mergeMethod: string;
        requiredChecksResult: string;
        unresolvedReviewThreads: number;
      };
      acceptedBoundary: {
        sourceLevelProductionRouteAdoption: string;
        deploymentOrRuntimeEvidence: string;
        newModelDispatch: boolean;
      };
      artifactDigest: string;
    };

    expect(artifact).toMatchObject({
      classification: 'GIT_REVIEWED_SOURCE_ROUTE_ADOPTION',
      acceptedRouteAdoption: {
        promotionAcceptanceArtifact: {
          fileSha256:
            'bd9cb0332a4cf6ec349a2f48bcc2ba7e0645281ec167cd243d782894be0633bf',
          artifactDigest:
            '0e51ccc43fa5446b750a6744144d46bcc35ff59b56cdd1303738850b3d19995c',
        },
        route: {
          taskId: 'site_builder.copy',
          primary: 'claude-sonnet-5',
          transport: 'anthropic-messages',
          reasoningEffort: 'medium',
          fallbacks: [],
        },
        rollback: {
          env: 'SITE_BUILDER_MODEL_ROLLBACK_COPY=true',
          primary: 'deepseek-v4-pro',
          fallbacks: ['glm-5.2'],
          reasoningEffort: 'low',
        },
      },
      gitReview: {
        pullRequest: 398,
        reviewedHeadCommit: 'f571922ebe8a74012b14f06214e2e303e7a41ae0',
        mergeCommit: '7f856ce36e0b841ddcda56dc683f38f4856cb9f5',
        mergeMethod: 'MERGE_COMMIT',
        requiredChecksResult: 'PASS',
        unresolvedReviewThreads: 0,
      },
      acceptedBoundary: {
        sourceLevelProductionRouteAdoption: 'GIT_REVIEWED',
        deploymentOrRuntimeEvidence: 'NOT_PROVIDED',
        newModelDispatch: false,
      },
    });
    const { artifactDigest, ...withoutArtifactDigest } = artifact;
    expect(artifactDigest).toBe(canonicalDigest(withoutArtifactDigest));
    expect(sha256(bytes)).toBe(
      'ca9b3619f5e636851673234545b9cfffd53033bbaf57df00b50e9f1aea3e6703',
    );
  });

  it('binds route adoption to the Git-reviewed promotion merge rather than a mutable approval', () => {
    const path =
      'docs/evidence/site-builder/m1-g-copy-sonnet-native-promotion-git-review-acceptance-2026-08-12.json';
    const bytes = artifactBytes(path);
    const artifact = JSON.parse(bytes.toString('utf8')) as {
      classification: string;
      acceptedPromotion: {
        promotionEvidenceId: string;
        qualityAcceptanceArtifact: {
          fileSha256: string;
          artifactDigest: string;
        };
      };
      gitReview: {
        pullRequest: number;
        mergeCommit: string;
        mergeMethod: string;
        requiredChecksResult: string;
        unresolvedReviewThreads: number;
      };
      acceptedBoundary: {
        productionRouteAdoption: string;
        newModelDispatch: boolean;
      };
      artifactDigest: string;
    };

    expect(sha256(bytes)).toBe(
      'bd9cb0332a4cf6ec349a2f48bcc2ba7e0645281ec167cd243d782894be0633bf',
    );
    expect(artifact).toMatchObject({
      classification: 'GIT_REVIEWED_MODEL_PROMOTION',
      acceptedPromotion: {
        promotionEvidenceId:
          'site-builder-copy-sonnet-native-quality-promotion/2026-08-12-v1',
        qualityAcceptanceArtifact: {
          fileSha256:
            'a3cd5fc1028162b3c52601c1b917843f40d9d5e3bf4a9882fecfdbc51d01e7b3',
          artifactDigest:
            '803c9b29eb3de6eb185746a42dcfc720e8fe6f5cd7fbe76e5cb79a48599cde61',
        },
      },
      gitReview: {
        pullRequest: 397,
        mergeCommit: '99572fb099c304d60c8e0ee84f255a34118edf46',
        mergeMethod: 'MERGE_COMMIT',
        requiredChecksResult: 'PASS',
        unresolvedReviewThreads: 0,
      },
      acceptedBoundary: {
        productionRouteAdoption: 'PENDING_CURRENT_PR',
        newModelDispatch: false,
      },
      artifactDigest:
        '0e51ccc43fa5446b750a6744144d46bcc35ff59b56cdd1303738850b3d19995c',
    });
  });

  it('adopts only the approved Sonnet Messages route with the quality-matrix reasoning shape', () => {
    const approval = modelPolicyRegistry.getApprovedTaskPromotion(
      'site_builder.copy',
    );
    expect(approval).toMatchObject({
      route: { primary: 'claude-sonnet-5', fallbacks: [] },
      transport: 'anthropic-messages',
      reasoningEffort: 'medium',
      routeAdoption: 'active',
    });

    const route = resolveTaskRoute('site_builder.copy');
    expect(route).toMatchObject({
      primary: 'claude-sonnet-5',
      fallbacks: [],
      reasoningEffort: 'medium',
      policy: {
        routeState: 'promotedRoute',
        source: 'registry',
        promotionEvidenceId:
          'site-builder-copy-sonnet-native-quality-promotion/2026-08-12-v1',
        route: { primary: 'claude-sonnet-5', fallbacks: [] },
      },
    });
    expect(VERIFIED_GATEWAY_MODEL_TRANSPORTS[route.primary]).toBe(
      approval?.transport,
    );
  });

  it('keeps the former Copy route as an explicit low-effort rollback only', () => {
    const rollback = resolveTaskRoute('site_builder.copy', {
      SITE_BUILDER_MODEL_ROLLBACK_COPY: 'true',
    } as NodeJS.ProcessEnv);
    expect(rollback).toMatchObject({
      primary: 'deepseek-v4-pro',
      fallbacks: ['glm-5.2'],
      reasoningEffort: 'low',
      policy: {
        routeState: 'currentRoute',
        source: 'rollback_override',
      },
    });
    expect(rollback.policy).not.toHaveProperty('promotionEvidenceId');
  });

  it('fails closed if the approval-required Copy promotion loses its approval binding', () => {
    const approval = vi
      .spyOn(modelPolicyRegistry, 'getApprovedTaskPromotion')
      .mockReturnValue(null);
    try {
      expect(() => resolveTaskRoute('site_builder.copy')).toThrow(
        'PROMOTION_ROUTE_ADOPTION_MISSING: site_builder.copy',
      );
    } finally {
      approval.mockRestore();
    }
  });
});
