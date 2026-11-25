import { describe, expect, it } from 'vitest';
import { filterOfferingNames, isNavigationNoiseOffering } from './offering-noise-filter';

describe('offering-noise-filter (Batch 1.5-B seller offering hygiene)', () => {
  it('filters website navigation chrome such as 下载中心, 产品询问, Contact Us, and Downloads', () => {
    for (const noise of [
      '下载中心',
      '产品询问',
      '联系我们',
      '关于我们',
      '售后反馈',
      '收益计算',
      'Contact Us',
      'Download Center',
      'Privacy Policy',
      'Chi siamo',
      'Impressum',
      ' ',
    ]) {
      expect(isNavigationNoiseOffering(noise)).toBe(true);
    }
  });

  it('preserves genuine industrial offerings including Chinese, English, and model specs', () => {
    const clean = filterOfferingNames([
      '高效异质结（HJT）组件',
      '下载中心',
      'G12-0BB天王星Pro 730-765W',
      '产品询问',
      'HJT Bifacial Solar Modules (700-765W)',
      'Centrifugal Industrial Pumps',
      'Contact Us',
    ]);
    expect(clean).toEqual([
      '高效异质结（HJT）组件',
      'G12-0BB天王星Pro 730-765W',
      'HJT Bifacial Solar Modules (700-765W)',
      'Centrifugal Industrial Pumps',
    ]);
  });
});
