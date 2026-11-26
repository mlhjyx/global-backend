import { describe, expect, it, vi } from 'vitest';
import {
  isConsumerFreemailEmail,
  loadBattleSellerContext,
  resolveBattleSellerContext,
  translateMixedOfferingText,
} from './battle-seller-context';

describe('battle-seller-context (#96-4 foreign seller name, product summary & inbound footer)', () => {
  it('prefers foreign site.name / site.profile.companyProfile / Latin fragment / brandized domain over Chinese company name', () => {
    expect(
      resolveBattleSellerContext({
        seller: { name: '琏升科技股份有限公司', website: 'https://www.liansheng-pv.com' },
        site: { name: 'Liansheng PV Co., Ltd.' },
      }).sellerName,
    ).toBe('Liansheng PV Co., Ltd.');

    expect(
      resolveBattleSellerContext({
        seller: { name: '琏升科技股份有限公司', website: 'https://www.liansheng-pv.com' },
        site: {
          name: '琏升光伏官网',
          profile: { companyProfile: { brandName: 'Liansheng Solar' } },
        },
      }).sellerName,
    ).toBe('Liansheng Solar');

    expect(
      resolveBattleSellerContext({
        seller: { name: '琏升光伏 (Liansheng PV Tech)', website: 'https://www.liansheng-pv.com' },
      }).sellerName,
    ).toBe('Liansheng PV Tech');

    expect(
      resolveBattleSellerContext({
        seller: { name: '琏升科技股份有限公司', website: 'https://www.liansheng-pv.com' },
      }).sellerName,
    ).toBe('Liansheng PV');
  });

  it('extracts foreign product summary across offerings, specs, APPROVED/EXTRACTED claims, and ICP valueProps', () => {
    expect(
      resolveBattleSellerContext({
        seller: { name: 'Liansheng PV' },
        offerings: [{ name: 'N-type HJT 700W Bifacial Module' }, { name: '高效异质结组件' }],
      }).sellerProductSummary,
    ).toBe('N-type HJT 700W Bifacial Module');

    expect(
      resolveBattleSellerContext({
        seller: { name: 'Liansheng PV' },
        offerings: [
          {
            name: '高效异质结光伏组件',
            description: '600-720W HJT bifacial solar modules with IEC 61215',
            attributes: { efficiency: '23.2% module efficiency' },
          },
        ],
      }).sellerProductSummary,
    ).toContain('600-720W HJT bifacial solar modules');

    expect(
      resolveBattleSellerContext({
        seller: { name: 'Liansheng PV' },
        offerings: [{ name: '高效异质结光伏组件' }],
        claims: [
          { type: 'capability', statement: 'Extracted 5GW annual capacity', status: 'EXTRACTED' },
          { type: 'certification', statement: 'TUV IEC 61215 & IEC 61730 certified HJT modules', status: 'APPROVED' },
        ],
      }).sellerProductSummary,
    ).toBe('TUV IEC 61215 & IEC 61730 certified HJT modules; Extracted 5GW annual capacity');

    expect(
      resolveBattleSellerContext({
        seller: { name: 'Liansheng PV' },
        offerings: [{ name: '高效异质结光伏组件' }],
        claims: [],
        icpValueProps: ['中文卖点', 'Factory-direct EU warehouse stock for 660W HJT modules'],
      }).sellerProductSummary,
    ).toBe('Factory-direct EU warehouse stock for 660W HJT modules');
  });

  it('assembles sellerInboundFooter from website, public/business email, and WhatsApp E.164', () => {
    const ctx = resolveBattleSellerContext({
      seller: {
        name: '琏升科技股份有限公司',
        website: 'https://www.liansheng-pv.com/',
        businessEmail: 'export@liansheng-pv.com',
        publicContacts: [{ type: 'whatsapp', value: '+8613800138000' }],
      },
      site: {
        name: 'Liansheng PV',
        profile: {
          contact: {
            publicEmails: ['sales@liansheng-pv.com'],
            whatsappNumbers: ['+8613900139000'],
          },
        },
      },
    });
    expect(ctx.sellerInboundFooter).toBe(
      'Liansheng PV | https://www.liansheng-pv.com | export@liansheng-pv.com | https://wa.me/8613900139000',
    );
  });

  it('loads seller context inside a transaction and filters claims by APPROVED / EXTRACTED', async () => {
    const claimFindMany = vi.fn(async () => [
      { type: 'value_prop', statement: 'Direct factory HJT bifacial modules 660-720W', status: 'APPROVED' },
    ]);
    const tx = {
      companyProfile: {
        findUnique: vi.fn(async () => ({
          name: '琏升科技',
          website: 'https://liansheng-pv.com',
          summary: '中文简介',
          industry: '光伏制造',
          businessEmail: 'sales@liansheng-pv.com',
          publicContacts: [],
        })),
      },
      site: {
        findFirst: vi.fn(async () => ({
          name: 'Liansheng PV',
          profile: { contact: { whatsappNumbers: ['+8613800138000'] } },
        })),
      },
      offering: { findMany: vi.fn(async () => [{ name: '高效异质结组件', description: null, attributes: {} }]) },
      claim: { findMany: claimFindMany },
    };

    const result = await loadBattleSellerContext(tx as never, {
      companyId: 'seller-1',
      icpValueProps: [],
    });
    expect(claimFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'seller-1', status: { in: ['APPROVED', 'EXTRACTED'] } },
      }),
    );
    expect(result).toEqual({
      sellerName: 'Liansheng PV',
      sellerProductSummary: 'Direct factory HJT bifacial modules 660-720W',
      sellerInboundFooter: 'Liansheng PV | https://liansheng-pv.com | sales@liansheng-pv.com | https://wa.me/8613800138000',
    });
  });

  it('F6: keeps product terms when summarizing mixed Chinese/English offerings', () => {
    const offerings = [
      'G12-0BB曙光星Pro 730-765W',
      'G12-0BB晨光星PRO 530-565W',
      '高效异质结（HJT）组件',
      '异质结（HJT）电池片',
      '异质结光伏瓦 / BIPV光伏建材',
      '新示例G12-0BB太阳能芯片',
      '曙光星PRO / 晨光星PRO异质结组件',
      '储能微电网系统 / 光储解决方案',
    ];
    for (const name of offerings) {
      const translated = translateMixedOfferingText(name);
      expect(translated, name).toBeTruthy();
      expect(translated, name).not.toMatch(/[\p{Script=Han}]/u);
      expect(translated, name).not.toContain('industrial OEM/ODM products');
    }

    const summary = resolveBattleSellerContext({
      seller: { name: '示例光伏', website: 'https://sunforge.example' },
      offerings: offerings.map((name) => ({ name })),
    }).sellerProductSummary;
    expect(summary).toBeTruthy();
    expect(summary).not.toMatch(/[\p{Script=Han}]/u);
    expect(summary).toContain('730-765W');
  });

  it('F6: filters consumer freemail domains (qq.com, 163.com, gmail.com) from Column 19 sellerInboundFooter', () => {
    expect(isConsumerFreemailEmail('fixture@qq.com')).toBe(true);
    expect(isConsumerFreemailEmail('sales@163.com')).toBe(true);
    expect(isConsumerFreemailEmail('founder@gmail.com')).toBe(true);
    expect(isConsumerFreemailEmail('export@sunforge.example')).toBe(false);

    const ctx = resolveBattleSellerContext({
      seller: {
        name: 'Sunforge PV',
        website: 'https://www.sunforge.example',
        businessEmail: 'fixture@qq.com',
        publicContacts: [{ type: 'email', value: 'test@163.com' }],
      },
      site: {
        name: 'Sunforge PV',
        profile: {
          contact: {
            publicEmails: ['founder@gmail.com', 'export@sunforge.example'],
          },
        },
      },
    });
    expect(ctx.sellerInboundFooter).toBe('Sunforge PV | https://www.sunforge.example | export@sunforge.example');

    const onlyConsumer = resolveBattleSellerContext({
      seller: {
        name: 'Sunforge PV',
        website: 'https://www.sunforge.example',
        businessEmail: 'fixture@qq.com',
      },
    });
    expect(onlyConsumer.sellerInboundFooter).toBe('Sunforge PV | https://www.sunforge.example');
  });

  it('keeps specific mixed-language products ahead of a generic industry label even with whitespace', () => {
    const result = resolveBattleSellerContext({
      seller: { name: 'Example Solar', industry: 'Manufacturing' },
      offerings: [{ name: '  高效异质结（HJT）  组件  ' }],
    });
    expect(result.sellerProductSummary).toContain('HJT');
    expect(result.sellerProductSummary).not.toMatch(/[\p{Script=Han}]/u);
  });

  it('keeps the specific offering ahead of a generic seller summary', () => {
    const result = resolveBattleSellerContext({
      seller: { name: 'Example Solar', summary: 'industrial OEM/ODM products', industry: 'Manufacturing' },
      offerings: [{ name: '高效异质结（HJT）组件' }],
    });
    expect(result.sellerProductSummary).toContain('HJT Modules');
  });
});
