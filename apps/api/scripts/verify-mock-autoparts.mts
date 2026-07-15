/**
 * verify-mock-autoparts.mts -- 虚构中国汽车零部件出海企业（Velltrix）走 industrial-trumpf 模板，
 * 视频底 Hero（用户生成的 Kling 汽车零部件动态图）+ 全 mock 数据，生成高级独立站。
 * 用法：node --import tsx apps/api/scripts/verify-mock-autoparts.mts
 *   然后：SITESPEC_PATH=/tmp/velltrix-spec.json OUT_DIR=/tmp/velltrix-site BASE_PATH=/ pnpm --filter @global/site-renderer exec astro build
 *   再：cp <kling视频> /tmp/velltrix-site/video/hero.mp4 + 下载占位图到 /tmp/velltrix-site/img/
 */
import { writeFileSync } from 'node:fs';
import { DEMO_SPEC_VERSION } from '../src/site-builder/demo-spec';

const IMG = (n: string) => `/img/${n}.jpg`;

const en: Record<string, string> = {
  'nav.home': 'Home',
  'nav.products': 'Products',
  'nav.about': 'About',
  'nav.contact': 'Contact',
  'footer.tagline': 'Precision automotive components. IATF 16949 certified. Tier-1 supplier to global OEMs.',
  'seo.home.title': 'Velltrix - Precision Auto Parts Manufacturer | IATF 16949',
  'seo.home.desc': 'Velltrix manufactures CNC machined, transmission, brake, and stamping auto parts for global OEMs and Tier-1s.',
  'seo.products.title': 'Automotive Components - Velltrix',
  'seo.products.desc': 'CNC, transmission, brake, and stamping assemblies from an IATF 16949 certified manufacturer.',
  'seo.about.title': 'About Velltrix - Auto Parts Manufacturing Since 2008',
  'seo.about.desc': 'Velltrix is an IATF 16949 certified automotive components manufacturer in Ningbo, China.',
  'seo.contact.title': 'Contact Velltrix',
  'seo.contact.desc': 'Send us your RFQ. Our engineering team responds with a full PPAP-ready proposal.',
  // hero
  'home.hero.headline': 'Precision Auto Parts, Engineered for Global OEMs',
  'home.hero.subhead':
    'IATF 16949 certified manufacturer of CNC, transmission, brake, and stamping components. 5 million parts a year, zero-PPM culture, JIT delivery to Tier-1s worldwide.',
  'home.hero.cta': 'Request a Quote',
  // trust
  'trust.title': 'Trusted by Tier-1 suppliers and global OEMs',
  // stats
  'stats.founded': 'Founded',
  'stats.area': 'Manufacturing Base',
  'stats.staff': 'Engineers & Staff',
  'stats.capacity': 'Parts / Year',
  // products
  'products.title': 'Our Products',
  'products.header.title': 'Automotive Components',
  'products.header.sub': 'Precision parts for powertrain, brake, and body systems.',
  'products.p1.name': 'CNC Machined Components',
  'products.p1.blurb': 'Engine and transmission housings, shafts, and flanges. 5-axis machining, ±0.01mm tolerance.',
  'products.p2.name': 'Transmission Parts',
  'products.p2.blurb': 'Gears, shafts, and synchronizers. Hobbing, grinding, and heat-treatment in-house.',
  'products.p3.name': 'Brake System Components',
  'products.p3.blurb': 'Caliper brackets, mounting hardware, and discs. High-strength ductile iron.',
  'products.p4.name': 'Stamping & Welding Assemblies',
  'products.p4.blurb': 'Body-in-white and structural stampings. Robotic MIG/MAG welding cells.',
  // factory
  'factory.title': 'Our Manufacturing Base',
  'factory.body':
    '35,000m² IATF 16949 certified facility in Ningbo with 5-axis CNC, robotic welding, in-house metrology lab, and full SPC traceability.',
  // cases
  'cases.title': 'Customer Success Stories',
  'cases.c1.title': 'European EV Transmission Program',
  'cases.c1.body': '500k transmission housings per year for a European EV manufacturer, hitting 3 PPM from SOP.',
  'cases.c2.title': 'North American Brake Bracket',
  'cases.c2.body': 'Caliper brackets for a US OEM program, zero PPM across 2 million shipped units.',
  'cases.c3.title': 'Japanese Precision Shaft Supply',
  'cases.c3.body': 'Transmission shafts delivered JIT to a Japanese Tier-1, PPAP Level 3 approved.',
  // testimonials
  'testimonials.title': 'What Customers Say',
  'testimonials.t1.quote':
    'Velltrix hit PPM targets from week one of SOP. Their PPAP documentation is the cleanest we have received from any Asian supplier.',
  'testimonials.t1.author': 'Supplier Quality Engineer',
  'testimonials.t1.role': 'European EV OEM',
  'testimonials.t2.quote':
    'Zero defects across 2 million parts over 18 months. A genuine Tier-2 partner we trust with our most critical programs.',
  'testimonials.t2.author': 'Procurement Manager',
  'testimonials.t2.role': 'Japanese Tier-1',
  // about
  'about.title': 'About Velltrix',
  'about.body':
    'Founded in 2008, Velltrix manufactures precision automotive components for powertrain, brake, and body systems. From our 35,000m² IATF 16949 certified facility in Ningbo, we ship 5 million parts a year to OEMs and Tier-1 suppliers across Germany, the United States, Japan, and Mexico.',
  // process
  'process.title': 'How We Work',
  'process.s1.title': 'Tooling & PPAP',
  'process.s1.body': 'APQP-driven tooling design and PPAP Level 3 submission before any production run.',
  'process.s2.title': 'Production & SPC',
  'process.s2.body': 'Statistical process control on every critical dimension, full metrology and traceability.',
  'process.s3.title': 'JIT Delivery',
  'process.s3.body': 'Kanban replenishment and JIT delivery to your assembly line, with sequenced shipping.',
  // regions
  'regions.title': 'Our Export Markets',
  'region.DE': 'Germany',
  'region.US': 'United States',
  'region.JP': 'Japan',
  'region.MX': 'Mexico',
  // news
  'news.title': 'Newsroom',
  'news.n1.title': 'Velltrix Passes IATF 16949 Surveillance Audit with Zero Nonconformities',
  'news.n1.date': 'Sep 10, 2025',
  'news.n2.title': 'New 5-Axis CNC Machining Cell Commissioned',
  'news.n2.date': 'May 22, 2025',
  'news.n3.title': 'Velltrix to Exhibit at Automechanika Shanghai 2025',
  'news.n3.date': 'Nov 26, 2024',
  // faq
  'faq.title': 'Frequently Asked Questions',
  'faq.q1': 'Are you IATF 16949 certified?',
  'faq.a1': 'Yes. IATF 16949 and ISO 9001 certified, with annual surveillance audits.',
  'faq.q2': 'Do you support PPAP and APQP?',
  'faq.a2': 'Full APQP and PPAP Level 3 support, including all required documents and dimensional layouts.',
  'faq.q3': 'What is your MOQ and lead time?',
  'faq.a3': 'MOQ is flexible for sampling; production lead time is typically 4-8 weeks depending on tooling.',
  // cta
  'cta.headline': 'Have an RFQ? Let our engineers quote it.',
  'cta.label': 'Get in touch',
  // about page
  'about.header.title': 'About Velltrix',
  'about.header.sub': 'Precision automotive components, built for global programs.',
  'history.title': 'Our Journey',
  'history.m1.title': 'Founded in Ningbo',
  'history.m1.body': 'Started CNC machining of automotive shafts and flanges.',
  'history.m2.title': 'IATF 16949 Certified',
  'history.m2.body': 'Achieved IATF 16949 certification; entered the German market.',
  'history.m3.title': 'European EV Program',
  'history.m3.body': 'Awarded transmission housing program by a European EV OEM.',
  'history.m4.title': '5M Parts / Year',
  'history.m4.body': 'Expanded to 35,000m²; reached 5 million parts annual capacity.',
  'team.title': 'Leadership',
  'team.m1.name': 'Kevin Lin',
  'team.m1.role': 'Founder & CEO',
  'team.m2.name': 'Grace Zhou',
  'team.m2.role': 'Chief Technology Officer',
  'team.m3.name': 'David Sun',
  'team.m3.role': 'Head of Quality',
  'team.m4.name': 'Lily Yang',
  'team.m4.role': 'Sales Director',
  // contact
  'contact.header.title': 'Contact Us',
  'contact.header.sub': 'Send us your RFQ and our engineering team will respond with a PPAP-ready proposal.',
  'inquiry.title': 'Send an Inquiry',
  'inquiry.sub': 'We reply as soon as possible.',
  'inquiry.field.name': 'Your name',
  'inquiry.field.email': 'Work email',
  'inquiry.field.message': 'Tell us about your requirements',
  'inquiry.submit': 'Send inquiry',
  'inquiry.m0.note': 'The inquiry form goes live when your site is published.',
};

const productCards = [
  { nameKey: 'products.p1.name', blurbKey: 'products.p1.blurb', image: { src: IMG('product-cnc') } },
  { nameKey: 'products.p2.name', blurbKey: 'products.p2.blurb', image: { src: IMG('product-transmission') } },
  { nameKey: 'products.p3.name', blurbKey: 'products.p3.blurb', image: { src: IMG('product-brake') } },
  { nameKey: 'products.p4.name', blurbKey: 'products.p4.blurb', image: { src: IMG('product-stamp') } },
];

const doc = {
  specVersion: DEMO_SPEC_VERSION,
  site: {
    defaultLocale: 'en',
    locales: ['en'],
    theme: { preset: 'industrial-trumpf' },
    nav: [
      { labelKey: 'nav.home', pageId: 'home' },
      { labelKey: 'nav.products', pageId: 'products' },
      { labelKey: 'nav.about', pageId: 'about' },
      { labelKey: 'nav.contact', pageId: 'contact' },
    ],
    seoGlobal: { siteName: 'Velltrix' },
  },
  pages: [
    {
      id: 'home',
      path: '/',
      seo: { titleKey: 'seo.home.title', descriptionKey: 'seo.home.desc' },
      puck: {
        root: { props: {} },
        content: [
          { type: 'HeroBanner', props: { id: 'Hero-1', headlineKey: 'home.hero.headline', subheadKey: 'home.hero.subhead', cta: { labelKey: 'home.hero.cta', pageId: 'contact' }, bgVideo: { src: '/video/hero.mp4' } } },
          { type: 'TrustBar', props: { id: 'Trust-1', titleKey: 'trust.title', logos: [{ labelKey: 'stats.founded' }, { labelKey: 'stats.capacity' }] } },
          { type: 'StatsBand', props: { id: 'Stats-1', stats: [
            { value: '2008', labelKey: 'stats.founded' },
            { value: '35,000m²', labelKey: 'stats.area' },
            { value: '320+', labelKey: 'stats.staff' },
            { value: '5M', labelKey: 'stats.capacity' },
          ] } },
          { type: 'ProductGrid', props: { id: 'PG-1', titleKey: 'products.title', products: productCards } },
          { type: 'FactoryShowcase', props: { id: 'Fac-1', titleKey: 'factory.title', bodyKey: 'factory.body', images: [
            { src: IMG('factory1') }, { src: IMG('factory2') }, { src: IMG('factory3') },
          ] } },
          { type: 'CaseStudies', props: { id: 'CS-1', titleKey: 'cases.title', cases: [
            { titleKey: 'cases.c1.title', bodyKey: 'cases.c1.body', countryCode: 'DE', image: { src: IMG('case1') } },
            { titleKey: 'cases.c2.title', bodyKey: 'cases.c2.body', countryCode: 'US', image: { src: IMG('case2') } },
            { titleKey: 'cases.c3.title', bodyKey: 'cases.c3.body', countryCode: 'JP', image: { src: IMG('case3') } },
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
            { code: 'JP', nameKey: 'region.JP' }, { code: 'MX', nameKey: 'region.MX' },
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
          { year: '2008', titleKey: 'history.m1.title', bodyKey: 'history.m1.body' },
          { year: '2012', titleKey: 'history.m2.title', bodyKey: 'history.m2.body' },
          { year: '2018', titleKey: 'history.m3.title', bodyKey: 'history.m3.body' },
          { year: '2023', titleKey: 'history.m4.title', bodyKey: 'history.m4.body' },
        ] } },
        { type: 'TeamGrid', props: { id: 'Tg-1', titleKey: 'team.title', members: [
          { nameKey: 'team.m1.name', roleKey: 'team.m1.role' },
          { nameKey: 'team.m2.name', roleKey: 'team.m2.role' },
          { nameKey: 'team.m3.name', roleKey: 'team.m3.role' },
          { nameKey: 'team.m4.name', roleKey: 'team.m4.role' },
        ] } },
        { type: 'StatsBand', props: { id: 'Stats-2', stats: [
          { value: '2008', labelKey: 'stats.founded' },
          { value: '35,000m²', labelKey: 'stats.area' },
          { value: '320+', labelKey: 'stats.staff' },
          { value: '5M', labelKey: 'stats.capacity' },
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

writeFileSync('/tmp/velltrix-spec.json', JSON.stringify(doc, null, 2), 'utf8');
console.log('Velltrix auto-parts mock site spec written: /tmp/velltrix-spec.json');
console.log('preset: industrial-trumpf | hero: video');
console.log('pages:', doc.pages.map((p: { id: string }) => p.id).join(', '));
