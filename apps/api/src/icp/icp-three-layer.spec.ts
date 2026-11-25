import { describe, expect, it } from 'vitest';
import {
  buildMultiIcpPromptFocus,
  buildThreeLayerIcpAttributes,
  resolveOfferingsForOverrides,
  syncThreeLayerOnIcpPatch,
} from './icp-three-layer';

describe('ICP three-layer decoupling (seller_profile / buyer_spec / peer_exclusions)', () => {
  it('separates seller technical specs from buyer_spec product categories and builds peer_exclusions', () => {
    const attrs = buildThreeLayerIcpAttributes({
      company: {
        name: 'Liansheng Solar Tech',
        website: 'https://liansheng-solar.com',
        industry: 'Solar PV Manufacturing',
        summary: 'HJT 720W 0BB module manufacturer',
      },
      offerings: [
        { name: 'HJT 720W 0BB Photovoltaic Modules', description: 'G12 N-type bifacial IEC 61215 certified' },
        { name: 'Commercial Battery Storage Systems', description: null },
      ],
      companyAttributes: {
        trade_side: 'distributor',
        product: 'HJT 720W photovoltaic modules, solar inverters',
        industry: 'Renewable Energy Distribution',
      },
      exclusions: ['上游光伏组件制造同行', '纯零售消费者'],
      targetMarkets: ['IT', 'DE'],
      overrides: {
        buyerRoles: ['distributor', 'epc_integrator'],
        procurementScenario: 'distribution',
        peerExclusionNotes: ['同行业组件制造厂'],
      },
    });

    const seller = attrs.seller_profile as Record<string, unknown>;
    const buyer = attrs.buyer_spec as Record<string, unknown>;
    const peer = attrs.peer_exclusions as Record<string, unknown>;

    expect(seller.company_name).toBe('Liansheng Solar Tech');
    expect(seller.source_channel).toBe('official_website');
    expect(seller.technical_specs).toEqual(expect.arrayContaining(['HJT', '720W', '0BB', 'G12']));

    expect(buyer.target_roles).toEqual(expect.arrayContaining(['distributor', 'epc_integrator']));
    expect(buyer.process_required).toBe(false);
    expect(buyer.target_markets).toEqual(['IT', 'DE']);
    expect(buyer.procurement_scenario).toBe('distribution');
    // Buyer categories strip seller-only tech specs like HJT/0BB/720W!
    const categories = buyer.product_categories as string[];
    expect(categories.some((c) => /photovoltaic modules/iu.test(c))).toBe(true);
    expect(categories.some((c) => /\b0BB\b/iu.test(c))).toBe(false);

    expect(peer.excluded_domains).toContain('liansheng-solar.com');
    expect(peer.excluded_business_models).toEqual(
      expect.arrayContaining(['上游光伏组件制造同行', '同行业组件制造厂']),
    );
  });

  it('supports multi-ICP productLines filtering and prompt focus generation', () => {
    const offerings = [
      { name: 'Photovoltaic Modules', description: null, attributes: { selectedByUser: true } },
      { name: 'Industrial Heat Pumps', description: null, attributes: { selectedByUser: true } },
    ];
    const filtered = resolveOfferingsForOverrides(offerings, ['Heat Pumps']);
    expect(filtered.map((o) => o.name)).toEqual(['Industrial Heat Pumps']);

    const adHoc = resolveOfferingsForOverrides(offerings, ['Energy Storage Inverter']);
    expect(adHoc.map((o) => o.name)).toEqual(['Energy Storage Inverter']);

    const focus = buildMultiIcpPromptFocus({
      name: '德国工业热泵分销商',
      productLines: ['Industrial Heat Pumps'],
      buyerRoles: ['distributor'],
      procurementScenario: 'distribution',
      peerExclusionNotes: ['热泵OEM代工厂'],
    });
    expect(focus).toContain('德国工业热泵分销商');
    expect(focus).toContain('Industrial Heat Pumps');
    expect(focus).toContain('热泵OEM代工厂');
    expect(buildMultiIcpPromptFocus({})).toBe('');
  });

  it('keeps peer_exclusions and top-level exclusions synchronized on PATCH edits', () => {
    const synced = syncThreeLayerOnIcpPatch(
      {
        peer_exclusions: {
          excluded_business_models: ['上游工厂'],
          excluded_keywords: [],
          excluded_domains: ['seller.com'],
          rationale: 'keep',
        },
      },
      undefined,
      ['竞争对手制造厂'],
    );
    expect(synced.exclusions).toEqual(['竞争对手制造厂']);
    expect((synced.companyAttributes?.peer_exclusions as Record<string, unknown>).excluded_business_models).toEqual(
      expect.arrayContaining(['上游工厂', '竞争对手制造厂']),
    );
  });
});
