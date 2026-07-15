/**
 * verify-industrial-template.mts -- 真机验证 B2B 工业模板（distill trumpf+tecloman 产出）。
 * 生成一个制造类 intake 的 SiteSpec，落盘后供 astro build 渲染（无 sandbox，§5 硬规矩）。
 * 用法：node --import tsx apps/api/scripts/verify-industrial-template.mts
 *   然后：SITESPEC_PATH=/tmp/industrial-spec.json pnpm --filter @global/site-renderer exec astro build
 */
import { writeFileSync } from 'node:fs';
import { buildSiteSpec, pickTemplate } from '../src/site-builder/demo-spec';
import type { IntakeInput } from '../src/site-builder/intake.service';

const intake: IntakeInput = {
  company: { nameZh: '杭州爱克姆泵业', nameEn: 'Acme Pump Co., Ltd.' },
  industry: 'isic-2813',
  products: ['centrifugal pump', 'screw pump'],
  targetMarkets: ['DE', 'US'],
  hasWebsite: false,
  websiteUrl: null,
  businessEmail: 'sales@acmepump.com',
};

const doc = buildSiteSpec({ siteName: 'Acme Pump Co., Ltd.', intake });
writeFileSync('/tmp/industrial-spec.json', JSON.stringify(doc, null, 2), 'utf8');

console.log('pickTemplate:', pickTemplate(intake));
console.log('preset:', doc.site.theme.preset);
console.log('home sections:', doc.pages[0].puck.content.map((b) => b.type).join(' -> '));
console.log('pages:', doc.pages.map((p) => p.id).join(', '));
console.log('spec written: /tmp/industrial-spec.json');
