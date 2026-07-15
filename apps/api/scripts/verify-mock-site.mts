/**
 * verify-mock-site.mts -- 虚构中国出海制造企业（Volenergy 储能）走 industrial 模板生成完整独立站。
 * 全 mock 数据（虚构公司，非真实客户->非"虚构事实"，是 demo 内容创作）。
 * 图片用 /img/*.jpg（本地 picsum 占位图，自托管；客户站将来走 M1-c 派生图）。
 * 用法：node --import tsx apps/api/scripts/verify-mock-site.mts
 *   然后：SITESPEC_PATH=/tmp/volenergy-spec.json OUT_DIR=/tmp/volenergy-site BASE_PATH=/ pnpm --filter @global/site-renderer exec astro build
 */
import { writeFileSync } from 'node:fs';
import { DEMO_SPEC_VERSION } from '../src/site-builder/demo-spec';

const IMG = (n: string) => `/img/${n}.jpg`;

const en: Record<string, string> = {
  'nav.home': 'Home',
  'nav.products': 'Products',
  'nav.about': 'About',
  'nav.contact': 'Contact',
  'footer.tagline': 'Industrial battery energy storage systems. Engineered in Shenzhen, exported worldwide.',
  // seo
  'seo.home.title': 'Volenergy - Industrial Battery Energy Storage Manufacturer',
  'seo.home.desc': 'Volengine manufactures C&I and residential BESS. 2 GWh annual capacity, exported to 30+ countries.',
  'seo.products.title': 'Energy Storage Products - Volenergy',
  'seo.products.desc': 'C&I BESS, residential BESS, and rack lithium batteries from Volenergy.',
  'seo.about.title': 'About Volenergy - Energy Storage Since 2015',
  'seo.about.desc': 'Volenergy designs and manufactures lithium battery energy storage systems in Shenzhen.',
  'seo.contact.title': 'Contact Volenergy',
  'seo.contact.desc': 'Send us your energy storage requirements and our team will reply with a tailored proposal.',
  // hero
  'home.hero.headline': 'Volenergy - Industrial Battery Energy Storage Systems',
  'home.hero.subhead':
    'Engineering C&I and residential BESS for a decentralized energy future. 2 GWh annual capacity, exported to 30+ countries.',
  'home.hero.cta': 'Request a Quote',
  // trust
  'trust.title': 'Trusted by energy companies worldwide',
  // stats
  'stats.founded': 'Founded',
  'stats.area': 'Manufacturing Base',
  'stats.staff': 'Engineers & Staff',
  'stats.capacity': 'Annual Capacity',
  // products
  'products.title': 'Our Products',
  'products.header.title': 'Products & Solutions',
  'products.header.sub': 'Lithium battery energy storage for every scale.',
  'products.p1.name': 'C&I BESS',
  'products.p1.blurb': 'Commercial & Industrial Battery Energy Storage System. Liquid-cooled, scalable from 100 kWh to MWh.',
  'products.p2.name': 'Residential BESS',
  'products.p2.blurb': 'Home energy storage battery. 5–20 kWh, LFP cells, smart hybrid inverter ready.',
  'products.p3.name': 'Rack Battery',
  'products.p3.blurb': '19-inch server rack lithium battery. 48V / 51.2V, modular for telecom and data centers.',
  // factory
  'factory.title': 'Our Manufacturing Base',
  'factory.body':
    '20,000m² production facility in Shenzhen with automated cell assembly, full-cycle quality testing, and IEC 62619-compliant line.',
  // cases
  'cases.title': 'Customer Success Stories',
  'cases.c1.title': 'Wien Energie Microgrid',
  'cases.c1.body': '12.5 MWh C&I BESS deployed for grid-balancing at an Austrian municipal utility.',
  'cases.c2.title': 'Solar Farm Integration',
  'cases.c2.body': '5 MWh BESS paired with a 20 MW solar farm in the Northern Cape.',
  'cases.c3.title': 'Residential Community',
  'cases.c3.body': '500+ home storage systems installed across Bavaria with remote monitoring.',
  // testimonials
  'testimonials.title': 'What Customers Say',
  'testimonials.t1.quote':
    'Volenergy BESS has been rock-solid through two winters of peak demand. Their engineering team is responsive and detail-oriented.',
  'testimonials.t1.author': 'Project Manager',
  'testimonials.t1.role': 'Wien Energie',
  'testimonials.t2.quote':
    'Best price-to-performance ratio we found across eight suppliers. On-time delivery and full certification documentation.',
  'testimonials.t2.author': 'Procurement Lead',
  'testimonials.t2.role': 'Solar Distributor, Germany',
  // about
  'about.title': 'About Volenergy',
  'about.body':
    'Founded in 2015, Volenergy designs and manufactures lithium battery energy storage systems for commercial, industrial, and residential applications. From our 20,000m² facility in Shenzhen, we ship to 30+ countries with full ISO 9001, CE, UN38.3, and IEC 62619 certification.',
  // process
  'process.title': 'How We Work',
  'process.s1.title': 'Consultation & Sizing',
  'process.s1.body': 'Share your load profile and our engineers size the right system for your application.',
  'process.s2.title': 'Manufacturing & QC',
  'process.s2.body': 'Cells assembled and tested against IEC 62619 in our Shenzhen facility.',
  'process.s3.title': 'Export & Commissioning',
  'process.s3.body': 'UN38.3-certified shipping, on-site commissioning, and remote monitoring.',
  // regions
  'regions.title': 'Our Export Markets',
  'region.DE': 'Germany',
  'region.US': 'United States',
  'region.AU': 'Australia',
  'region.ZA': 'South Africa',
  // news
  'news.title': 'Newsroom',
  'news.n1.title': 'Volenergy to Exhibit at Intersolar Europe 2025 in Munich',
  'news.n1.date': 'Jun 17, 2025',
  'news.n2.title': 'New C&I BESS Series Launches with Liquid Cooling',
  'news.n2.date': 'Mar 4, 2025',
  'news.n3.title': 'Volenergy Signs 12.5 MWh Deal with Wien Energie',
  'news.n3.date': 'Nov 20, 2024',
  // faq
  'faq.title': 'Frequently Asked Questions',
  'faq.q1': 'What certifications do your batteries carry?',
  'faq.a1': 'ISO 9001, CE, UN38.3, and IEC 62619. Test reports are provided with every shipment.',
  'faq.q2': 'What is your MOQ?',
  'faq.a2': 'MOQ is 1 rack for sampling; volume pricing applies from 10 units.',
  'faq.q3': 'Do you offer OEM/ODM?',
  'faq.a3': 'Yes, full OEM/ODM including custom BMS, enclosure, and branding.',
  // cta
  'cta.headline': 'Ready to spec your storage project?',
  'cta.label': 'Get in touch',
  // about page
  'about.header.title': 'About Volenergy',
  'about.header.sub': 'Energy storage, engineered for export.',
  'history.title': 'Our Journey',
  'history.m1.title': 'Founded in Shenzhen',
  'history.m1.body': 'Started lithium battery pack assembly for telecom backup.',
  'history.m2.title': 'ISO 9001 Certified',
  'history.m2.body': 'Quality management system established; entered EU market.',
  'history.m3.title': '1 GWh Capacity',
  'history.m3.body': 'Opened automated cell assembly line; launched C&I BESS series.',
  'history.m4.title': '2 GWh & Global',
  'history.m4.body': 'Expanded to Australia and South Africa; 30+ export markets.',
  'team.title': 'Leadership',
  'team.m1.name': 'Daniel Chen',
  'team.m1.role': 'Founder & CEO',
  'team.m2.name': 'Sarah Liu',
  'team.m2.role': 'Chief Technology Officer',
  'team.m3.name': 'Mark Wang',
  'team.m3.role': 'Head of Engineering',
  'team.m4.name': 'Emma Zhao',
  'team.m4.role': 'Sales Director',
  // contact
  'contact.header.title': 'Contact Us',
  'contact.header.sub': 'Send us your requirements and our team will reply with a tailored proposal.',
  'inquiry.title': 'Send an Inquiry',
  'inquiry.sub': 'We reply as soon as possible.',
  'inquiry.field.name': 'Your name',
  'inquiry.field.email': 'Work email',
  'inquiry.field.message': 'Tell us about your requirements',
  'inquiry.submit': 'Send inquiry',
  'inquiry.m0.note': 'The inquiry form goes live when your site is published.',
};

const productCards = [
  { nameKey: 'products.p1.name', blurbKey: 'products.p1.blurb', image: { src: IMG('product-cni') } },
  { nameKey: 'products.p2.name', blurbKey: 'products.p2.blurb', image: { src: IMG('product-res') } },
  { nameKey: 'products.p3.name', blurbKey: 'products.p3.blurb', image: { src: IMG('product-rack') } },
];

const doc = {
  specVersion: DEMO_SPEC_VERSION,
  site: {
    defaultLocale: 'en',
    locales: ['en'],
    theme: { preset: 'industrial-tecloman' },
    nav: [
      { labelKey: 'nav.home', pageId: 'home' },
      { labelKey: 'nav.products', pageId: 'products' },
      { labelKey: 'nav.about', pageId: 'about' },
      { labelKey: 'nav.contact', pageId: 'contact' },
    ],
    seoGlobal: { siteName: 'Volenergy' },
  },
  pages: [
    {
      id: 'home',
      path: '/',
      seo: { titleKey: 'seo.home.title', descriptionKey: 'seo.home.desc' },
      puck: {
        root: { props: {} },
        content: [
          { type: 'HeroBanner', props: { id: 'Hero-1', headlineKey: 'home.hero.headline', subheadKey: 'home.hero.subhead', cta: { labelKey: 'home.hero.cta', pageId: 'contact' } } },
          { type: 'TrustBar', props: { id: 'Trust-1', titleKey: 'trust.title', logos: [{ labelKey: 'stats.founded' }, { labelKey: 'stats.capacity' }] } },
          { type: 'StatsBand', props: { id: 'Stats-1', stats: [
            { value: '2015', labelKey: 'stats.founded' },
            { value: '20,000m²', labelKey: 'stats.area' },
            { value: '150+', labelKey: 'stats.staff' },
            { value: '2GWh', labelKey: 'stats.capacity' },
          ] } },
          { type: 'ProductGrid', props: { id: 'PG-1', titleKey: 'products.title', products: productCards } },
          { type: 'FactoryShowcase', props: { id: 'Fac-1', titleKey: 'factory.title', bodyKey: 'factory.body', images: [
            { src: IMG('factory1') }, { src: IMG('factory2') }, { src: IMG('factory3') },
          ] } },
          { type: 'CaseStudies', props: { id: 'CS-1', titleKey: 'cases.title', cases: [
            { titleKey: 'cases.c1.title', bodyKey: 'cases.c1.body', countryCode: 'AT', image: { src: IMG('case1') } },
            { titleKey: 'cases.c2.title', bodyKey: 'cases.c2.body', countryCode: 'ZA', image: { src: IMG('case2') } },
            { titleKey: 'cases.c3.title', bodyKey: 'cases.c3.body', countryCode: 'DE', image: { src: IMG('case3') } },
          ] } },
          { type: 'Testimonials', props: { id: 'Tm-1', titleKey: 'testimonials.title', items: [
            { quoteKey: 'testimonials.t1.quote', authorKey: 'testimonials.t1.author', roleKey: 'testimonials.t1.role' },
            { quoteKey: 'testimonials.t2.quote', authorKey: 'testimonials.t2.author', roleKey: 'testimonials.t2.role' },
          ] } },
          { type: 'AboutBlock', props: { id: 'Ab-1', titleKey: 'about.title', bodyKey: 'about.body' } },
          { type: 'ProcessTimeline', props: { id: 'Pt-1', titleKey: 'process.title', steps: [
            { titleKey: 'process.s1.title', bodyKey: 'process.s1.body' },
            { titleKey: 'process.s2.title', bodyKey: 'process.s2.body' },
            { titleKey: 'process.s3.title', bodyKey: 'process.s3.body' },
          ] } },
          { type: 'RegionsGrid', props: { id: 'Rg-1', titleKey: 'regions.title', regions: [
            { code: 'DE', nameKey: 'region.DE' }, { code: 'US', nameKey: 'region.US' },
            { code: 'AU', nameKey: 'region.AU' }, { code: 'ZA', nameKey: 'region.ZA' },
          ] } },
          { type: 'NewsList', props: { id: 'Nl-1', titleKey: 'news.title', items: [
            { titleKey: 'news.n1.title', dateKey: 'news.n1.date' },
            { titleKey: 'news.n2.title', dateKey: 'news.n2.date' },
            { titleKey: 'news.n3.title', dateKey: 'news.n3.date' },
          ] } },
          { type: 'FaqAccordion', props: { id: 'Fq-1', titleKey: 'faq.title', items: [
            { qKey: 'faq.q1', aKey: 'faq.a1' }, { qKey: 'faq.q2', aKey: 'faq.a2' }, { qKey: 'faq.q3', aKey: 'faq.a3' },
          ] } },
          { type: 'CtaBanner', props: { id: 'Ct-1', headlineKey: 'cta.headline', cta: { labelKey: 'cta.label', pageId: 'contact' } } },
        ],
      },
    },
    {
      id: 'products',
      path: '/products',
      seo: { titleKey: 'seo.products.title', descriptionKey: 'seo.products.desc' },
      puck: { root: { props: {} }, content: [
        { type: 'PageHeader', props: { id: 'Ph-p', titleKey: 'products.header.title', subtitleKey: 'products.header.sub' } },
        { type: 'ProductGrid', props: { id: 'PG-2', titleKey: 'products.title', products: productCards } },
        { type: 'FaqAccordion', props: { id: 'Fq-2', titleKey: 'faq.title', items: [
          { qKey: 'faq.q1', aKey: 'faq.a1' }, { qKey: 'faq.q2', aKey: 'faq.a2' }, { qKey: 'faq.q3', aKey: 'faq.a3' },
        ] } },
      ] },
    },
    {
      id: 'about',
      path: '/about',
      seo: { titleKey: 'seo.about.title', descriptionKey: 'seo.about.desc' },
      puck: { root: { props: {} }, content: [
        { type: 'PageHeader', props: { id: 'Ph-a', titleKey: 'about.header.title', subtitleKey: 'about.header.sub' } },
        { type: 'HistoryTimeline', props: { id: 'Hi-1', titleKey: 'history.title', milestones: [
          { year: '2015', titleKey: 'history.m1.title', bodyKey: 'history.m1.body' },
          { year: '2018', titleKey: 'history.m2.title', bodyKey: 'history.m2.body' },
          { year: '2021', titleKey: 'history.m3.title', bodyKey: 'history.m3.body' },
          { year: '2024', titleKey: 'history.m4.title', bodyKey: 'history.m4.body' },
        ] } },
        { type: 'TeamGrid', props: { id: 'Tg-1', titleKey: 'team.title', members: [
          { nameKey: 'team.m1.name', roleKey: 'team.m1.role' },
          { nameKey: 'team.m2.name', roleKey: 'team.m2.role' },
          { nameKey: 'team.m3.name', roleKey: 'team.m3.role' },
          { nameKey: 'team.m4.name', roleKey: 'team.m4.role' },
        ] } },
        { type: 'StatsBand', props: { id: 'Stats-2', stats: [
          { value: '2015', labelKey: 'stats.founded' },
          { value: '20,000m²', labelKey: 'stats.area' },
          { value: '150+', labelKey: 'stats.staff' },
          { value: '2GWh', labelKey: 'stats.capacity' },
        ] } },
        { type: 'CtaBanner', props: { id: 'Ct-2', headlineKey: 'cta.headline', cta: { labelKey: 'cta.label', pageId: 'contact' } } },
      ] },
    },
    {
      id: 'contact',
      path: '/contact',
      seo: { titleKey: 'seo.contact.title', descriptionKey: 'seo.contact.desc' },
      puck: { root: { props: {} }, content: [
        { type: 'PageHeader', props: { id: 'Ph-c', titleKey: 'contact.header.title', subtitleKey: 'contact.header.sub' } },
        { type: 'InquiryForm', props: { id: 'If-1', titleKey: 'inquiry.title', subKey: 'inquiry.sub' } },
      ] },
    },
  ],
  assets: {},
  copyBundles: { en },
};

writeFileSync('/tmp/volenergy-spec.json', JSON.stringify(doc, null, 2), 'utf8');
console.log('Volenergy mock site spec written: /tmp/volenergy-spec.json');
console.log('pages:', doc.pages.map((p: { id: string }) => p.id).join(', '));
console.log('home sections:', doc.pages[0].puck.content.map((b: { type: string }) => b.type).join(' -> '));
