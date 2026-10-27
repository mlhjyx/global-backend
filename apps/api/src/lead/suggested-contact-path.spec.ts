import { describe, expect, it } from 'vitest';
import {
  SUGGESTED_CONTACT_LEGAL_NOTE,
  suggestedContactPath,
} from './suggested-contact-path';

/**
 * BI-15（交付闭环设计 §7）：建议联系路径是确定性规则，不是模型判断。优先级固定为
 * 供应商入驻页 > 询盘表单 > 联系页 > Impressum 页；合规备注是固定文案。
 */
describe('suggestedContactPath', () => {
  const point = (kind: string, value = `https://example.de/${kind.replaceAll('_', '-')}`) => ({
    kind,
    value,
    status: 'UNVERIFIED',
  });

  it('picks the supplier page above every other path', () => {
    expect(
      suggestedContactPath([
        point('impressum_page'),
        point('contact_page'),
        point('contact_form'),
        point('supplier_page'),
      ]),
    ).toEqual({
      kind: 'supplier_page',
      url: 'https://example.de/supplier-page',
      legal_note: SUGGESTED_CONTACT_LEGAL_NOTE,
    });
  });

  it('falls back in the design order: contact form, contact page, Impressum', () => {
    expect(suggestedContactPath([point('impressum_page'), point('contact_page'), point('contact_form')])?.kind).toBe(
      'contact_form',
    );
    expect(suggestedContactPath([point('impressum_page'), point('contact_page')])?.kind).toBe('contact_page');
    expect(suggestedContactPath([point('impressum_page')])?.kind).toBe('impressum_page');
  });

  it('never suggests social pages and ignores invalid or non-https rows', () => {
    expect(
      suggestedContactPath([
        point('linkedin_company_page'),
        point('x_company_account'),
        { kind: 'contact_page', value: 'http://example.de/kontakt', status: 'UNVERIFIED' },
        { kind: 'contact_form', value: 'https://example.de/form', status: 'INVALID' },
      ]),
    ).toBeNull();
  });

  it('returns null when there is no admissible path and does not depend on row order', () => {
    expect(suggestedContactPath([])).toBeNull();
    const points = [point('contact_page', 'https://example.de/b'), point('contact_page', 'https://example.de/a')];
    expect(suggestedContactPath(points)?.url).toBe('https://example.de/a');
    expect(suggestedContactPath([...points].reverse())?.url).toBe('https://example.de/a');
  });

  it('states the fixed compliance note of the design', () => {
    expect(SUGGESTED_CONTACT_LEGAL_NOTE).toBe(
      '官网公开入口，未验证投递；首次联系请用询盘表单或电话说明来意，邮件广告需事先同意',
    );
  });
});
