import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACQUISITION_PILOT_ALLOWED_SOURCES,
  ACQUISITION_PILOT_CAPS,
  ACQUISITION_PILOT_FORBIDDEN_SOURCES,
  buildControlledPilotManifest,
  readControlledPilotFixture,
  validateControlledPilotFixture,
  validateControlledPilotManifest,
  writeControlledPilotManifestCreateOnly,
  type ControlledPilotManifest,
} from './controlled-pilot-manifest';

const fixturePath = resolve(
  __dirname,
  '../../../../docs/evidence/acquisition/german-industrial-pump-pilot-fixture-v1.json',
);

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
}

describe('German industrial-pump controlled-pilot fixture', () => {
  it('loads the checked-in fixture through the closed validator', async () => {
    expect((await readControlledPilotFixture(fixturePath)).contractVersion).toBe(
      'acquisition-identity-pilot-fixture/2026-08-07-v1',
    );
  });

  it('is synthetic/public-safe and covers the closed identity decision cases', async () => {
    const parsed = validateControlledPilotFixture(await fixture());
    expect(parsed.classification).toBe('SYNTHETIC_PUBLIC_SAFE');
    expect(parsed.workspace.id).toBe('00000000-0000-4000-8000-000000000701');
    expect(parsed.companyOffering).toEqual({
      id: '00000000-0000-4000-8000-000000000703',
      companyName: 'Synthetic Export Pump Works',
      offeringName: 'Industrial process-pump export package',
      classification: 'SYNTHETIC',
    });
    expect(parsed.icp.id).toBe('00000000-0000-4000-8000-000000000702');
    expect(parsed.icp.version).toBe(1);
    expect(parsed.icp.country).toBe('DE');
    expect(parsed.icp.region).toBe('EU');
    expect(parsed.records.map((record) => record.expectedDecision)).toEqual([
      'AUTO_LINK',
      'REVIEW_LINK',
      'REVIEW_LINK',
      'REVIEW_LINK',
    ]);
    expect(new Set(parsed.records.map((record) => record.source))).toEqual(new Set(['ted', 'public_web']));
    expect(parsed.enrichmentSource).toBe('gleif');
  });

  it('rejects personal data, credential-shaped fields, and undeclared fixture sources', async () => {
    const base = (await fixture()) as Record<string, unknown>;
    expect(() =>
      validateControlledPilotFixture({ ...base, operatorEmail: 'pilot-owner@example.com' }),
    ).toThrow(/unknown field|personal data/i);
    expect(() =>
      validateControlledPilotFixture({ ...base, apiKey: 'REDACTED' }),
    ).toThrow(/unknown field|credential/i);
    expect(() =>
      validateControlledPilotFixture({
        ...base,
        icp: {
          ...(base.icp as Record<string, unknown>),
          productTerms: ['industrial pump', 'Bearer synthetic-secret-token-value'],
        },
      }),
    ).toThrow(/credential|secret|token/i);
    expect(() =>
      validateControlledPilotFixture({
        ...base,
        records: [
          ...((base.records as unknown[]) ?? []),
          {
            fixtureId: 'forbidden-source',
            source: 'openfda',
            incoming: { name: 'Synthetic GmbH', country: 'DE' },
            candidates: [],
            expectedDecision: 'REVIEW_LINK',
          },
        ],
      }),
    ).toThrow(/source/i);
  });
});

describe('controlled acquisition pilot manifest', () => {
  it('freezes one workspace, one ICP, exact allowed/forbidden sources, exact caps, and zero-call authorization', async () => {
    const parsedFixture = validateControlledPilotFixture(await fixture());
    const manifest = buildControlledPilotManifest({
      fixture: parsedFixture,
      fixturePath: 'docs/evidence/acquisition/german-industrial-pump-pilot-fixture-v1.json',
      sourceCommit: '4562eab1bae16cdd424ff90a7d3403b0fb30d535',
      expiresAt: '2026-08-14T00:00:00.000Z',
    });
    const validated = validateControlledPilotManifest(manifest);

    expect(validated.contractVersion).toBe('acquisition-identity-pilot-prep-manifest/2026-08-07-v1');
    expect(validated.artifactKind).toBe('IDENTITY_PILOT_PREP_CREATE_ONLY_MANIFEST');
    expect(validated.mode).toBe('CREATE_ONLY');
    expect(validated.dispatchAuthorization).toBe('NOT_AUTHORIZED');
    expect(validated.dispatchCapable).toBe(false);
    expect(validated.actualNetworkCalls).toBe(0);
    expect(validated.actualModelCalls).toBe(0);
    expect(validated.containsCredentials).toBe(false);
    expect(validated.containsPersonalData).toBe(false);
    expect(validated.sourceCommit).toBe('4562eab1bae16cdd424ff90a7d3403b0fb30d535');
    expect(validated.expiresAt).toBe('2026-08-14T00:00:00.000Z');
    expect(validated.scope.workspaceIds).toEqual([parsedFixture.workspace.id]);
    expect(validated.scope.companyOfferingIds).toEqual([parsedFixture.companyOffering.id]);
    expect(validated.scope.icpIds).toEqual([parsedFixture.icp.id]);
    expect(validated.scope.icpVersions).toEqual([parsedFixture.icp.version]);
    expect(validated.scope.countries).toEqual(['DE']);
    expect(validated.scope.regions).toEqual(['EU']);
    expect(validated.scope.allowedSources).toEqual(ACQUISITION_PILOT_ALLOWED_SOURCES);
    expect(validated.scope.forbiddenSources).toEqual(ACQUISITION_PILOT_FORBIDDEN_SOURCES);
    expect(validated.caps).toEqual(ACQUISITION_PILOT_CAPS);
    expect(validated.caps).toMatchObject({
      rawRecords: 50,
      canonicalCompanies: 30,
      enrichedCompanies: 10,
      humanReviewedCompanies: 5,
      leadQualifiedPackages: 3,
      externalRequests: 0,
      modelCalls: 0,
      repairs: 0,
      inputTokens: 0,
      outputTokens: 0,
      maxCostCents: 0,
    });
    expect(validated.nextStage).toMatchObject({
      requiresCurrentTaskGraphManifest: true,
      requiresSeparateCostAuthorization: true,
      dispatchAuthorization: 'NOT_AUTHORIZED',
    });
  });

  const unsafeMutations: readonly [string, (manifest: ControlledPilotManifest) => unknown][] = [
    [
      'an extra workspace',
      (manifest) => ({
        ...manifest,
        scope: {
          ...manifest.scope,
          workspaceIds: [...manifest.scope.workspaceIds, '00000000-0000-4000-8000-000000000799'],
        },
      }),
    ],
    [
      'an extra ICP',
      (manifest) => ({
        ...manifest,
        scope: {
          ...manifest.scope,
          icpIds: [...manifest.scope.icpIds, '00000000-0000-4000-8000-000000000798'],
        },
      }),
    ],
    [
      'a forbidden source',
      (manifest) => ({
        ...manifest,
        scope: { ...manifest.scope, allowedSources: [...manifest.scope.allowedSources, 'openfda'] },
      }),
    ],
    ['a raised raw cap', (manifest) => ({ ...manifest, caps: { ...manifest.caps, rawRecords: 51 } })],
    ['dispatch authorization', (manifest) => ({ ...manifest, dispatchAuthorization: 'AUTHORIZED' })],
    ['dispatch capability', (manifest) => ({ ...manifest, dispatchCapable: true })],
    ['a network call', (manifest) => ({ ...manifest, actualNetworkCalls: 1 })],
  ];

  it.each(unsafeMutations)('fails closed on %s', async (_label, mutate) => {
    const parsedFixture = validateControlledPilotFixture(await fixture());
    const manifest = buildControlledPilotManifest({
      fixture: parsedFixture,
      fixturePath: 'docs/evidence/acquisition/german-industrial-pump-pilot-fixture-v1.json',
      sourceCommit: '4562eab1bae16cdd424ff90a7d3403b0fb30d535',
      expiresAt: '2026-08-14T00:00:00.000Z',
    });
    expect(() => validateControlledPilotManifest(mutate(manifest))).toThrow();
  });

  it('writes with create-only semantics and refuses an overwrite', async () => {
    const temp = await mkdtemp(resolve(tmpdir(), 'acquisition-pilot-manifest-'));
    const output = resolve(temp, 'manifest.json');
    try {
      const parsedFixture = validateControlledPilotFixture(await fixture());
      const manifest = buildControlledPilotManifest({
        fixture: parsedFixture,
        fixturePath: 'fixture.json',
        sourceCommit: '4562eab1bae16cdd424ff90a7d3403b0fb30d535',
        expiresAt: '2026-08-14T00:00:00.000Z',
      });
      await writeControlledPilotManifestCreateOnly(output, manifest);
      expect(validateControlledPilotManifest(JSON.parse(await readFile(output, 'utf8')))).toEqual(manifest);
      await expect(writeControlledPilotManifestCreateOnly(output, manifest)).rejects.toMatchObject({ code: 'EEXIST' });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('keeps the operational generator offline and free of environment or credential access', async () => {
    const scriptPath = resolve(dirname(__dirname), '../scripts/prepare-acquisition-identity-pilot-manifest.mts');
    const source = await readFile(scriptPath, 'utf8');
    expect(source).not.toMatch(/\bfetch\s*\(|axios|http\.request|https\.request|\.env|process\.env|credential|bearer/i);
  });
});
