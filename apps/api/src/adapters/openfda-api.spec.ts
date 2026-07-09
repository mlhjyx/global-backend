import { describe, expect, it } from 'vitest';
import { buildRegistrationSearch, mapRegistration } from './openfda-api';

describe('openFDA search 构造（buildRegistrationSearch）', () => {
  it('单 product code：products.product_code:CODE', () => {
    expect(buildRegistrationSearch({ productCodes: ['LLZ'] })).toBe('products.product_code:LLZ');
  });

  it('多 product code：OR + 括号', () => {
    expect(buildRegistrationSearch({ productCodes: ['LLZ', 'IYN'] })).toBe('(products.product_code:LLZ OR products.product_code:IYN)');
  });

  it('§8.1 美国进口商 = initial_importer_flag:Y（非 establishment_type:Importer）', () => {
    const q = buildRegistrationSearch({ productCodes: ['LLZ'], importerOnly: true });
    expect(q).toContain('registration.initial_importer_flag:Y');
    expect(q).not.toContain('establishment_type:Importer');
  });

  it('国别过滤大写为 ISO-2', () => {
    expect(buildRegistrationSearch({ productCodes: ['LLZ'], isoCountry: 'cn' })).toContain('registration.iso_country_code:CN');
  });

  it('establishment_type 含空格值加引号', () => {
    const q = buildRegistrationSearch({ productCodes: ['LLZ'], establishmentTypes: ['Foreign Exporter'] });
    expect(q).toContain('establishment_type:"Foreign Exporter"');
  });

  it('空 product code 抛错（openFDA 发现必须带产品码，绝不裸拉全库）', () => {
    expect(() => buildRegistrationSearch({ productCodes: [] })).toThrow();
  });
});

describe('openFDA registrationlisting 映射（mapRegistration）—— 绿事实法人字段，剥离 🔴 具名个人', () => {
  const sample = {
    proprietary_name: ['SomeScanner'],
    establishment_type: ['Manufacture Medical Device', 'Complaint File Establishment per 21 CFR 820.198'],
    k_number: ['K123456'],
    registration: {
      registration_number: '3004512345',
      fei_number: '3004512345',
      status_code: '1',
      initial_importer_flag: 'Y',
      name: 'Philips Ultrasound LLC',
      iso_country_code: 'us',
      city: 'Bothell',
      state_code: 'WA',
      us_agent: { name: 'Jane Doe', email: 'jane.doe@example.com', bus_name: 'Philips' }, // 🔴 具名个人
      owner_operator: { firstname: 'John', lastname: 'Smith' }, // 🔴 具名个人
    },
    products: [
      { product_code: 'LLZ', created_date: '2011-05-01', owner_operator_number: '9012345', openfda: { device_name: 'System, Image Processing, Radiological', device_class: '2', medical_specialty_description: 'Radiology', regulation_number: '892.2050' } },
      { product_code: 'IYN', created_date: '2009-03-01' },
    ],
  };

  it('提取法人事实（名/国 alpha-2/注册号/FEI/进口商标志/产品码集）', () => {
    const e = mapRegistration(sample)!;
    expect(e.name).toBe('Philips Ultrasound LLC');
    expect(e.country).toBe('US');
    expect(e.registrationNumber).toBe('3004512345');
    expect(e.feiNumber).toBe('3004512345');
    expect(e.initialImporter).toBe(true);
    expect(e.productCodes).toEqual(['LLZ', 'IYN']);
    expect(e.establishmentTypes).toContain('Manufacture Medical Device');
    expect(e.createdDate).toBe('2009-03-01'); // 最早
  });

  it('谐调 openfda 块解包首个产品的分类事实', () => {
    const e = mapRegistration(sample)!;
    expect(e.deviceFacts).toEqual({
      deviceName: 'System, Image Processing, Radiological',
      deviceClass: '2',
      medicalSpecialtyDescription: 'Radiology',
      regulationNumber: '892.2050',
    });
  });

  it('🔴 绝不提取 us_agent / owner_operator 等具名个人字段（GDPR 隔离）', () => {
    const e = mapRegistration(sample)!;
    const serialized = JSON.stringify(e);
    expect(serialized).not.toContain('Jane Doe');
    expect(serialized).not.toContain('jane.doe@example.com');
    expect(serialized).not.toContain('John');
    expect(serialized).not.toContain('Smith');
    expect(serialized).not.toMatch(/@/); // 无任何邮箱
  });

  it('缺 registration.name → null（主解析键缺失，不臆造）', () => {
    expect(mapRegistration({ registration: { registration_number: '999' }, products: [] })).toBeNull();
  });

  it('openfda 谐调块整块缺失 → deviceFacts undefined（缺块当 null）', () => {
    const e = mapRegistration({ registration: { name: 'Acme Devices', iso_country_code: 'CN' }, products: [{ product_code: 'ABC' }] })!;
    expect(e.deviceFacts).toBeUndefined();
    expect(e.country).toBe('CN');
    expect(e.productCodes).toEqual(['ABC']);
    expect(e.initialImporter).toBe(false);
  });

  it('采集全部产品的 device_name + 非个人 owner_operator_number（跨设施归并用）', () => {
    const e = mapRegistration(sample)!;
    expect(e.deviceNames).toEqual(['System, Image Processing, Radiological']);
    expect(e.ownerOperatorNumbers).toEqual(['9012345']);
  });

  it('deviceFacts 优先取**匹配 ICP 搜索码**的产品（非 products[0] 那个无关设备）', () => {
    const raw = {
      registration: { name: 'Acme Medical', iso_country_code: 'US' },
      products: [
        { product_code: 'IYE', openfda: { device_name: 'X-Ray Assembly', medical_specialty_description: 'Radiology' } }, // products[0]=无关
        { product_code: 'LYZ', openfda: { device_name: 'Surgical Gown', medical_specialty_description: 'General & Plastic Surgery' } }, // 搜索命中
      ],
    };
    const e = mapRegistration(raw, ['LYZ'])!; // 搜索的是外科手术衣
    expect(e.deviceFacts?.medicalSpecialtyDescription).toBe('General & Plastic Surgery'); // 取命中产品，非 Radiology
  });

  it('无 preferProductCodes → 退首个带谐调块的产品（跳过缺块的 products[0]）', () => {
    const raw = {
      registration: { name: 'Beta Devices', iso_country_code: 'DE' },
      products: [
        { product_code: 'AAA' }, // 无 openfda 块
        { product_code: 'BBB', openfda: { medical_specialty_description: 'Cardiovascular' } },
      ],
    };
    const e = mapRegistration(raw)!;
    expect(e.deviceFacts?.medicalSpecialtyDescription).toBe('Cardiovascular'); // 不因 products[0] 缺块而丢分类
  });
});
