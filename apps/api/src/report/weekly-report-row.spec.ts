import { describe, expect, it } from 'vitest';
import {
  formatMicrousd,
  WEEKLY_REPORT_COLUMNS,
  weeklyReportRow,
  type WeeklyReportRowInput,
} from './weekly-report-row';

const LEAD_ID = '6f1c3c2e-6a43-4f5e-9d0e-2b1d1e0c9a01';
const RUN_ID = '0b4e2a5d-1c7f-4e8a-9b3c-5d6e7f8a9b0c';

function input(overrides: Partial<WeeklyReportRowInput> = {}): WeeklyReportRowInput {
  return {
    leadId: LEAD_ID,
    fitVerdict: 'match',
    totalScore: 0.8123,
    scores: { fit: 0.9, role: 0.8, intent: 0.25, dataQuality: 0.7, reachability: 1.4, engagement: 0 },
    company: {
      name: 'Pumpen Handel GmbH',
      domain: 'pumpen-handel.example',
      country: 'DE',
      attributes: {
        website_profile: {
          trade_role: 'distributor',
          trade_role_confidence: 0.7,
          own_manufacturing: false,
          carried_brands: [
            { name: 'Shimge', country: 'cn' },
            { name: 'Pentair', country: 'us' },
            { name: 'KSB', country: 'de' },
            { name: 'NoOrigin' },
          ],
          register_key: 'de-hrb:siegburg:1525',
          vat_id: 'DE811255398',
          source_url: 'https://pumpen-handel.example/impressum',
        },
      },
    },
    contactPoints: [
      { kind: 'impressum_page', value: 'https://pumpen-handel.example/impressum', status: 'UNVERIFIED' },
      { kind: 'contact_page', value: 'https://pumpen-handel.example/kontakt', status: 'VALID' },
      { kind: 'supplier_page', value: 'https://pumpen-handel.example/lieferanten', status: 'UNVERIFIED' },
      { kind: 'contact_form', value: 'https://pumpen-handel.example/anfrage', status: 'INVALID' },
    ],
    sanctionsStatus: 'clear',
    validUntil: '2027-04-10T08:00:00.000Z',
    runCost: { runId: RUN_ID, chargedMicrousd: 2_840_000n },
    ...overrides,
  };
}

function byColumn(row: readonly unknown[]): Record<string, unknown> {
  expect(row).toHaveLength(WEEKLY_REPORT_COLUMNS.length);
  return Object.fromEntries(WEEKLY_REPORT_COLUMNS.map((column, index) => [column, row[index]]));
}

describe('weekly report row (BI-22, design §5)', () => {
  it('lays out the design §5 columns, with the five customer columns last', () => {
    expect(WEEKLY_REPORT_COLUMNS.slice(-5)).toEqual([
      '客户填写：相关性（1-5）',
      '客户填写：愿意联系（是/否）',
      '客户填写：原因码',
      '客户填写：备注',
      '客户填写：是否已联系（是/否）',
    ]);
    expect(new Set(WEEKLY_REPORT_COLUMNS).size).toBe(WEEKLY_REPORT_COLUMNS.length);
    const cost = WEEKLY_REPORT_COLUMNS.find((column) => column.startsWith('本条成本'));
    // The column name itself carries the basis: run total, ledger amounts, not allocated per lead.
    expect(cost).toContain('run');
    expect(cost).toContain('账本');
    expect(cost).toContain('未按线索分摊');
  });

  it('fills the company, website profile, score, sanctions, freshness and cost columns', () => {
    const row = byColumn(weeklyReportRow(input()));
    expect(row).toMatchObject({
      公司名: 'Pumpen Handel GmbH',
      域名: 'pumpen-handel.example',
      国家: 'DE',
      贸易角色: '分销商',
      贸易角色置信度: '0.70',
      自有制造: '否',
      '在售品牌（中国）': 'Shimge',
      '在售品牌（非中国，含产地）': 'Pentair (US); KSB (DE); NoOrigin',
      登记号: 'de-hrb:siegburg:1525',
      税号: 'DE811255398',
      'Fit 分': '0.90',
      角色分: '0.80',
      意图分: '0.25',
      数据质量分: '0.70',
      可达性分: '1.00',
      互动分: '0.00',
      总分: '0.81',
      'Fit 结论': '匹配',
      制裁状态: '已筛查，无命中',
      有效期至: '2027-04-10',
      '所属发现 run ID': RUN_ID,
      '线索 ID': LEAD_ID,
    });
    expect(row['本条成本 USD（所属发现 run 合计，后端账本口径，未按线索分摊）']).toBe('2.840000');
  });

  it('leaves the columns that later PRs fill, and the customer columns, empty', () => {
    const row = byColumn(weeklyReportRow(input()));
    for (const column of [
      '为什么现在',
      '原因码',
      '注册地址',
      '开发信草稿',
      '客户填写：相关性（1-5）',
      '客户填写：愿意联系（是/否）',
      '客户填写：原因码',
      '客户填写：备注',
      '客户填写：是否已联系（是/否）',
    ]) {
      expect(row[column], column).toBe('');
    }
  });

  it('lists contact paths by preference without rejected ones, and links each piece of evidence once', () => {
    const row = byColumn(weeklyReportRow(input()));
    expect(row['联系路径']).toBe(
      [
        '供应商入驻页：https://pumpen-handel.example/lieferanten',
        '联系页：https://pumpen-handel.example/kontakt（已人工确认）',
        'Impressum 页：https://pumpen-handel.example/impressum',
      ].join('\n'),
    );
    expect(row['证据链接']).toBe(
      [
        'https://pumpen-handel.example/impressum',
        'https://pumpen-handel.example/lieferanten',
        'https://pumpen-handel.example/kontakt',
      ].join('\n'),
    );
  });

  it('writes empty cells, not guesses, when a fact is missing or malformed', () => {
    const row = byColumn(
      weeklyReportRow(
        input({
          fitVerdict: null,
          totalScore: null,
          scores: null,
          company: {
            name: 'Bare GmbH',
            domain: null,
            country: null,
            attributes: { website_profile: { trade_role_confidence: 'high', own_manufacturing: 'yes', carried_brands: 'x' } },
          },
          contactPoints: [{ kind: 'contact_page', value: 'http://bare.example/kontakt', status: 'UNVERIFIED' }],
          sanctionsStatus: 'not_screened',
          validUntil: null,
          runCost: { runId: RUN_ID, chargedMicrousd: null },
        }),
      ),
    );
    expect(row).toMatchObject({
      域名: '',
      国家: '',
      贸易角色: '',
      贸易角色置信度: '',
      自有制造: '',
      '在售品牌（中国）': '',
      'Fit 分': '',
      总分: '',
      'Fit 结论': '',
      证据链接: '',
      联系路径: '',
      制裁状态: '未筛查（筛查未启用）',
      有效期至: '',
      '所属发现 run ID': RUN_ID,
    });
    expect(row['本条成本 USD（所属发现 run 合计，后端账本口径，未按线索分摊）']).toBe('');
    expect(byColumn(weeklyReportRow(input({ runCost: null })))['所属发现 run ID']).toBe('');
  });

  it('shows an unknown stored label as is, without reading the prototype', () => {
    const row = byColumn(
      weeklyReportRow(
        input({
          fitVerdict: 'constructor',
          company: { name: 'X GmbH', domain: null, country: null, attributes: { website_profile: { trade_role: 'toString' } } },
        }),
      ),
    );
    expect(row['Fit 结论']).toBe('constructor');
    expect(row['贸易角色']).toBe('toString');
  });

  it('names a cleared false positive explicitly', () => {
    expect(byColumn(weeklyReportRow(input({ sanctionsStatus: 'cleared_false_positive' })))['制裁状态']).toBe(
      '已筛查，命中经人工复核为误报',
    );
  });

  it('formats ledger micro-dollars exactly', () => {
    expect(formatMicrousd(0n)).toBe('0.000000');
    expect(formatMicrousd(1n)).toBe('0.000001');
    expect(formatMicrousd(2_840_000n)).toBe('2.840000');
    expect(formatMicrousd(12_345_678_901n)).toBe('12345.678901');
  });
});
