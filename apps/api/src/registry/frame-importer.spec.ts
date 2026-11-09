import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FrameImportError, importFrame } from './frame-importer';
import { InMemoryRegistryFrameStore } from './frame-store.test-fixture';

const FRAMES_DIR = fileURLToPath(new URL('../../../../scripts/frames/', import.meta.url));
const gbCsv = (): Buffer =>
  readFileSync(`${FRAMES_DIR}fixtures/gb-companies-house.sample.csv`);
const gbConfig = (): unknown =>
  JSON.parse(readFileSync(`${FRAMES_DIR}frames/gb-companies-house.json`, 'utf8'));
const gleifJson = (): Buffer => readFileSync(`${FRAMES_DIR}fixtures/gleif.sample.json`);
const gleifConfig = (): unknown => JSON.parse(readFileSync(`${FRAMES_DIR}frames/gleif.json`, 'utf8'));

const NOW = new Date('2026-11-09T02:00:00Z');

describe('importFrame — Companies House style CSV fixture', () => {
  it('imports the fixture into entities and one PARSED snapshot', async () => {
    const store = new InMemoryRegistryFrameStore();
    const result = await importFrame({
      store,
      config: gbConfig(),
      file: { name: 'BasicCompanyDataAsOneFile-2026-11-01.csv', bytes: gbCsv() },
      now: NOW,
    });
    expect(result.idempotent).toBe(false);
    expect(result.stats).toMatchObject({ parsedRows: 4, added: 4, updated: 0, invalidRows: 0 });
    expect(store.entities.size).toBe(4);
    expect(store.snapshots).toHaveLength(1);
    expect(store.snapshots[0]!.status).toBe('PARSED');
    expect(store.snapshots[0]!.rowCount).toBe(4n);
    expect(store.changes.size).toBe(4);

    const mustermann = [...store.entities.values()].find((entity) => entity.regNumber === '12345678')!;
    expect(mustermann).toMatchObject({
      scheme: 'gb_crn',
      country: 'GB',
      name: 'Muster Pumpen GmbH',
      status: 'ACTIVE',
      legalForm: 'ltd',
      city: 'Manchester',
    });
    const quoted = [...store.entities.values()].find((entity) => entity.regNumber === '55667788')!;
    expect(quoted.name).toBe('Quote "Test" Trading Ltd');
    expect(quoted.status).toBe('ACTIVE');
  });

  it('is idempotent: re-importing the same bytes writes nothing new', async () => {
    const store = new InMemoryRegistryFrameStore();
    const first = await importFrame({
      store,
      config: gbConfig(),
      file: { name: 'ch.csv', bytes: gbCsv() },
      now: NOW,
    });
    const second = await importFrame({
      store,
      config: gbConfig(),
      file: { name: 'ch.csv', bytes: gbCsv() },
      now: new Date('2026-11-09T03:00:00Z'),
    });
    expect(second.idempotent).toBe(true);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(store.entities.size).toBe(4);
    expect(store.snapshots).toHaveLength(1);
    expect(store.changes.size).toBe(4);
  });

  it('re-runs the same bytes when the parser/mapping version changed (no silent no-op)', async () => {
    const store = new InMemoryRegistryFrameStore();
    const first = await importFrame({
      store,
      config: gbConfig(),
      file: { name: 'ch.csv', bytes: gbCsv() },
      now: NOW,
      parserVersion: 'registry-frames-v0',
    });
    const second = await importFrame({
      store,
      config: gbConfig(),
      file: { name: 'ch.csv', bytes: gbCsv() },
      now: new Date('2026-11-09T03:00:00Z'),
      parserVersion: 'registry-frames-v1',
    });
    expect(second.idempotent).toBe(false);
    expect(second.snapshotId).toBe(first.snapshotId);
    expect(second.stats).toMatchObject({ added: 0, unchanged: 4 });
    expect(store.entities.size).toBe(4);
    expect((store.snapshots[0]!.manifest as { parserVersion?: string }).parserVersion).toBe(
      'registry-frames-v1',
    );
  });

  it('refuses to load into a PAUSED frame (kill switch)', async () => {
    const store = new InMemoryRegistryFrameStore();
    await importFrame({ store, config: gbConfig(), file: { name: 'ch.csv', bytes: gbCsv() }, now: NOW });
    const frame = store.frames[0]!;
    frame.status = 'PAUSED';
    const mutated = Buffer.from(gbCsv().toString('utf8').replace('Leeds', 'Leeds 2'), 'utf8');
    await expect(
      importFrame({
        store,
        config: gbConfig(),
        file: { name: 'ch.csv', bytes: mutated },
        now: new Date('2026-11-09T04:00:00Z'),
      }),
    ).rejects.toMatchObject({ code: 'FRAME_NOT_ACTIVE' });
  });

  it('detects a changed row on a new snapshot and supersedes the old one', async () => {
    const store = new InMemoryRegistryFrameStore();
    await importFrame({ store, config: gbConfig(), file: { name: 'ch.csv', bytes: gbCsv() }, now: NOW });
    const mutated = gbCsv()
      .toString('utf8')
      .replace('Muster Pumpen GmbH', 'Muster Pumpen AG');
    const result = await importFrame({
      store,
      config: gbConfig(),
      file: { name: 'ch.csv', bytes: Buffer.from(mutated, 'utf8') },
      now: new Date('2026-11-09T04:00:00Z'),
    });
    expect(result.stats).toMatchObject({ added: 0, updated: 1, unchanged: 3 });
    expect(store.snapshots.map((snapshot) => snapshot.status).sort()).toEqual([
      'PARSED',
      'SUPERSEDED',
    ]);
    const updatedChange = [...store.changes.values()].find(
      (change) => change.changeType === 'UPDATED',
    )!;
    expect(updatedChange.fieldDiffs).toContainEqual({
      field: 'name',
      before: 'Muster Pumpen GmbH',
      after: 'Muster Pumpen AG',
    });
  });

  it('fails closed on invalid rows unless allowPartial is set', async () => {
    const broken = gbCsv().toString('utf8').replace('12345678', '');
    const strictStore = new InMemoryRegistryFrameStore();
    await expect(
      importFrame({
        store: strictStore,
        config: gbConfig(),
        file: { name: 'ch.csv', bytes: Buffer.from(broken, 'utf8') },
        now: NOW,
      }),
    ).rejects.toThrow(FrameImportError);
    expect(strictStore.snapshots[0]!.status).toBe('FAILED');
    expect(strictStore.entities.size).toBe(0);

    const partialStore = new InMemoryRegistryFrameStore();
    const partial = await importFrame({
      store: partialStore,
      config: gbConfig(),
      file: { name: 'ch.csv', bytes: Buffer.from(broken, 'utf8') },
      now: NOW,
      allowPartial: true,
    });
    expect(partial.stats).toMatchObject({ parsedRows: 4, added: 3, invalidRows: 1 });
    expect(partialStore.snapshots[0]!.status).toBe('PARSED');
    expect(partialStore.entities.size).toBe(3);
  });

  it('rejects a CSV that is missing a mapped column before writing anything', async () => {
    const store = new InMemoryRegistryFrameStore();
    const missingColumn = Buffer.from(
      'CompanyName,RegAddress.PostTown\nAcme Ltd,London\n',
      'utf8',
    );
    await expect(
      importFrame({ store, config: gbConfig(), file: { name: 'ch.csv', bytes: missingColumn }, now: NOW }),
    ).rejects.toMatchObject({ code: 'FRAME_MISSING_COLUMNS' });
    expect(store.entities.size).toBe(0);
  });

  it('rejects a CSV missing an attributes-mapped column', async () => {
    const store = new InMemoryRegistryFrameStore();
    const config = gbConfig() as Record<string, any>;
    config.mapping.fields.attributes = { diffusionCommerciale: 'NoSuchColumn' };
    await expect(
      importFrame({
        store,
        config,
        file: { name: 'ch.csv', bytes: gbCsv() },
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: 'FRAME_MISSING_COLUMNS' });
  });

  it('keeps the previous snapshot as the active one when a new import fails', async () => {
    const store = new InMemoryRegistryFrameStore();
    await importFrame({ store, config: gbConfig(), file: { name: 'ch.csv', bytes: gbCsv() }, now: NOW });
    const broken = gbCsv().toString('utf8').replace('12345678', '');
    await expect(
      importFrame({
        store,
        config: gbConfig(),
        file: { name: 'ch.csv', bytes: Buffer.from(broken, 'utf8') },
        now: new Date('2026-11-10T02:00:00Z'),
      }),
    ).rejects.toThrow(FrameImportError);
    const statuses = store.snapshots.map((snapshot) => snapshot.status);
    expect(statuses).toContain('PARSED');
    expect(statuses).toContain('FAILED');
  });
});

describe('importFrame — GLEIF style JSON fixture', () => {
  it('imports dotted-path JSON records with per-row country and LEI', async () => {
    const store = new InMemoryRegistryFrameStore();
    const result = await importFrame({
      store,
      config: gleifConfig(),
      file: { name: 'gleif-golden-copy.json', bytes: gleifJson() },
      now: NOW,
    });
    expect(result.stats).toMatchObject({ parsedRows: 3, added: 3 });
    const entities = [...store.entities.values()];
    expect(entities).toHaveLength(3);
    const muster = entities.find((entity) => entity.regNumber === '529900T8BM49AURSDO55')!;
    expect(muster).toMatchObject({
      scheme: 'lei',
      country: 'DE',
      lei: '529900T8BM49AURSDO55',
      status: 'ACTIVE',
      city: 'München',
      addressJson: { lines: ['Hauptstraße 5', 'Hinterhaus'] },
    });
    const retired = entities.find((entity) => entity.regNumber === '5493001KJTIIGC8Y1R12')!;
    expect(retired.status).toBe('UNKNOWN');
  });
});

describe('importFrame — link proposals across the two fixtures', () => {
  it('proposes VAT hard-group links and name trigram candidates within one frame', async () => {
    const store = new InMemoryRegistryFrameStore();
    const csv = [
      'CompanyName,CompanyNumber,VAT',
      'Muster Pumpen GmbH,11111111,DE291499156',
      'Muster Pumpen Handel GmbH,22222222,DE291499156',
      'Muster Pumpen Service GmbH,33333333,DE777777777',
      '',
    ].join('\n');
    const config = {
      schemaVersion: 'registry-frame/v1',
      frame: {
        frameKey: 'inline_link_fixture',
        country: 'GB',
        scheme: 'gb_crn',
        label: '内联链接提案样例',
        providerKey: 'fixture',
        sourceUrl: 'https://example.org/frame',
        licence: 'public-register',
        fetchMode: 'bulk_file',
      },
      mapping: {
        schemaVersion: 'registry-frame-mapping/v1',
        format: 'csv',
        constants: { scheme: 'gb_crn', country: 'GB' },
        fields: { regNumber: 'CompanyNumber', name: 'CompanyName', vatId: 'VAT' },
        statusMap: null,
      },
    };
    const result = await importFrame({
      store,
      config,
      file: { name: 'inline.csv', bytes: Buffer.from(csv, 'utf8') },
      now: NOW,
      proposeLinks: true,
    });
    expect(result.stats.added).toBe(3);
    expect(result.linkProposals).toMatchObject({ hardKey: 1, nameTrigram: 2, inserted: 3 });
    const links = [...store.links.values()];
    expect(links.find((link) => link.rule === 'vat_exact')!.status).toBe('PROPOSED');
    expect(links.find((link) => link.rule === 'name_trigram')!.linkType).toBe('UNCERTAIN');
  });
});
