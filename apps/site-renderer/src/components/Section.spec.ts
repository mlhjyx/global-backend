import { describe, expect, it } from 'vitest';
import {
  SITE_SPEC_COMPONENT_TYPES,
  type SiteSpec,
} from '@global/contracts';
import { makeT, buildStaticLocalePaths } from '../lib/spec';

import electrician from '../../fixtures/electrician-spec.json';
import dispatch from '../../fixtures/dispatch-spec.json';
import inkwell from '../../fixtures/inkwell-spec.json';
import saffron from '../../fixtures/saffron-spec.json';
import novacore from '../../fixtures/novacore-spec.json';
import saas from '../../fixtures/saas-spec.json';
import bullseye from '../../fixtures/bullseye-spec.json';
import biotech from '../../fixtures/biotech-spec.json';
import midwest from '../../fixtures/midwest-spec.json';
import axiom from '../../fixtures/axiom-spec.json';
import demo from '../../fixtures/demo-spec.json';

const fixtures: Array<{ key: string; spec: SiteSpec }> = [
  { key: 'electrician', spec: electrician as unknown as SiteSpec },
  { key: 'dispatch', spec: dispatch as unknown as SiteSpec },
  { key: 'inkwell', spec: inkwell as unknown as SiteSpec },
  { key: 'saffron', spec: saffron as unknown as SiteSpec },
  { key: 'novacore', spec: novacore as unknown as SiteSpec },
  { key: 'saas', spec: saas as unknown as SiteSpec },
  { key: 'bullseye', spec: bullseye as unknown as SiteSpec },
  { key: 'biotech', spec: biotech as unknown as SiteSpec },
  { key: 'midwest', spec: midwest as unknown as SiteSpec },
  { key: 'axiom', spec: axiom as unknown as SiteSpec },
  { key: 'demo', spec: demo as unknown as SiteSpec },
];

describe('封闭组件库真值 SITE_SPEC_COMPONENT_TYPES', () => {
  it('含 55 型', () => {
    expect(SITE_SPEC_COMPONENT_TYPES).toHaveLength(55);
  });

  it('含已知首尾 type', () => {
    expect(SITE_SPEC_COMPONENT_TYPES).toContain('HeroBanner');
    expect(SITE_SPEC_COMPONENT_TYPES).toContain('StatementBlock');
  });

  it('不含未知 type（负例）', () => {
    expect(SITE_SPEC_COMPONENT_TYPES).not.toContain('UnknownType');
    expect(SITE_SPEC_COMPONENT_TYPES).not.toContain('');
  });
});

describe('11 fixture 确定性构建门', () => {
  for (const f of fixtures) {
    it(`${f.key}: 全 block type 在封闭库 + bundle 自洽 + 路径生成不崩`, () => {
      // 每 block 的 type 必须在封闭 55 型内（Section 渲染时未知 type 会 throw）
      for (const page of f.spec.pages) {
        for (const block of page.puck.content) {
          expect(
            SITE_SPEC_COMPONENT_TYPES.includes(block.type as never),
          ).toBe(true);
        }
      }
      // default locale 的 copyBundle 自洽：makeT 能解析 bundle 内每个 key
      const locale = f.spec.site.defaultLocale;
      const t = makeT(f.spec, locale);
      const bundle = f.spec.copyBundles[locale];
      for (const key of Object.keys(bundle)) {
        expect(t(key)).toBe(bundle[key]);
      }
      // 路径生成不崩（resolveSiteCopyBundle 对每个 advertised locale 都成功）
      expect(() => buildStaticLocalePaths(f.spec)).not.toThrow();
    });
  }
});
