import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('suppression writer/action linearization topology', () => {
  it('DSR freeze and erase acquire the workspace policy lock before any suppression or row mutation', () => {
    const source = read('apps/api/src/temporal/deletion.activities.ts');
    const freeze = source.slice(source.indexOf('async freezeSubject'), source.indexOf('async eraseSubject'));
    const erase = source.slice(source.indexOf('async eraseSubject'), source.indexOf('async completeDeletion'));
    expect(freeze.indexOf('lockWorkspaceSuppressionPolicy')).toBeGreaterThanOrEqual(0);
    expect(freeze.indexOf('lockWorkspaceSuppressionPolicy')).toBeLessThan(freeze.indexOf('upsertSuppressionEntries'));
    expect(erase.indexOf('lockWorkspaceSuppressionPolicy')).toBeGreaterThanOrEqual(0);
    expect(erase.indexOf('lockWorkspaceSuppressionPolicy')).toBeLessThan(erase.indexOf('deletionRequest.updateMany'));
  });

  it('all forward-run external-processing stages call the shared company authorization gate', () => {
    const source = read('apps/api/src/temporal/discovery.activities.ts');
    for (const [start, end] of [
      ['async qualifyFitForRun', 'async enrichRun'],
      ['async enrichRun', 'async enrichSignalsRun'],
      ['async enrichSignalsRun', 'async registerWatchesForRun'],
      ['async registerWatchesForRun', 'async enqueuePatentLookupsForRun'],
    ] as const) {
      const body = source.slice(source.indexOf(start), source.indexOf(end));
      expect(body, `${start} must authorize immediately before external processing`).toContain(
        'companyMayUseExternalProcessing',
      );
    }
  });

  it('all signal-to-company projection writers authorize materialization before canonical reads and writes', () => {
    for (const path of [
      'apps/api/src/intent/ted-intent-projection.service.ts',
      'apps/api/src/intent/openfda-intent-projection.service.ts',
      'apps/api/src/intent/sam-intent-projection.service.ts',
    ]) {
      const source = read(path);
      const projectOne = source.slice(source.indexOf('private async projectOne'));
      const gateAt = projectOne.indexOf('companyMayBeMaterialized');
      expect(gateAt, `${path} must use the shared materialization gate`).toBeGreaterThanOrEqual(0);
      expect(gateAt, `${path} must authorize before reading canonical state`).toBeLessThan(
        projectOne.indexOf('canonicalCompany.findUnique'),
      );
      expect(gateAt, `${path} must authorize before writing canonical state`).toBeLessThan(
        projectOne.indexOf('canonicalCompany.upsert'),
      );
    }
  });

  it('manual and backlog contact/email paths authorize each adapter or contact before network processing', () => {
    const service = read('apps/api/src/discovery/discovery.service.ts');
    const backlog = read('apps/api/src/temporal/backlog.activities.ts');
    expect(service).toContain('contactMayUseExternalProcessing');
    expect(service.match(/companyMayUseExternalProcessing/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(backlog).toContain('contactMayUseExternalProcessing');
    expect(backlog.match(/mayUseExternalProcessing/g)?.length ?? 0).toBeGreaterThanOrEqual(10);
  });
});
