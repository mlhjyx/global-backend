import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  build510kSearch,
  buildRegistrationSearch,
  countField,
  fdaDateToIso,
  isClearedDecision,
  map510k,
  mapRegistration,
  search510kClearances,
  searchRegistrations,
} from './openfda-api';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

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

  it('空白 product code 也 fail-closed，不生成可扩大查询面的畸形子句', () => {
    expect(() => buildRegistrationSearch({ productCodes: ['   '] })).toThrow(/productCodes/);
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

describe('FDA 日期归一（fdaDateToIso）—— §8.6 防 Date.parse NaN 静默 0 分', () => {
  it('已 ISO 日期原样', () => {
    expect(fdaDateToIso('2024-06-18')).toBe('2024-06-18');
  });
  it('紧凑 YYYYMMDD → ISO', () => {
    expect(fdaDateToIso('20240618')).toBe('2024-06-18');
  });
  it('ISO datetime → 取日期部', () => {
    expect(fdaDateToIso('2024-06-18T12:34:56Z')).toBe('2024-06-18');
  });
  it('空/垃圾/非法日期 → undefined（绝不写 NaN 的 at）', () => {
    expect(fdaDateToIso(undefined)).toBeUndefined();
    expect(fdaDateToIso('')).toBeUndefined();
    expect(fdaDateToIso('June 2024')).toBeUndefined();
    expect(fdaDateToIso('2024-13-40')).toBeUndefined(); // 合规格式但非法日期
  });
  it('拒绝会被 Date.parse 自动滚动的非法日历日与畸形 datetime', () => {
    expect(fdaDateToIso('2024-02-31')).toBeUndefined();
    expect(fdaDateToIso('20240231')).toBeUndefined();
    expect(fdaDateToIso('2024-02-29Tx')).toBeUndefined();
  });
  it('归一结果 Date.parse 恒合法（喂 recencyDecay 不得 NaN）', () => {
    for (const d of ['2024-06-18', '20240618', '2004-03-11T00:00:00Z']) {
      expect(Number.isNaN(Date.parse(fdaExpect(fdaDateToIso(d))))).toBe(false);
    }
  });
});

describe('510(k) 清关码过滤（isClearedDecision）—— §8.6 只对已清关的投，NSE/被拒绝不投', () => {
  it('SESE（Substantially Equivalent 主体）→ 清关', () => {
    expect(isClearedDecision('SESE')).toBe(true);
  });
  it('SE* 家族（SESK/SESU/SESD/SESP/SEKD）全清关', () => {
    for (const c of ['SESK', 'SESU', 'SESD', 'SESP', 'SEKD']) expect(isClearedDecision(c)).toBe(true);
  });
  it('非 SE 前缀等同变体 SN/ST/PT/SI + DENG（De Novo Granted）→ 清关', () => {
    for (const c of ['SN', 'ST', 'PT', 'SI', 'DENG']) expect(isClearedDecision(c)).toBe(true);
  });
  it('NSE（Not Substantially Equivalent，N 前缀）→ 不清关', () => {
    for (const c of ['NSES', 'NSET', 'NSEK']) expect(isClearedDecision(c)).toBe(false);
  });
  it('DENN（De Novo denied）/ WD（withdrawn）/ 空 → 不清关', () => {
    expect(isClearedDecision('DENN')).toBe(false);
    expect(isClearedDecision('WD')).toBe(false);
    expect(isClearedDecision(undefined)).toBe(false);
    expect(isClearedDecision('')).toBe(false);
  });
});

describe('510(k) search 构造（build510kSearch）—— 顶层 product_code/country_code + 日期范围', () => {
  it('单 product code：顶层 product_code:CODE（非 products.product_code）', () => {
    expect(build510kSearch({ productCodes: ['OHT'] })).toBe('product_code:OHT');
  });
  it('多 product code + 国别 + 日期范围（AND 拼接，括号 [FROM TO TO]）', () => {
    const q = build510kSearch({ productCodes: ['OHT', 'EFB'], countries: ['cn'], decisionDateFrom: '2024-01-01', decisionDateTo: '2024-12-31' });
    expect(q).toBe('(product_code:OHT OR product_code:EFB) AND country_code:CN AND decision_date:[2024-01-01 TO 2024-12-31]');
  });
  it('无日期 → 不加 decision_date 子句', () => {
    expect(build510kSearch({ productCodes: ['OHT'], countries: ['US'] })).toBe('product_code:OHT AND country_code:US');
  });
  it('空 product code 抛错（绝不裸拉全库）', () => {
    expect(() => build510kSearch({ productCodes: [] })).toThrow();
  });
  it('空白 product code 也 fail-closed', () => {
    expect(() => build510kSearch({ productCodes: [''] })).toThrow(/productCodes/);
  });
});

describe('510(k) 映射（map510k）—— 绿事实，剥离 🔴 具名 contact', () => {
  const sample = {
    k_number: 'K240583',
    applicant: 'Shenzhen Example Medical Co., Ltd.',
    contact: 'Jane Doe', // 🔴 具名个人
    country_code: 'cn',
    product_code: 'OHT',
    decision_date: '2024-06-18',
    decision_code: 'SESE',
    decision_description: 'Substantially Equivalent',
    device_name: 'IPL Home Use Hair Removal Device',
    address_1: '123 Example Rd',
    openfda: { device_name: 'System, Light Based, For Hair Removal', device_class: '2', medical_specialty_description: 'General & Plastic Surgery', regulation_number: '878.4810' },
  };

  it('提取绿事实（k_number/applicant/国 alpha-2/产品码/清关码/器械名/ISO 决定日）', () => {
    const c = map510k(sample)!;
    expect(c.kNumber).toBe('K240583');
    expect(c.applicant).toBe('Shenzhen Example Medical Co., Ltd.');
    expect(c.country).toBe('CN');
    expect(c.productCode).toBe('OHT');
    expect(c.decisionCode).toBe('SESE');
    expect(c.deviceName).toBe('IPL Home Use Hair Removal Device');
    expect(c.decisionDateIso).toBe('2024-06-18');
  });

  it('顶层 openfda 谐调块解包分类事实（510k 块在顶层，非 products 下）', () => {
    const c = map510k(sample)!;
    expect(c.deviceFacts?.medicalSpecialtyDescription).toBe('General & Plastic Surgery');
    expect(c.deviceFacts?.deviceClass).toBe('2');
  });

  it('🔴 绝不提取 contact / 地址明细里的自然人（GDPR 隔离）', () => {
    const c = map510k(sample)!;
    const serialized = JSON.stringify(c);
    expect(serialized).not.toContain('Jane Doe');
    expect(serialized).not.toContain('123 Example Rd');
    expect(serialized).not.toMatch(/@/);
  });

  it('缺 applicant → null（主解析键缺失，不臆造）', () => {
    expect(map510k({ k_number: 'K999', country_code: 'US' })).toBeNull();
  });

  it('紧凑决定日 → ISO 归一（§8.6 喂 recencyDecay 不得 NaN）', () => {
    const c = map510k({ ...sample, decision_date: '20240618' })!;
    expect(c.decisionDateIso).toBe('2024-06-18');
  });
});

/** 断言非空（fdaDateToIso 归一后必有值），供 Date.parse 断言用。 */
function fdaExpect(v: string | undefined): string {
  expect(v).toBeDefined();
  return v!;
}

describe('openFDA HTTP 与分页边界（仅 fake fetch）', () => {
  it('registrationlisting 的 NOT_FOUND 是合法零结果，且查询参数有界', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: { code: 'NOT_FOUND', message: 'No matches found!' } }, 404),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      searchRegistrations({ productCodes: ['LLZ'], isoCountry: 'cn', limit: 2, maxRecords: 2 }),
    ).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.pathname).toBe('/device/registrationlisting.json');
    expect(url.searchParams.get('search')).toBe('products.product_code:LLZ AND registration.iso_country_code:CN');
    expect(url.searchParams.get('limit')).toBe('2');
    expect(url.searchParams.get('skip')).toBe('0');
  });

  it('非 NOT_FOUND 的结构化 API error 向上抛且不回显不可信响应体', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ error: { code: 'INVALID_QUERY', message: 'bad syntax' } }, 404),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = searchRegistrations({ productCodes: ['LLZ'] });
    await expect(result).rejects.toThrow(/^openfda request failed: ERROR_TEXT_SHA256:[a-f0-9]{64}$/);
    await expect(result).rejects.not.toThrow(/INVALID_QUERY|bad syntax/);
  });

  it('429 按 retry-after 退避后重试，最终返回结果', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: { code: 'TOO_MANY_REQUESTS' } }, 429, { 'retry-after': '0.001' }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    vi.stubGlobal('fetch', fetchMock);

    const result = searchRegistrations({ productCodes: ['LLZ'], limit: 2 });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('跨页保留 skip 与上限，并跳过缺法人名的畸形记录', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { registration: { name: 'Alpha', iso_country_code: 'us' }, products: [{ product_code: 'LLZ' }] },
            { registration: { registration_number: 'missing-name' }, products: [] },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          results: [{ registration: { name: 'Beta', iso_country_code: 'de' }, products: [{ product_code: 'LLZ' }] }],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const result = searchRegistrations({ productCodes: ['LLZ'], limit: 2, maxRecords: 2 });
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject([{ name: 'Alpha', country: 'US' }, { name: 'Beta', country: 'DE' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1][0] as URL).searchParams.get('skip')).toBe('2');
  });

  it('510(k) 默认只返回有法人、合法日期且已清关的记录', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        results: [
          { applicant: 'Cleared GmbH', decision_date: '2024-02-29', decision_code: 'SESE', product_code: 'OHT' },
          { applicant: 'Denied GmbH', decision_date: '2024-02-29', decision_code: 'NSEK', product_code: 'OHT' },
          { applicant: 'Bad Date GmbH', decision_date: '2024-02-31', decision_code: 'SESE', product_code: 'OHT' },
          { decision_date: '2024-02-29', decision_code: 'SESE', product_code: 'OHT' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const rows = await search510kClearances({
      productCodes: ['OHT'],
      countries: ['de'],
      sinceDays: 30,
      now: Date.UTC(2024, 2, 1),
      limit: 10,
    });

    expect(rows).toEqual([
      expect.objectContaining({ applicant: 'Cleared GmbH', decisionDateIso: '2024-02-29', decisionCode: 'SESE' }),
    ]);
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.pathname).toBe('/device/510k.json');
    expect(url.searchParams.get('search')).toContain('country_code:DE');
    expect(url.searchParams.get('search')).toContain('decision_date:[2024-01-31 TO 2024-03-01]');
  });

  it('clearedOnly=false 仍要求合法日期，但保留 NSE 供显式审计', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        results: [
          { applicant: 'NSE Corp', decision_date: '20240618', decision_code: 'NSEK', product_code: 'OHT' },
          { applicant: 'No Timing Corp', decision_date: 'bad', decision_code: 'NSEK', product_code: 'OHT' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      search510kClearances({ productCodes: ['OHT'], clearedOnly: false, limit: 10, now: Date.UTC(2024, 5, 20) }),
    ).resolves.toEqual([expect.objectContaining({ applicant: 'NSE Corp', decisionDateIso: '2024-06-18' })]);
  });

  it('count 聚合过滤空 term，并把数值字符串归一为 number', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ results: [{ term: 'US', count: '12' }, { term: '', count: 99 }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(countField('/device/510k.json', 'country_code', 'product_code:OHT')).resolves.toEqual([
      { term: 'US', count: 12 },
    ]);
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get('count')).toBe('country_code.exact');
    expect(url.searchParams.get('search')).toBe('product_code:OHT');
  });

  it('畸形 JSON 重试有界，最终向上抛而不是返回空数据', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{broken', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = searchRegistrations({ productCodes: ['LLZ'] });
    const assertion = expect(result).rejects.toThrow();
    await vi.runAllTimersAsync();

    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}
