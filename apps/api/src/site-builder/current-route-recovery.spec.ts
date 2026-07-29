import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SAFE_SNAPSHOT_VERSION,
  SITE_BUILDER_CURRENT_ROUTE_RECOVERY_ROUTE_BASELINE_COMMIT,
  SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SOURCE_BUNDLE_VERSION,
  buildCurrentRouteRecoveryReport,
  currentRouteRecoveryActiveAliases,
  currentRouteRecoveryDispatchSha256,
  currentRouteRecoveryRequiredAliases,
  readCurrentRouteRecoveryRepositoryJson,
  writeCurrentRouteRecoveryReportCreateOnly,
  type CurrentRouteRecoveryOpenOxSourceBundle,
  type CurrentRouteRecoverySafeSnapshot,
} from './current-route-recovery';

const temporaryDirectories: string[] = [];
const SOURCE_BUNDLE_SHA256 = 'a'.repeat(64);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function snapshot(): CurrentRouteRecoverySafeSnapshot {
  const activeAliases = currentRouteRecoveryActiveAliases();
  const requiredAliases = currentRouteRecoveryRequiredAliases();
  return {
    schemaVersion: SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SAFE_SNAPSHOT_VERSION,
    capturedAt: '2026-07-29T12:53:41.818Z',
    routeBaselineCommitSha:
      SITE_BUILDER_CURRENT_ROUTE_RECOVERY_ROUTE_BASELINE_COMMIT,
    routeDispatchSha256: currentRouteRecoveryDispatchSha256(),
    gateway: {
      source: 'local_new_api_read_only_sqlite',
      channels: activeAliases.map((alias, index) => ({
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
      modelAllowlist: requiredAliases,
      visibleModelCount: requiredAliases.length,
    },
    pricing: {
      authority: 'openox_model_marketplace',
      catalogEndpoint: 'https://openox.tech/api/public/pricing-catalog',
      capturedAt: '2026-07-29T12:53:41.818Z',
      httpStatus: 200,
      sourceBundlePath: 'docs/evidence/openox.json',
      sourceBundleSha256: SOURCE_BUNDLE_SHA256,
      sourceBundleCommitSha: 'e'.repeat(40),
      modelRows: requiredAliases.length,
      groupRows: [...new Set(requiredAliases.map(groupName))].length,
      runtimeFetch: 'http_200',
    },
  };
}

function productLine(alias: string): string {
  if (alias.startsWith('gpt-')) return 'gpt';
  if (alias.startsWith('claude-')) return 'claude';
  if (alias.startsWith('deepseek-')) return 'deepseek';
  if (alias.startsWith('doubao-')) return 'doubao';
  if (alias.startsWith('minimax-')) return 'minimax';
  return 'glm';
}

function groupName(alias: string): string {
  if (alias === 'gpt-5.6-terra') return 'gpt-unified';
  if (alias === 'claude-sonnet-5') return 'special';
  return productLine(alias);
}

function sourceBundle(): CurrentRouteRecoveryOpenOxSourceBundle {
  const aliases = currentRouteRecoveryRequiredAliases();
  const groups = [...new Set(aliases.map(groupName))].sort();
  return {
    schemaVersion: SITE_BUILDER_CURRENT_ROUTE_RECOVERY_SOURCE_BUNDLE_VERSION,
    authority: 'openox_model_marketplace',
    catalogEndpoint: 'https://openox.tech/api/public/pricing-catalog',
    capturedAt: '2026-07-29T12:53:41.818Z',
    httpStatus: 200,
    fullModelCount: aliases.length,
    fullGroupCount: groups.length,
    modelIds: aliases,
    groupNames: groups,
    catalog: {
      success: true,
      data: {
        models: aliases.map((alias) => ({
          model_id: alias,
          product_line: productLine(alias),
          input_rate: '1',
          output_rate: '2',
          cache_read_rate: '0',
          cache_write_rate: '0',
          group_rates: alias === 'glm-5.2' ? { billing_multiplier: '1' } : null,
          status: 'enabled',
          updated_at: '2026-07-29T12:49:39.000Z',
        })),
        groups: groups.map((name) => ({
          name,
          product_line:
            name === 'gpt-unified'
              ? 'gpt'
              : name === 'special'
                ? 'claude'
                : name,
          rate_multiplier: '1',
        })),
      },
    },
  };
}

function build(
  input = snapshot(),
  catalog = sourceBundle(),
  digest = SOURCE_BUNDLE_SHA256,
) {
  return buildCurrentRouteRecoveryReport(
    input,
    catalog,
    digest,
    'f'.repeat(64),
  );
}

describe('current-route zero-model recovery preparation', () => {
  it('derives all seven tasks, fifteen dispatches and eight exact aliases from the registry', () => {
    const report = build();

    expect(new Set(report.dispatches.map(({ taskId }) => taskId)).size).toBe(7);
    expect(report.dispatches).toHaveLength(15);
    expect(report.aliases).toHaveLength(8);
    expect(report.status).toBe('BLOCKED_CURRENT_ROUTE_RECOVERY');
    expect(report.credential.requiredModelAllowlist).toEqual([
      'claude-sonnet-5',
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'glm-5.2',
      'gpt-5.6-terra',
    ]);
    expect(report.blockers).toEqual(['RETIRED_ALIAS_STILL_ACTIVE']);
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
    for (const alias of [
      'minimax-m3',
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-lite',
    ]) {
      expect(
        report.aliases.find((entry) => entry.alias === alias),
      ).toMatchObject({
        retirementDecision: 'pending_retirement',
        channelSelection: 'not_applicable',
        openOxPricing: null,
        blockers: ['RETIRED_ALIAS_STILL_ACTIVE'],
      });
      expect(report.credential.requiredModelAllowlist).not.toContain(alias);
    }
  });

  it('does not ask to restore or price retired aliases while retaining other fail-closed blockers', () => {
    const input = snapshot();
    input.gateway.channels = input.gateway.channels.filter(
      ({ alias }) =>
        !['minimax-m3', 'doubao-seed-2.0-pro', 'doubao-seed-2.0-lite'].includes(
          alias,
        ),
    );
    input.gateway.channels.push({
      alias: 'claude-sonnet-5',
      channelId: 99,
      status: 'enabled',
      priority: 0,
      weight: 0,
    });
    const catalog = sourceBundle();
    const missing = ['deepseek-v4-flash'];
    catalog.modelIds = catalog.modelIds.filter(
      (alias) => !missing.includes(alias),
    );
    catalog.fullModelCount = catalog.modelIds.length;
    catalog.catalog.data!.models = (
      catalog.catalog.data!.models as Array<{ model_id: string }>
    ).filter(({ model_id }) => !missing.includes(model_id));
    const selectedGroups = [...new Set(catalog.modelIds.map(groupName))];
    catalog.catalog.data!.groups = (
      catalog.catalog.data!.groups as Array<{ name: string }>
    ).filter(({ name }) => selectedGroups.includes(name));
    input.pricing.modelRows = catalog.fullModelCount;
    input.credential.unlimitedQuota = true;
    input.credential.modelLimitsEnabled = false;
    input.credential.modelAllowlist = [];

    const report = build(input, catalog);

    expect(report.status).toBe('BLOCKED_CURRENT_ROUTE_RECOVERY');
    expect(report.blockers).toEqual([
      'CREDENTIAL_NOT_FINITE_EXACT',
      'ENABLED_CHANNEL_AMBIGUOUS',
      'OPENOX_PRICE_MISSING',
      'RETIRED_ALIAS_STILL_ACTIVE',
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
      blockers: ['ENABLED_CHANNEL_AMBIGUOUS', 'CREDENTIAL_NOT_FINITE_EXACT'],
    });
    expect(report.requiredActions).toEqual([
      'PROMOTE_TASKS_OFF_RETIRED_ALIASES',
      'REQUEST_OPENOX_EXACT_ALIAS_PRICING_OR_OPEN_TASK_EVIDENCE',
      'PIN_ONE_REVIEWED_CHANNEL',
      'CREATE_FINITE_EXACT_ALLOWLIST_TOKEN_AFTER_COVERAGE',
    ]);
    expect(report.blockedTaskIds).toHaveLength(7);
    expect(
      report.requiredActions.includes(
        'RESTORE_EXACT_ALIAS_CHANNEL_OR_OPEN_TASK_EVIDENCE',
      ),
    ).toBe(false);
    for (const alias of [
      'minimax-m3',
      'doubao-seed-2.0-pro',
      'doubao-seed-2.0-lite',
    ]) {
      expect(
        report.aliases.find((entry) => entry.alias === alias)?.blockers,
      ).toEqual(['RETIRED_ALIAS_STILL_ACTIVE']);
    }
  });

  it('ignores process environment route overrides by resolving only the frozen registry', () => {
    const previous = process.env.SITE_BUILDER_MODEL_COPY;
    process.env.SITE_BUILDER_MODEL_COPY = 'unreviewed-alias';
    try {
      const report = build();
      expect(
        report.dispatches.some(({ alias }) => alias === 'unreviewed-alias'),
      ).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.SITE_BUILDER_MODEL_COPY;
      else process.env.SITE_BUILDER_MODEL_COPY = previous;
    }
  });

  it('binds the exact route baseline, dispatch digest and credential visibility', () => {
    const wrongCommit = snapshot() as CurrentRouteRecoverySafeSnapshot & {
      routeBaselineCommitSha: string;
    };
    wrongCommit.routeBaselineCommitSha = 'e'.repeat(40);
    expect(() => build(wrongCommit)).toThrow(
      'route baseline commit or dispatch digest is not frozen',
    );

    const wrongDigest = snapshot();
    wrongDigest.routeDispatchSha256 = 'b'.repeat(64);
    expect(() => build(wrongDigest)).toThrow(
      'route baseline commit or dispatch digest is not frozen',
    );

    const broadVisibility = snapshot();
    broadVisibility.credential.visibleModelCount += 1;
    expect(build(broadVisibility).credential.status).toBe('not_finite_exact');
  });

  it('recomputes effective OpenOx prices from the bound source bundle', () => {
    const catalog = sourceBundle();
    const special = (
      catalog.catalog.data!.groups as Array<{
        name: string;
        rate_multiplier: string;
      }>
    ).find(({ name }) => name === 'special')!;
    special.rate_multiplier = '1.26';

    const report = build(snapshot(), catalog);
    expect(
      report.aliases.find(({ alias }) => alias === 'claude-sonnet-5')
        ?.openOxPricing,
    ).toMatchObject({
      groupMultiplier: '1.26',
      inputRate: '1',
      effectiveInputRate: '1.26',
      outputRate: '2',
      effectiveOutputRate: '2.52',
    });
    expect(() => build(snapshot(), catalog, 'b'.repeat(64))).toThrow(
      'does not reproduce the safe snapshot',
    );
  });

  it('rejects secret-adjacent or undeclared snapshot fields', () => {
    const withSecret = {
      ...snapshot(),
      token: 'must never be admitted',
    };
    expect(() => build(withSecret as never)).toThrow('prohibited field token');

    const extra = { ...snapshot(), responseContent: 'not admitted' };
    expect(() => build(extra as never)).toThrow('undeclared or missing fields');

    const unrelated = snapshot();
    unrelated.gateway.channels.push({
      alias: 'unrelated-model',
      channelId: 100,
      status: 'enabled',
      priority: 0,
      weight: 0,
    });
    expect(() => build(unrelated)).toThrow('outside the frozen current route');
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
    const report = build();

    await writeCurrentRouteRecoveryReportCreateOnly(
      root,
      'report.json',
      report,
    );
    await expect(
      writeCurrentRouteRecoveryReportCreateOnly(root, 'report.json', report),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(
      JSON.parse(await readFile(join(root, 'report.json'), 'utf8')),
    ).toEqual(report);
  });

  it('rejects input and output paths that traverse a directory symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'current-route-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'current-route-outside-'));
    temporaryDirectories.push(root, outside);
    await writeFile(join(outside, 'source.json'), '{}\n', 'utf8');
    await symlink(outside, join(root, 'linked'), 'dir');

    await expect(
      readCurrentRouteRecoveryRepositoryJson(root, 'linked/source.json'),
    ).rejects.toThrow('must not traverse a symbolic link');
    await expect(
      writeCurrentRouteRecoveryReportCreateOnly(
        root,
        'linked/report.json',
        build(),
      ),
    ).rejects.toThrow('must not traverse a symbolic link');
  });
});
