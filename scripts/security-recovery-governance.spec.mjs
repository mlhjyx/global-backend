import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  evaluateCoverage,
  validateComposeLock,
  validateIntegrationMatrix,
  validateRecoveryRehearsal,
  validateWorkflowPolicy,
} from './security-recovery-governance.mjs';

const coveragePolicy = {
  schemaVersion: 'api-coverage-policy/v1',
  targetPercent: 80,
  baseline: {
    statements: { covered: 17218, total: 24249 },
    branches: { covered: 13492, total: 20142 },
    functions: { covered: 3520, total: 4730 },
    lines: { covered: 16072, total: 21955 },
  },
  critical: {
    auth: {
      targetPercent: 80,
      baseline: { covered: 1, total: 40 },
      paths: ['src/auth/'],
    },
    events: {
      targetPercent: 80,
      baseline: { covered: 22, total: 23 },
      paths: ['src/events/'],
    },
  },
};

function summary(overrides = {}) {
  return {
    total: {
      statements: { covered: 17218, total: 24249 },
      branches: { covered: 13492, total: 20142 },
      functions: { covered: 3520, total: 4730 },
      lines: { covered: 16072, total: 21955 },
    },
    '/repo/apps/api/src/auth/auth.guard.ts': {
      branches: { covered: 1, total: 40 },
    },
    '/repo/apps/api/src/events/events.service.ts': {
      branches: { covered: 22, total: 23 },
    },
    ...overrides,
  };
}

describe('coverage ratchet', () => {
  it('keeps the 80 percent target explicit while reporting current debt', () => {
    const result = evaluateCoverage(coveragePolicy, summary());
    assert.equal(result.ok, true);
    assert.equal(result.targetPercent, 80);
    assert.equal(result.targetMet, false);
    assert.deepEqual(
      result.debt.map((entry) => entry.scope),
      ['global', 'critical:auth'],
    );
  });

  it('fails when one global branch is lost even if rounded percentages look equal', () => {
    const result = evaluateCoverage(
      coveragePolicy,
      summary({
        total: {
          ...summary().total,
          branches: { covered: 13491, total: 20142 },
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /global branches declined/);
  });

  it('fails when a below-target critical cohort declines', () => {
    const result = evaluateCoverage(
      coveragePolicy,
      summary({
        '/repo/apps/api/src/auth/auth.guard.ts': {
          branches: { covered: 0, total: 40 },
        },
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /critical:auth branches declined/);
  });
});

describe('workflow security policy', () => {
  const pinnedCheckout =
    'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1b';

  it('requires every external Action to use a full commit SHA', () => {
    const result = validateWorkflowPolicy({
      '.github/workflows/security.yml': `
permissions:
  contents: read
  pull-requests: read
jobs:
  dependency-audit:
    name: dependency audit
    steps:
      - uses: ${pinnedCheckout}
      - run: pnpm audit --prod --audit-level=high
  source-sast:
    name: repository SAST
    steps:
      - uses: ${pinnedCheckout}
      - run: pnpm security:sast
  compose-iac:
    name: container and Compose IaC
    steps:
      - uses: ${pinnedCheckout}
      - run: pnpm security:compose
`,
    });
    assert.equal(result.ok, true);
  });

  it('rejects a tag pin, write permission, or missing security lane', () => {
    const result = validateWorkflowPolicy({
      '.github/workflows/security.yml': `
permissions:
  contents: write
jobs:
  source-sast:
    steps:
      - uses: actions/checkout@v7
`,
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /full commit SHA/);
    assert.match(result.errors.join('\n'), /write permission/);
    assert.match(result.errors.join('\n'), /dependency audit/);
    assert.match(result.errors.join('\n'), /container and Compose IaC/);
  });
});

describe('Compose image lock', () => {
  const manifest = {
    schemaVersion: 'container-image-lock/v1',
    services: {
      postgres: {
        kind: 'remote',
        image:
          'pgvector/pgvector@sha256:1d533553fefe4f12e5d80c7b80622ba0c382abb5758856f52983d8789179f0fb',
        status: 'VERIFIED_GLOBAL_DEV',
      },
      crawler: {
        kind: 'local-build',
        image: 'global-crawler:src-aaaaaaaaaaaa',
        sourceDigest: 'a'.repeat(64),
        buildReceiptStatus: 'NOT_RUN',
        status: 'SOURCE_LOCKED',
      },
    },
    profiles: {
      default: { services: ['postgres', 'crawler'], status: 'SOURCE_LOCKED' },
      observability: { services: [], status: 'UNVERIFIED' },
    },
  };

  it('accepts digest-pinned remotes and source-bound local tags', () => {
    const compose = `
services:
  postgres:
    image: ${manifest.services.postgres.image}
  crawler:
    build:
      context: ./infra/crawler
    image: global-crawler:src-aaaaaaaaaaaa
`;
    const result = validateComposeLock({
      composeText: compose,
      manifest,
      profile: 'default',
      localSourceDigests: { crawler: 'a'.repeat(64) },
    });
    assert.equal(result.ok, true);
  });

  it('rejects moving tags, local source drift, and an unverified profile', () => {
    const moving = validateComposeLock({
      composeText: 'services:\n  postgres:\n    image: postgres:latest\n',
      manifest,
      profile: 'default',
      localSourceDigests: { crawler: 'b'.repeat(64) },
    });
    assert.equal(moving.ok, false);
    assert.match(moving.errors.join('\n'), /moving or unlocked image/);
    assert.match(moving.errors.join('\n'), /source digest drift/);

    const optional = validateComposeLock({
      composeText: '',
      manifest,
      profile: 'observability',
      localSourceDigests: {},
    });
    assert.equal(optional.ok, false);
    assert.match(optional.errors.join('\n'), /profile observability is UNVERIFIED/);
  });
});

describe('recovery rehearsal admission', () => {
  const notRun = {
    schemaVersion: 'recovery-rehearsal/v1',
    status: 'NOT_RUN',
    authorization: null,
    startedAt: null,
    completedAt: null,
    receipts: [],
  };

  it('accepts the safe create-only NOT_RUN state', () => {
    assert.equal(validateRecoveryRehearsal(notRun).ok, true);
  });

  it('rejects a success claim without authorization and complete receipts', () => {
    const result = validateRecoveryRehearsal({
      ...notRun,
      status: 'PASSED',
      completedAt: '2026-08-08T00:00:00.000Z',
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /authorization/);
    assert.match(result.errors.join('\n'), /receipts/);
  });
});

describe('integration context matrix', () => {
  const matrix = {
    schemaVersion: 'integration-context-matrix/v1',
    contexts: {
      postgresql: {
        requiredContext: 'PostgreSQL integration',
        status: 'BLOCKED',
        isolation: 'DISPOSABLE_DATABASE_AND_ROLE',
        command: null,
      },
      temporal: {
        requiredContext: 'Temporal integration',
        status: 'BLOCKED',
        isolation: 'OFFICIAL_TEST_ENV_OR_PURE_HISTORY_REPLAY',
        command: null,
      },
    },
  };

  it('records blocked contexts without treating them as satisfied', () => {
    const result = validateIntegrationMatrix(matrix);
    assert.equal(result.ok, true);
    assert.equal(result.requiredContextsSatisfied, false);
    assert.deepEqual(result.blocked, ['postgresql', 'temporal']);
  });

  it('rejects an enabled database context that is not disposable', () => {
    const result = validateIntegrationMatrix({
      ...matrix,
      contexts: {
        ...matrix.contexts,
        postgresql: {
          ...matrix.contexts.postgresql,
          status: 'ENABLED',
          isolation: 'SHARED_DATABASE',
          command: 'pnpm verify:database',
        },
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /disposable database and role/);
  });
});
