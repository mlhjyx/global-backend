import { describe, expect, it } from 'vitest';
import {
  buyerOutreachFacts,
  fitOutreachFacts,
  outreachDraftCell,
  outreachDraftLanguage,
  outreachDraftPrompt,
  replyEntryFooter,
  sellerOutreachFacts,
  signalOutreachFacts,
  ungroundedFacts,
} from './outreach-draft';

describe('outreach draft language (design E5, §7)', () => {
  it.each([
    ['DE', 'de'],
    ['Germany', 'de'],
    ['德国', 'de'],
    ['FR', 'fr'],
    ['US', 'en'],
    ['Nowhere', 'en'],
    [null, 'en'],
    [undefined, 'en'],
  ])('maps buyer country %s to %s', (country, language) => {
    expect(outreachDraftLanguage(country)).toBe(language);
  });
});

describe('outreach draft facts stay company-level and keyed', () => {
  it('builds seller facts from approved claims and offerings, capped and clipped', () => {
    const facts = sellerOutreachFacts({
      name: 'Acme Pumps',
      website: 'https://acme.test',
      summary: 's'.repeat(2000),
      claims: [{ id: 'claim-1', type: 'certification', statement: 'ISO 9001' }],
      offerings: [{ id: 'offering-1', name: 'Pump X', description: 'High pressure' }],
    });
    expect(facts.map((fact) => fact.key)).toEqual([
      'seller.name',
      'seller.website',
      'seller.summary',
      'seller.claim:claim-1',
      'seller.offering:offering-1',
    ]);
    expect(facts[3]!.text).toBe('[certification] ISO 9001');
    expect(facts[2]!.text.length).toBeLessThanOrEqual(800);
  });

  it('never lifts contacts, names or emails out of the buyer profile', () => {
    const facts = buyerOutreachFacts({
      name: 'Pumpen Handel GmbH',
      domain: 'pumpen-handel.example',
      country: 'DE',
      attributes: {
        website_profile: {
          trade_role: 'distributor',
          own_manufacturing: false,
          carried_brands: [{ name: 'KSB', country: 'de' }, { name: 'Shimge', country: 'cn' }],
        },
        contacts: [{ email: 'buyer@example.test', name: 'Jane Doe' }],
        decision_makers: ['Jane Doe'],
      },
    });
    expect(facts.map((fact) => fact.key)).toEqual([
      'buyer.name',
      'buyer.domain',
      'buyer.country',
      'buyer.trade_role',
      'buyer.own_manufacturing',
      'buyer.carried_brands',
    ]);
    expect(facts.map((fact) => fact.text).join('\n')).not.toContain('Jane');
    expect(facts.find((fact) => fact.key === 'buyer.carried_brands')!.text).toBe('KSB (DE); Shimge (CN)');
  });

  it('turns the stored fit verdict and signals into facts with stable keys', () => {
    const fit = fitOutreachFacts({
      fitVerdict: 'match',
      totalScore: 0.8123,
      queue: 'recommended',
      scores: {},
      scoreDetail: null,
    });
    expect(fit).toEqual([
      { key: 'fit.verdict', text: 'match' },
      { key: 'fit.score', text: '0.812' },
      { key: 'fit.reason_codes', text: 'FIT_MATCH' },
    ]);

    const signals = signalOutreachFacts({
      intent: {
        events: [
          { type: 'expanded_product_line', at: '2026-10-01T08:00:00.000Z', page_url: 'https://buyer.test/news' },
          { type: 'expanded_product_line', at: '2026-10-01T09:00:00.000Z', page_url: null },
          { type: 'hiring_sales', at: '2026-09-20T00:00:00.000Z', page_url: null },
        ],
      },
    });
    expect(signals.map((fact) => fact.key)).toEqual([
      'signal:expanded_product_line@2026-10-01',
      'signal:expanded_product_line@2026-10-01#2',
      'signal:hiring_sales@2026-09-20',
    ]);
  });
});

describe('reply-entry footer (design E8)', () => {
  it('appends the seller website, email and a wa.me link in a fixed order', () => {
    expect(
      replyEntryFooter({
        sellerName: 'Acme Pumps',
        website: 'https://acme.test',
        email: 'sales@acme.test',
        whatsapp: '+4915112345678',
      }),
    ).toBe(
      ['—', 'Reply directly to Acme Pumps:', 'Website: https://acme.test', 'Email: sales@acme.test', 'WhatsApp: https://wa.me/4915112345678'].join('\n'),
    );
  });

  it('omits a number that is not E.164 and returns nothing without any channel', () => {
    expect(
      replyEntryFooter({ sellerName: 'Acme', website: null, email: null, whatsapp: '015112345678' }),
    ).toBe('');
    expect(
      replyEntryFooter({ sellerName: 'Acme', website: 'https://acme.test', email: null, whatsapp: null }),
    ).toBe(['—', 'Reply directly to Acme:', 'Website: https://acme.test'].join('\n'));
  });
});

describe('grounding and prompting (§7 constraints)', () => {
  it('discards a draft whose used_facts are unknown or empty', () => {
    const allowed = new Set(['seller.name', 'buyer.name']);
    expect(ungroundedFacts(['seller.name'], allowed)).toEqual([]);
    expect(ungroundedFacts(['seller.name', 'made.up'], allowed)).toEqual(['made.up']);
    expect(ungroundedFacts([], allowed)).toEqual(['<empty>']);
  });

  it('lists every fact key in the prompt with the language instruction', () => {
    const prompt = outreachDraftPrompt(
      [{ key: 'seller.name', text: 'Acme' }, { key: 'buyer.name', text: 'Pumpen Handel' }],
      'de',
    );
    expect(prompt).toContain('德语（Deutsch）（de）');
    expect(prompt).toContain('- seller.name: Acme');
    expect(prompt).toContain('- buyer.name: Pumpen Handel');
    expect(prompt).toContain('used_facts 只能从上面的事实键中选');
    expect(prompt).toContain('正文不要写签名或联系方式');
  });

  it('renders the weekly-report cell with the review note and never for a missing draft', () => {
    expect(outreachDraftCell(null)).toBe('');
    expect(
      outreachDraftCell({ subject: 'Hallo', body: 'Text', bodyZh: '文本' }),
    ).toBe('主题：Hallo\n\nText\n\n中文译文：\n文本\n\n草稿，需人工审阅；平台未发送');
  });
});
