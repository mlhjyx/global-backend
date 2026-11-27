import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { importFrame } from './frame-importer';
import { InMemoryRegistryFrameStore } from './frame-store.test-fixture';
import { parseFrameConfig } from './frame-types';

const FRAMES_DIR = fileURLToPath(new URL('../../../../scripts/frames/frames/', import.meta.url));

interface CatalogEntry {
  frameKey: string;
  config: string;
  fixture: string;
  expectedRows: number;
  expectedSchemes: string[];
}

const catalog = JSON.parse(readFileSync(`${FRAMES_DIR}catalog.json`, 'utf8')) as {
  schemaVersion: string;
  frames: CatalogEntry[];
};

describe('registry frames catalog', () => {
  it('declares the catalog schema and covers every frame config on disk', () => {
    expect(catalog.schemaVersion).toBe('registry-frames-catalog/v1');
    const configs = readdirSync(FRAMES_DIR)
      .filter((name) => name.endsWith('.json') && name !== 'catalog.json')
      .sort();
    expect(catalog.frames.map((entry) => entry.config).sort()).toEqual(configs);
  });

  it.each(catalog.frames.map((entry) => [entry.frameKey, entry] as const))(
    'imports fixture for %s and matches the catalog expectations',
    async (frameKey, entry) => {
      const config = JSON.parse(readFileSync(`${FRAMES_DIR}${entry.config}`, 'utf8'));
      const parsed = parseFrameConfig(config);
      expect(parsed.frame.frameKey).toBe(frameKey);

      const bytes = readFileSync(`${FRAMES_DIR}${entry.fixture}`);
      const store = new InMemoryRegistryFrameStore();
      const result = await importFrame({
        store,
        config,
        file: { name: entry.fixture.split('/').pop()!, bytes },
        now: new Date('2026-11-09T02:00:00Z'),
      });
      expect(result.stats).toMatchObject({
        parsedRows: entry.expectedRows,
        added: entry.expectedRows,
        invalidRows: 0,
      });
      expect(result.warnings).toEqual([]);
      const schemes = [...new Set([...store.entities.values()].map((entity) => entity.scheme))].sort();
      expect(schemes).toEqual([...entry.expectedSchemes].sort());
    },
  );

  it('keeps per-source distinctions that matter downstream (FR bands/status, US region)', async () => {
    const frConfig = JSON.parse(readFileSync(`${FRAMES_DIR}fr-sirene.json`, 'utf8'));
    const frStore = new InMemoryRegistryFrameStore();
    await importFrame({
      store: frStore,
      config: frConfig,
      file: { name: 'fr.csv', bytes: readFileSync(`${FRAMES_DIR}../fixtures/fr-sirene.sample.csv`) },
      now: new Date('2026-11-09T02:00:00Z'),
    });
    const fr = [...frStore.entities.values()];
    expect(fr.find((entity) => entity.regNumber === '529990001')).toMatchObject({
      scheme: 'fr_siren',
      country: 'FR',
      status: 'ACTIVE',
      legalForm: 'sas',
      employeeBand: '10-49',
      // NAF rev2 28.13Z 装载时归一到 NACE 类目形态；码体系记在 naceVersion。
      nace: '28.13',
      naceVersion: 'NAF-rev2',
      city: 'LYON',
      postalCode: '69003',
      attributes: { categorieJuridique: '5710', diffusionCommerciale: 'true' },
    });
    // diffusionCommerciale=false：当事人反对商业推介，必须原样带到下游触达过滤。
    expect(fr.find((entity) => entity.regNumber === '529990002')!.attributes).toEqual({
      categorieJuridique: '5499',
      diffusionCommerciale: 'false',
    });
    expect(fr.find((entity) => entity.regNumber === '529990003')!.status).toBe('DISSOLVED');

    const usConfig = JSON.parse(readFileSync(`${FRAMES_DIR}us-sam.json`, 'utf8'));
    const usStore = new InMemoryRegistryFrameStore();
    await importFrame({
      store: usStore,
      config: usConfig,
      file: { name: 'us.json', bytes: readFileSync(`${FRAMES_DIR}../fixtures/us-sam.sample.json`) },
      now: new Date('2026-11-09T02:00:00Z'),
    });
    const us = [...usStore.entities.values()];
    expect(us.find((entity) => entity.regNumber === 'UEI000000000002')).toMatchObject({
      scheme: 'us_uei',
      country: 'US',
      region: 'CO',
      legalForm: 'inc',
      status: 'ACTIVE',
    });
    expect(us.find((entity) => entity.regNumber === 'UEI000000000003')!.status).toBe('UNKNOWN');

    const auConfig = JSON.parse(readFileSync(`${FRAMES_DIR}au-abr-abn.json`, 'utf8'));
    const auStore = new InMemoryRegistryFrameStore();
    await importFrame({
      store: auStore,
      config: auConfig,
      file: { name: 'au.csv', bytes: readFileSync(`${FRAMES_DIR}../fixtures/au-abr-abn.sample.csv`) },
      now: new Date('2026-11-27T02:00:00Z'),
    });
    const au = [...auStore.entities.values()];
    expect(au.find((entity) => entity.regNumber === '51824753556')).toMatchObject({
      scheme: 'au_abn',
      country: 'AU',
      status: 'ACTIVE',
      legalForm: 'pty_ltd',
      region: 'NSW',
      postalCode: '2000',
      nace: '46.69',
      naceVersion: 'AU-ABN-KW',
      identifiers: [{ scheme: 'au_acn', value: '012345678' }],
    });

    const brConfig = JSON.parse(readFileSync(`${FRAMES_DIR}br-rfb-cnpj.json`, 'utf8'));
    const brStore = new InMemoryRegistryFrameStore();
    await importFrame({
      store: brStore,
      config: brConfig,
      file: { name: 'br.csv', bytes: readFileSync(`${FRAMES_DIR}../fixtures/br-rfb-cnpj.sample.csv`) },
      now: new Date('2026-11-27T02:00:00Z'),
    });
    const br = [...brStore.entities.values()];
    expect(br.find((entity) => entity.regNumber === '22333444000181')).toMatchObject({
      scheme: 'br_cnpj',
      country: 'BR',
      status: 'ACTIVE',
      legalForm: 'sa',
      city: 'BELO HORIZONTE',
      region: 'MG',
      postalCode: '30140071',
      nace: '46.69',
      naceVersion: 'BR-CNAE-2.0',
      attributes: expect.objectContaining({ cnae: '4673700', tradeName: 'MINAS ELETRICA' }),
    });
  });
});
