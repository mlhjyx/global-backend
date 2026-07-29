import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SAFE_SNAPSHOT_VERSION,
  buildCurrentRouteRecoveryReport,
  currentRouteRecoveryRequiredAliases,
  writeCurrentRouteRecoveryReportCreateOnly,
  type CurrentRouteRecoverySafeSnapshot,
} from './current-route-recovery';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function snapshot(): CurrentRouteRecoverySafeSnapshot {
  const aliases = currentRouteRecoveryRequiredAliases();
  return {
    schemaVersion: SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SAFE_SNAPSHOT_VERSION,
    capturedAt: '2026-07-29T12:53:41.818Z',
    routeBaselineCommitSha: 'e'.repeat(40),
    gateway: {
      source: 'local_new_api_read_only_sqlite',
      channels: aliases.map((alias, index) => ({
        alias,
        channelId: index + 1,
        status: 'enabled',
        priority: 0,
        weight: 0,
      })),
    },
    credential: {
      observedAt: '2026-07-29T12:48:52.947Z',
      httpStatus: 200,
      unlimitedQuota: false,
      modelLimitsEnabled: true,
      modelAllowlist: aliases,
      visibleModelCount: aliases.length,
    },
    pricing: {
      authority: 'openox_model_marketplace',
      catalogEndpoint: 'https://openox.tech/api/public/pricing-catalog',
      capturedAt: '2026-07-29T12:53:41.818Z',
      httpStatus: 200,
      responseSha256: 'a'.repeat(64),
      modelRows: aliases.length,
      groupRows: 4,
      runtimeFetch: 'http_200',
      models: aliases.map((alias) => ({
        alias,
        productLine: 'test',
        selectedGroup: 'test',
        currency: 'USD',
        pricingUnit: 'native_currency_per_million_tokens',
        groupMultiplier: '1',
        inputRate: '1',
        outputRate: '2',
        cacheReadRate: '0',
        cacheWriteRate: '0',
        effectiveInputRate: '1',
        effectiveOutputRate: '2',
        effectiveCacheReadRate: '0',
        effectiveCacheWriteRate: '0',
        status: 'enabled',
        updatedAt: '2026-07-29T12:49:39.000Z',
        modelBillingMultiplier: null,
      })),
    },
  };
}

describe('current-route zero-model recovery preparation', () => {
  it('derives all seven tasks, fifteen dispatches and eight exact aliases from the registry', () => {
    const report = buildCurrentRouteRecoveryReport(snapshot());

    expect(new Set(report.dispatches.map(({ taskId }) => taskId)).size).toBe(7);
    expect(report.dispatches).toHaveLength(15);
    expect(report.aliases).toHaveLength(8);
    expect(report.status).toBe('READY_FOR_RUNTIME_ATTESTATION_DECISION');
    expect(report.modelDispatchAuthorization).toBe('NOT_AUTHORIZED');
    expect(report.modelGenerationCalls).toBe(0);
    expect(report.modelFeesUsd).toBe(0);
    expect(report.source.safeSnapshotSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.boundaries).toEqual({
      changesTaskRoutes: false,
      createsRuntimeAttestation: false,
      installsRuntimeAttestation: false,
      mutatesGateway: false,
      dispatchesModels: false,
    });
    expect(
      report.dispatches.find(
        ({ taskId }) => taskId === 'site_builder.brand_profile',
      ),
    ).toMatchObject({
      alias: 'gpt-5.6-terra',
      protocol: 'openai-responses',
    });
    expect(
      report.dispatches.find(({ alias }) => alias === 'claude-sonnet-5'),
    ).toMatchObject({ protocol: 'anthropic-messages' });
  });

  it('reports the live recovery blockers without treating enabled configuration as price evidence', () => {
    const input = snapshot();
    input.gateway.channels = input.gateway.channels.filter(
      ({ alias }) =>
        ![
          'minimax-m3',
          'doubao-seed-2.0-pro',
          'doubao-seed-2.0-lite',
        ].includes(alias),
    );
    input.gateway.channels.push({
      alias: 'claude-sonnet-5',
      channelId: 99,
      status: 'enabled',
      priority: 0,
      weight: 0,
    });
    input.pricing.models = input.pricing.models.filter(
      ({ alias }) =>
        ![
          'minimax-m3',
          'deepseek-v4-flash',
          'doubao-seed-2.0-pro',
          'doubao-seed-2.0-lite',
        ].includes(alias),
    );
    input.credential.unlimitedQuota = true;
    input.credential.modelLimitsEnabled = false;
    input.credential.modelAllowlist = [];

    const report = buildCurrentRouteRecoveryReport(input);

    expect(report.status).toBe('BLOCKED_CURRENT_ROUTE_RECOVERY');
    expect(report.blockers).toEqual([
      'CREDENTIAL_NOT_FINITE_EXACT',
      'ENABLED_CHANNEL_AMBIGUOUS',
      'ENABLED_CHANNEL_MISSING',
      'OPENOX_PRICE_MISSING',
    ]);
    expect(
      report.aliases.find(({ alias }) => alias === 'deepseek-v4-flash'),
    ).toMatchObject({
      channelSelection: 'unique',
      openOxPricing: null,
      blockers: ['OPENOX_PRICE_MISSING', 'CREDENTIAL_NOT_FINITE_EXACT'],
    });
    expect(
      report.aliases.find(({ alias }) => alias === 'claude-sonnet-5'),
    ).toMatchObject({
      channelSelection: 'ambiguous',
      blockers: [
        'ENABLED_CHANNEL_AMBIGUOUS',
        'CREDENTIAL_NOT_FINITE_EXACT',
      ],
    });
    expect(report.requiredActions).toEqual([
      'REQUEST_OPENOX_EXACT_ALIAS_PRICING_OR_OPEN_TASK_EVIDENCE',
      'RESTORE_EXACT_ALIAS_CHANNEL_OR_OPEN_TASK_EVIDENCE',
      'PIN_ONE_REVIEWED_CHANNEL',
      'CREATE_FINITE_EXACT_ALLOWLIST_TOKEN_AFTER_COVERAGE',
    ]);
    expect(report.blockedTaskIds).toHaveLength(7);
  });

  it('ignores process environment route overrides by resolving only the frozen registry', () => {
    const previous = process.env.SITE_BUILDER_MODEL_COPY;
    process.env.SITE_BUILDER_MODEL_COPY = 'unreviewed-alias';
    try {
      const report = buildCurrentRouteRecoveryReport(snapshot());
      expect(report.dispatches.some(({ alias }) => alias === 'unreviewed-alias')).toBe(
        false,
      );
    } finally {
      if (previous === undefined) delete process.env.SITE_BUILDER_MODEL_COPY;
      else process.env.SITE_BUILDER_MODEL_COPY = previous;
    }
  });

  it('rejects secret-adjacent or undeclared snapshot fields', () => {
    const withSecret = {
      ...snapshot(),
      token: 'must never be admitted',
    };
    expect(() => buildCurrentRouteRecoveryReport(withSecret)).toThrow(
      'prohibited field token',
    );

    const extra = { ...snapshot(), responseContent: 'not admitted' };
    expect(() => buildCurrentRouteRecoveryReport(extra)).toThrow(
      'undeclared or missing fields',
    );

    const unrelated = snapshot();
    unrelated.gateway.channels.push({
      alias: 'unrelated-model',
      channelId: 100,
      status: 'enabled',
      priority: 0,
      weight: 0,
    });
    expect(() => buildCurrentRouteRecoveryReport(unrelated)).toThrow(
      'outside the frozen current route',
    );
  });

  it('keeps the CLI free of environment, network and model-client access', async () => {
    const source = await readFile(
      join(
        process.cwd(),
        'scripts/prepare-site-builder-current-route-recovery.mts',
      ),
      'utf8',
    );
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/model-gateway\/providers/);
    expect(source).not.toMatch(/dotenv/);
  });

  it('writes the report once and refuses overwrite', async () => {
    const root = await mkdtemp(join(tmpdir(), 'current-route-recovery-'));
    temporaryDirectories.push(root);
    const report = buildCurrentRouteRecoveryReport(snapshot());

    await writeCurrentRouteRecoveryReportCreateOnly(root, 'report.json', report);
    await expect(
      writeCurrentRouteRecoveryReportCreateOnly(root, 'report.json', report),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(JSON.parse(await readFile(join(root, 'report.json'), 'utf8'))).toEqual(
      report,
    );
  });
});
