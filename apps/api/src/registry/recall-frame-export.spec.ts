import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  RECALL_FRAME_EXPORT_SCHEMA,
  RecallFrameExportError,
  buildRecallFrameExport,
  type RecallFrameExportRow,
} from './recall-frame-export';
import { auditRecall } from './recall-audit';

const row = (overrides: Partial<RecallFrameExportRow> = {}): RecallFrameExportRow => ({
  scheme: 'fr_siren',
  regNumber: '529990001',
  country: 'FR',
  name: 'POMPES MARTIN SAS',
  nace: '28.13',
  employeeBand: '10-49',
  ...overrides,
});

const EXPORTED_AT = '2026-11-09T08:00:00Z';

describe('buildRecallFrameExport', () => {
  it('is deterministic: input order does not change the manifest hash', () => {
    const forward = buildRecallFrameExport({
      frameKey: 'fr_sirene',
      snapshotId: 'snap-1',
      rows: [row(), row({ regNumber: '529990002' }), row({ regNumber: '529990003' })],
      exportedAt: EXPORTED_AT,
    });
    const backward = buildRecallFrameExport({
      frameKey: 'fr_sirene',
      snapshotId: 'snap-1',
      rows: [row({ regNumber: '529990003' }), row(), row({ regNumber: '529990002' })],
      exportedAt: EXPORTED_AT,
    });
    expect(backward).toEqual(forward);
    expect(forward.entities.map((entity) => entity.regNumber)).toEqual([
      '529990001',
      '529990002',
      '529990003',
    ]);
    expect(forward.manifest.sha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(forward.manifest.rowCount).toBe(3);
    expect(forward.schemaVersion).toBe(RECALL_FRAME_EXPORT_SCHEMA);
  });

  it('changes the hash when any audited field changes, stable across cosmetic whitespace', () => {
    const base = buildRecallFrameExport({
      frameKey: 'f',
      snapshotId: 's',
      rows: [row()],
      exportedAt: EXPORTED_AT,
    });
    const padded = buildRecallFrameExport({
      frameKey: 'f',
      snapshotId: 's',
      rows: [row({ scheme: ' fr_siren ', name: ' POMPES MARTIN SAS ', country: 'fr' })],
      exportedAt: EXPORTED_AT,
    });
    expect(padded.manifest.sha256).toBe(base.manifest.sha256);
    const changed = buildRecallFrameExport({
      frameKey: 'f',
      snapshotId: 's',
      rows: [row({ employeeBand: '50-249' })],
      exportedAt: EXPORTED_AT,
    });
    expect(changed.manifest.sha256).not.toBe(base.manifest.sha256);
  });

  it('fails closed on duplicate business keys and empty required fields', () => {
    expect(() =>
      buildRecallFrameExport({
        frameKey: 'f',
        snapshotId: 's',
        rows: [row(), row()],
        exportedAt: EXPORTED_AT,
      }),
    ).toThrow(RecallFrameExportError);
    try {
      buildRecallFrameExport({
        frameKey: 'f',
        snapshotId: 's',
        rows: [row({ name: ' ' })],
        exportedAt: EXPORTED_AT,
      });
      expect.unreachable();
    } catch (error) {
      expect((error as RecallFrameExportError).code).toBe('RECALL_EXPORT_ROW_INVALID');
    }
  });
});

describe('frozen frame feeds the recall audit', () => {
  it('export entities are a drop-in frame input for auditRecall, with a reproducible seed', () => {
    const exportPayload = buildRecallFrameExport({
      frameKey: 'fr_sirene',
      snapshotId: 'snap-1',
      rows: [
        row(),
        row({ regNumber: '529990002', name: 'VENTILES DUPONT SARL' }),
        row({ regNumber: '529990003', name: 'ANCIENS ETABLISSEMENTS ROUX SA', employeeBand: '250+' }),
      ],
      exportedAt: EXPORTED_AT,
    });
    const pool = [
      { registryScheme: 'fr_siren', registryNumber: '529990001', domain: 'pompes-martin.example', contacts: 1 },
    ];
    const first = auditRecall({ frame: exportPayload.entities, pool, sampleSize: 2, seed: '2026-11' });
    const second = auditRecall({ frame: exportPayload.entities, pool, sampleSize: 2, seed: '2026-11' });
    expect(second.strata).toEqual(first.strata);
    expect(first.totals.N).toBe(3);
    expect(first.strata.map((stratum) => stratum.stratumKey).sort()).toEqual([
      'FR:28:10-49',
      'FR:28:250+',
    ]);
  });

  it('the exported JSON round-trips through the CLI input shape (entities key)', () => {
    const exportPayload = buildRecallFrameExport({
      frameKey: 'f',
      snapshotId: 's',
      rows: [row()],
      exportedAt: EXPORTED_AT,
    });
    const parsed = JSON.parse(JSON.stringify(exportPayload)) as { entities: unknown[] };
    expect(Array.isArray(parsed.entities)).toBe(true);
    // recall-audit.mjs 的 readJsonArray 接受 {entities:[...]} 形状。
    const sample = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../../scripts/frames/fixtures/recall-frame.sample.json', import.meta.url)), 'utf8'),
    ) as { entities: unknown[] };
    expect(Array.isArray(sample.entities)).toBe(true);
  });
});
