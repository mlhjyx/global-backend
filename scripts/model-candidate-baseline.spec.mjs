import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkBaselineReferences,
  checkModelNarrativeDrift,
  checkRegistryBaselineDerivation,
  loadModelCandidateBaseline,
  renderModelCandidateBaselineDocument,
  validateModelCandidateBaseline,
} from './model-candidate-baseline.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = loadModelCandidateBaseline(root);

test('machine baseline validates and generated document is exact', () => {
  assert.deepEqual(validateModelCandidateBaseline(baseline), []);
  assert.equal(
    readFileSync(
      join(root, baseline.documentationPolicy.canonicalDocument),
      'utf8',
    ),
    renderModelCandidateBaselineDocument(baseline),
  );
});

test('missing baselineId reference fails closed', () => {
  const contents = new Map(
    baseline.documentationPolicy.requiredBaselineIdReferences.map((path) => [
      path,
      `references ${baseline.candidateBaselineId}`,
    ]),
  );
  const missingPath =
    baseline.documentationPolicy.requiredBaselineIdReferences[0];
  contents.set(missingPath, 'reference removed');
  assert.deepEqual(checkBaselineReferences(baseline, contents), [
    {
      code: 'MODEL_BASELINE_ID_MISSING',
      path: missingPath,
      detail: `missing ${baseline.candidateBaselineId}`,
    },
  ]);
});

test('deferred or preview model cannot be documented as promoted', () => {
  const path = baseline.documentationPolicy.activeRouteDocuments[0];
  const issues = checkModelNarrativeDrift(
    baseline,
    new Map([[path, 'gemini-3.5-flash is promotedRoute.']]),
  );
  assert.equal(issues[0]?.code, 'MODEL_CANDIDATE_PROMOTED_DRIFT');
  for (const claim of [
    'gemini-3.5-flash 已晋级为生产主路，仅待监控。',
    'gpt-image-2-4k is promotedRoute, not yet monitored.',
    'gemini-3.5-flash\n已晋级为生产主路。',
  ]) {
    assert.equal(
      checkModelNarrativeDrift(baseline, new Map([[path, claim]]))[0]?.code,
      'MODEL_CANDIDATE_PROMOTED_DRIFT',
    );
  }
  for (const boundedClaim of [
    'gemini-3.5-flash 尚未成为 promotedRoute。',
    'gpt-image-2-4k is not an active route.',
    'gpt-image-2-4k 需经任务评测后才可写入 promotedRoute。',
  ]) {
    assert.deepEqual(
      checkModelNarrativeDrift(baseline, new Map([[path, boundedClaim]])),
      [],
    );
  }
});

test('legacy-only model requires current, rollback, baseline, or legacy context', () => {
  const path = baseline.documentationPolicy.activeRouteDocuments[0];
  const issues = checkModelNarrativeDrift(
    baseline,
    new Map([[path, 'minimax-m3 is the new target model.']]),
  );
  assert.equal(issues[0]?.code, 'MODEL_LEGACY_CONTEXT_DRIFT');
  assert.deepEqual(
    checkModelNarrativeDrift(
      baseline,
      new Map([[path, 'minimax-m3 remains currentRoute legacy-only.']]),
    ),
    [],
  );
  assert.equal(
    checkModelNarrativeDrift(
      baseline,
      new Map([
        [path, 'minimax-m3 is promotedRoute in the current target pool.'],
      ]),
    )[0]?.code,
    'MODEL_LEGACY_PROMOTED_DRIFT',
  );
  assert.equal(
    checkModelNarrativeDrift(
      baseline,
      new Map([[path, 'minimax-m3 currentRoute was promotedRoute today.']]),
    )[0]?.code,
    'MODEL_LEGACY_PROMOTED_DRIFT',
  );
});

test('active promoted aliases remain constrained to their reviewed task scope', () => {
  const path = baseline.documentationPolicy.activeRouteDocuments[0];
  for (const claim of [
    'site_builder.qa_summarize 已晋级 gpt-5.6-terra 为生产主路。',
    'BrandProfile and site_builder.new_task now use gpt-5.6-terra as promotedRoute.',
    'BrandProfile 与 site_builder.nope 已晋级 claude-sonnet-5 为生产主路。',
    'site_builder.copy now uses gpt-5.6-terra as its promotedRoute.',
  ]) {
    assert.equal(
      checkModelNarrativeDrift(baseline, new Map([[path, claim]]))[0]?.code,
      'MODEL_ACTIVE_PROMOTION_TASK_DRIFT',
    );
  }
  assert.deepEqual(
    checkModelNarrativeDrift(
      baseline,
      new Map([
        [
          path,
          'site_builder.brand_profile uses gpt-5.6-terra with claude-sonnet-5 as its promotedRoute.',
        ],
      ]),
    ),
    [],
  );
  assert.deepEqual(
    checkModelNarrativeDrift(
      baseline,
      new Map([
        [
          path,
          'site_builder.copy uses claude-sonnet-5 as its promotedRoute after its independent Git-reviewed quality and promotion gates.',
        ],
      ]),
    ),
    [],
  );
});

test('schema rejects incomplete domains, activations, tasks, and documentation policy', () => {
  const invalidDomain = structuredClone(baseline);
  invalidDomain.models[0].domain = 'audio';
  assert.match(
    validateModelCandidateBaseline(invalidDomain).join('\n'),
    /domain/,
  );

  const invalidActivation = structuredClone(baseline);
  invalidActivation.profileCandidatePools[0].activation = 'automatic';
  assert.match(
    validateModelCandidateBaseline(invalidActivation).join('\n'),
    /activation/,
  );

  const missingPreflight = structuredClone(baseline);
  delete missingPreflight.profileCandidatePools[0].candidates[0].preflight;
  assert.match(
    validateModelCandidateBaseline(missingPreflight).join('\n'),
    /incomplete candidate/,
  );

  const unknownPreflight = structuredClone(baseline);
  unknownPreflight.profileCandidatePools[0].candidates[0].preflight =
    'best_effort';
  assert.match(
    validateModelCandidateBaseline(unknownPreflight).join('\n'),
    /incomplete candidate/,
  );

  const incompleteTasks = structuredClone(baseline);
  incompleteTasks.taskEvaluationPools.pop();
  assert.match(
    validateModelCandidateBaseline(incompleteTasks).join('\n'),
    /exactly match/,
  );

  const incompleteDocs = structuredClone(baseline);
  incompleteDocs.documentationPolicy.requiredBaselineIdReferences = [
    'docs/status/current.md',
  ];
  assert.match(
    validateModelCandidateBaseline(incompleteDocs).join('\n'),
    /approved authority set/,
  );

  const incompleteRouteDocs = structuredClone(baseline);
  incompleteRouteDocs.documentationPolicy.activeRouteDocuments = [
    'docs/status/current.md',
  ];
  assert.match(
    validateModelCandidateBaseline(incompleteRouteDocs).join('\n'),
    /approved route-document set/,
  );
});

test('registry must derive candidates instead of declaring target literals', () => {
  assert.equal(
    checkRegistryBaselineDerivation(baseline, 'const target = () => null;')[0]
      ?.code,
    'MODEL_REGISTRY_NOT_BASELINE_DERIVED',
  );
  assert.deepEqual(
    checkRegistryBaselineDerivation(
      baseline,
      [
        'getModelProfileCandidatePool();',
        'function modelCandidateRoutesFromBaseline() {}',
        ...baseline.profileCandidatePools.map((pool) =>
          [
            `  candidates: modelCandidateRoutesFromBaseline('${pool.profile}'),`,
            '  deterministicFallback: {},',
          ].join('\n'),
        ),
      ].join('\n'),
    ),
    [],
  );
  assert.equal(
    checkRegistryBaselineDerivation(
      baseline,
      [
        'getModelProfileCandidatePool();',
        'function modelCandidateRoutesFromBaseline() {}',
        "  candidates: [{ state: 'targetCandidate' }],",
        '  deterministicFallback: {},',
      ].join('\n'),
    ).some((issue) => issue.code === 'MODEL_REGISTRY_CANDIDATE_LITERAL'),
    true,
  );
});
