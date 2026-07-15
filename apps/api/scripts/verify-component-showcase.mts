/**
 * verify-component-showcase.mts -- 渲染验证未接进模板的缺口组件（纯渲染体检，非客户站）。
 * 用诚实占位/通用文案（不虚构真实客户事实）构造一个 showcase spec，astro 渲染后人工/grep 核验。
 * 用法：node --import tsx apps/api/scripts/verify-component-showcase.mts
 *   然后：SITESPEC_PATH=/tmp/showcase-spec.json OUT_DIR=/tmp/showcase-preview BASE_PATH=/ pnpm --filter @global/site-renderer exec astro build
 */
import { writeFileSync } from 'node:fs';
import { DEMO_SPEC_VERSION } from '../src/site-builder/demo-spec';

const en: Record<string, string> = {
  'nav.home': 'Home',
  'seo.title': 'Component Showcase',
  'seo.desc': 'Component showcase',
  'showcase.title': 'Component Showcase',
  'marquee.1': 'Quality Manufacturing',
  'marquee.2': 'Global Export',
  'marquee.3': 'OEM / ODM',
  'history.title': 'Our Journey',
  'history.m1.title': 'Milestone One',
  'history.m1.body': 'Add your company milestone here.',
  'history.m2.title': 'Milestone Two',
  'history.m2.body': 'Add another milestone.',
  'gallery.title': 'Gallery',
  'team.title': 'Our Team',
  'team.m1.name': 'Team Member',
  'team.m1.role': 'Title',
};

const doc = {
  specVersion: DEMO_SPEC_VERSION,
  site: {
    defaultLocale: 'en',
    locales: ['en'],
    theme: { preset: 'industrial-tecloman' },
    nav: [{ labelKey: 'nav.home', pageId: 'home' }],
    seoGlobal: { siteName: 'Component Showcase' },
  },
  pages: [
    {
      id: 'home',
      path: '/',
      seo: { titleKey: 'seo.title', descriptionKey: 'seo.desc' },
      puck: {
        root: { props: {} },
        content: [
          { type: 'PageHeader', props: { id: 'ph1', titleKey: 'showcase.title' } },
          {
            type: 'MarqueeStrip',
            props: {
              id: 'm1',
              items: [{ labelKey: 'marquee.1' }, { labelKey: 'marquee.2' }, { labelKey: 'marquee.3' }],
            },
          },
          { type: 'GalleryGrid', props: { id: 'g1', titleKey: 'gallery.title' } },
          {
            type: 'HistoryTimeline',
            props: {
              id: 'h1',
              titleKey: 'history.title',
              milestones: [
                { year: '20XX', titleKey: 'history.m1.title', bodyKey: 'history.m1.body' },
                { year: '20XX', titleKey: 'history.m2.title', bodyKey: 'history.m2.body' },
              ],
            },
          },
          {
            type: 'TeamGrid',
            props: {
              id: 't1',
              titleKey: 'team.title',
              members: [{ nameKey: 'team.m1.name', roleKey: 'team.m1.role' }],
            },
          },
        ],
      },
    },
  ],
  assets: {},
  copyBundles: { en },
};

writeFileSync('/tmp/showcase-spec.json', JSON.stringify(doc, null, 2), 'utf8');
console.log('showcase spec written: /tmp/showcase-spec.json');
console.log('components:', doc.pages[0].puck.content.map((b: { type: string }) => b.type).join(' -> '));
