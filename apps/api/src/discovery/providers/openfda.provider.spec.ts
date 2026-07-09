import { describe, expect, it } from 'vitest';
import { OpenFdaDiscoveryProvider, mapEstablishmentToRecord } from './openfda.provider';
import { OpenFdaEstablishment } from '../../adapters/openfda-api';
import { companyIdentity } from '../identity';

const NOW = '2026-07-09T00:00:00Z';

describe('OpenFdaDiscoveryProvider.discoverCompanies —— fail-safe + §8.8 门（不触网）', () => {
  it('无 product code → 空（绝不裸拉全库，不触网）', async () => {
    const p = new OpenFdaDiscoveryProvider();
    const res = await p.discoverCompanies({ sourceClass: 'public_intelligence', filters: {}, keywords: [], limit: 50 });
    expect(res.records).toEqual([]);
    expect(res.costCents).toBe(0);
  });

  it('§8.8 source_policy SUSPENDED → fail-closed（返回空，不发请求）', async () => {
    const p = new OpenFdaDiscoveryProvider({ sourcePolicyReader: async () => ({ suspended: true }) });
    const res = await p.discoverCompanies({ sourceClass: 'public_intelligence', filters: { product_code: 'LLZ' }, keywords: [], limit: 50 });
    expect(res.records).toEqual([]);
  });

  it('§8.8 策略缺失（null）→ fail-closed', async () => {
    const p = new OpenFdaDiscoveryProvider({ sourcePolicyReader: async () => null });
    const res = await p.discoverCompanies({ sourceClass: 'public_intelligence', filters: { product_code: 'LLZ' }, keywords: [], limit: 50 });
    expect(res.records).toEqual([]);
  });

  it('§8.8 用途不含 discovery → fail-closed', async () => {
    const p = new OpenFdaDiscoveryProvider({ sourcePolicyReader: async () => ({ suspended: false, allowedPurpose: ['enrichment'] }) });
    const res = await p.discoverCompanies({ sourceClass: 'public_intelligence', filters: { product_code: 'LLZ' }, keywords: [], limit: 50 });
    expect(res.records).toEqual([]);
  });

  it('§8.8 reader 抛错 → fail-closed', async () => {
    const p = new OpenFdaDiscoveryProvider({
      sourcePolicyReader: async () => {
        throw new Error('db down');
      },
    });
    const res = await p.discoverCompanies({ sourceClass: 'public_intelligence', filters: { product_code: 'LLZ' }, keywords: [], limit: 50 });
    expect(res.records).toEqual([]);
  });
});

describe('mapEstablishmentToRecord —— 绿事实 + 合规红线', () => {
  const est: OpenFdaEstablishment = {
    registrationNumber: '3004512345',
    feiNumber: '3004512345',
    name: 'Philips Ultrasound LLC',
    country: 'US',
    city: 'Bothell',
    stateCode: 'WA',
    statusCode: '1',
    establishmentTypes: ['Manufacture Medical Device'],
    initialImporter: true,
    productCodes: ['LLZ', 'IYN'],
    deviceFacts: { deviceName: 'System, Image Processing, Radiological', deviceClass: '2', medicalSpecialtyDescription: 'Radiology', regulationNumber: '892.2050' },
    createdDate: '2009-03-01',
  };

  it('establishment → ProviderCompanyRecord（名/国/行业=专科/attributes.fda）', () => {
    const rec = mapEstablishmentToRecord(est, NOW);
    expect(rec.name).toBe('Philips Ultrasound LLC');
    expect(rec.country).toBe('US');
    expect(rec.industry).toBe('Radiology');
    const fda = rec.attributes!.fda as Record<string, unknown>;
    expect(fda.registration_number).toBe('3004512345');
    expect(fda.initial_importer).toBe(true);
    expect(fda.product_codes).toEqual(['LLZ', 'IYN']);
  });

  it('license=CC0-1.0（非硬编码 licensed；写入 field_evidence.license）', () => {
    const rec = mapEstablishmentToRecord(est, NOW);
    expect(rec.license).toBe('CC0-1.0');
    expect((rec.attributes!.fda as Record<string, unknown>).license).toBe('CC0-1.0');
  });

  it('🔴 文案红线：attributes.fda.disclaimer 标注「注册≠核准」', () => {
    const rec = mapEstablishmentToRecord(est, NOW);
    const disclaimer = String((rec.attributes!.fda as Record<string, unknown>).disclaimer);
    expect(disclaimer).toContain('非 FDA 核准');
  });

  it('FDA 注册号 → identifier scheme=fda-reg（全局唯一，不按国别限定）', () => {
    const rec = mapEstablishmentToRecord(est, NOW);
    expect(rec.identifier).toEqual({ scheme: 'fda-reg', value: '3004512345' });
    // 无域名 → dedupeKey 走 id:fda-reg:<值>（比 name_country 更强）
    const key = companyIdentity({ name: rec.name, country: rec.country, identifier: rec.identifier }).dedupeKey;
    expect(key.startsWith('id:fda-reg:')).toBe(true);
  });

  it('无注册号 → 回退 name+country 身份（不臆造 identifier）', () => {
    const rec = mapEstablishmentToRecord({ ...est, registrationNumber: undefined }, NOW);
    expect(rec.identifier).toBeUndefined();
    expect(rec.externalId).toBe('openfda:Philips Ultrasound LLC');
  });
});
