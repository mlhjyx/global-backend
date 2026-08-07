import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACQUISITION_PILOT_ALLOWED_SOURCES,
  ACQUISITION_PILOT_CAPS,
  ACQUISITION_PILOT_FORBIDDEN_SOURCES,
  buildControlledPilotManifest,
  validateControlledPilotFixture,
  validateControlledPilotManifest,
  writeControlledPilotManifestCreateOnly,
} from './controlled-pilot-manifest';

const fixturePath = resolve(
  __dirname,
  '../../../../docs/evidence/acquisition/german-industrial-pump-pilot-fixture-v1.json',
);

async function fixture(): Promise<unknown> {
  return JSON.parse(await readFile(fixturePath, 'utf8')) as unknown;
}

describe('German industrial-pump controlled-pilot fixture', () => {
  it('is synthetic/public-safe and covers the closed identity decision cases', async () => {
    const parsed = validateControlledPilotFixture(await fixture());
    expect(parsed.classification).toBe('SYNTHETIC_PUBLIC_SAFE');
    expect(parsed.workspace.id).toBe('00000000-0000-4000-8000-000000000701');
    expect(parsed.icp.id).toBe('00000000-0000-4000-8000-000000000702');
    expect(parsed.icp.country).toBe('DE');
    expect(parsed.records.map((record) => record.expectedDecision)).toEqual([
      'AUTO_LINK',
      'AUTO_LINK',
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
    const manifest = buildControlledPilotManifest({ fixture: parsedFixture, fixturePath: 'docs/evidence/acquisition/german-industrial-pump-pilot-fixture-v1.json' });
    const validated = validateControlledPilotManifest(manifest);

    expect(validated.mode).toBe('CREATE_ONLY');
    expect(validated.dispatchAuthorization).toBe('NOT_AUTHORIZED');
    expect(validated.dispatchCapable).toBe(false);
    expect(validated.actualNetworkCalls).toBe(0);
    expect(validated.actualModelCalls).toBe(0);
    expect(validated.containsCredentials).toBe(false);
    expect(validated.containsPersonalData).toBe(false);
    expect(validated.scope.workspaceIds).toEqual([parsedFixture.workspace.id]);
    expect(validated.scope.icpIds).toEqual([parsedFixture.icp.id]);
    expect(validated.scope.allowedSources).toEqual(ACQUISITION_PILOT_ALLOWED_SOURCES);
    expect(validated.scope.forbiddenSources).toEqual(ACQUISITION_PILOT_FORBIDDEN_SOURCES);
    expect(validated.caps).toEqual(ACQUISITION_PILOT_CAPS);
  });

  it.each([
    ['an extra workspace', (m: Record<string, any>) => ({ ...m, scope: { ...m.scope, workspaceIds: [...m.scope.workspaceIds, '00000000-0000-4000-8000-000000000799'] } })],
    ['an extra ICP', (m: Record<string, any>) => ({ ...m, scope: { ...m.scope, icpIds: [...m.scope.icpIds, '00000000-0000-4000-8000-000000000798'] } })],
    ['a forbidden source', (m: Record<string, any>) => ({ ...m, scope: { ...m.scope, allowedSources: [...m.scope.allowedSources, 'openfda'] } })],
    ['a raised raw cap', (m: Record<string, any>) => ({ ...m, caps: { ...m.caps, rawRecords: 51 } })],
    ['dispatch authorization', (m: Record<string, any>) => ({ ...m, dispatchAuthorization: 'AUTHORIZED' })],
    ['dispatch capability', (m: Record<string, any>) => ({ ...m, dispatchCapable: true })],
    ['a network call', (m: Record<string, any>) => ({ ...m, actualNetworkCalls: 1 })],
  ])('fails closed on %s', async (_label, mutate) => {
    const parsedFixture = validateControlledPilotFixture(await fixture());
    const manifest = buildControlledPilotManifest({ fixture: parsedFixture, fixturePath: 'docs/evidence/acquisition/german-industrial-pump-pilot-fixture-v1.json' });
    expect(() => validateControlledPilotManifest(mutate(manifest as unknown as Record<string, any>))).toThrow();
  });

  it('writes with create-only semantics and refuses an overwrite', async () => {
    const temp = await mkdtemp(resolve(tmpdir(), 'acquisition-pilot-manifest-'));
    const output = resolve(temp, 'manifest.json');
    try {
      const parsedFixture = validateControlledPilotFixture(await fixture());
      const manifest = buildControlledPilotManifest({ fixture: parsedFixture, fixturePath: 'fixture.json' });
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
