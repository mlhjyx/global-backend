import { describe, expect, it } from 'vitest';
import { enrichIcpBriefForJudge } from './icp-judge-guidance';

describe('enrichIcpBriefForJudge', () => {
  it('injects process_required=false for downstream distributor/EPC ICPs and attaches guidance', () => {
    const enriched = enrichIcpBriefForJudge({
      seller: '琏升科技',
      seller_summary: 'HJT 光伏组件制造商',
      icp_name: '意大利光伏分销商与EPC',
      icp_trade_role: 'distributor',
      company_attributes: {
        industry: 'Solar',
        business_model: '光伏组件分销与EPC工程承包',
      },
    });
    expect((enriched.company_attributes as Record<string, unknown>).process_required).toBe(false);
    expect(enriched.evaluation_guidance?.length).toBeGreaterThanOrEqual(3);
    expect(enriched.evaluation_guidance?.some((g) => g.includes('Ordina ora'))).toBe(true);
    expect(enriched.evaluation_guidance?.some((g) => g.includes('C1_MATERIAL'))).toBe(true);
  });

  it('respects explicit process_required=true on OEM manufacturing ICPs', () => {
    const enriched = enrichIcpBriefForJudge({
      seller: 'Acme CNC',
      seller_summary: null,
      icp_name: 'CNC 机加工OEM工厂',
      icp_trade_role: null,
      company_attributes: {
        business_model: 'CNC machining OEM factory',
        process_required: true,
      },
    });
    expect((enriched.company_attributes as Record<string, unknown>).process_required).toBe(true);
  });
});
