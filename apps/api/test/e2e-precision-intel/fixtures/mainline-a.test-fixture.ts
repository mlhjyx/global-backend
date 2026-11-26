export const MAINLINE_A_TENANT_A = "11111111-1111-4111-8111-111111111111";
export const MAINLINE_A_TENANT_B = "22222222-2222-4222-8222-222222222222";
export const MAINLINE_A_COMPANY_ID = "33333333-3333-4333-8333-333333333333";

export const KEY_ENERGY_RIMINI_HTML_MANIFEST = {
  meta: {
    name: "KEY Energy Rimini",
    version: 1,
    category: "trade_fair",
    description: "Italian renewable energy and solar PV trade fair exhibitor directory",
  },
  transport: {
    baseUrl: "https://key-energy-rimini.example",
    responseType: "html",
    allowedHosts: ["key-energy-rimini.example"],
  },
  crawl: {
    list: {
      itemSelector: ".exhibitor-card",
      url: "https://key-energy-rimini.example/exhibitors?page={page}",
      maxPages: 5,
    },
    detail: {
      enabled: false,
      fields: { name: ".company-name", website: ".website" },
    },
  },
  governance: {
    license: "public-directory",
    tosUrl: "https://key-energy-rimini.example/terms",
    robotsPolicy: "A",
    allowedPurpose: ["discovery"],
  },
} as const;

export const INTERSOLAR_EUROPE_HTML_MANIFEST = {
  meta: {
    name: "Intersolar Europe",
    version: 1,
    category: "trade_fair",
    description: "European solar PV & energy storage trade fair exhibitor catalog",
  },
  transport: {
    baseUrl: "https://intersolar-europe.example",
    responseType: "html",
    allowedHosts: ["intersolar-europe.example"],
  },
  crawl: {
    list: {
      itemSelector: ".exhibitor-item",
      url: "https://intersolar-europe.example/exhibitors?page={page}",
      maxPages: 5,
    },
    detail: {
      enabled: false,
      fields: { name: ".company-name", website: ".website", country: ".country" },
    },
  },
  governance: {
    license: "public-directory",
    tosUrl: "https://intersolar-europe.example/terms",
    robotsPolicy: "A",
    allowedPurpose: ["discovery"],
  },
} as const;

export const KEY_ENERGY_EXHIBITOR_DIRECTORY_HTML = `<!doctype html>
<html>
<body>
  <div class="exhibitor-card" data-country="IT">
    <h2 class="company-name">Italsol Srl</h2>
    <a class="website" href="https://italsol.example">italsol.example</a>
    <span class="email">info@italsol.example</span>
    <span class="category">Photovoltaic Modules</span>
  </div>
  <div class="exhibitor-card" data-country="DE">
    <h2 class="company-name">SolarBau GmbH</h2>
    <a class="website" href="https://solarbau.example">solarbau.example</a>
    <span class="email">sales@solarbau.example</span>
    <span class="category">Solar EPC</span>
  </div>
  <div class="exhibitor-card" data-country="IT">
    <h2 class="company-name">Freemail Test Exhibitor</h2>
    <a class="website" href="https://freemail-exhibitor.example">freemail-exhibitor.example</a>
    <span class="email">us***@gmail.com</span>
    <span class="category">Solar Inverters</span>
  </div>
</body>
</html>`;

export const POLLUTING_RECORDS_SPEC_ROWS = [
  { id: "rec-spec-1", name: "records-spec-polluting-channel-1", status: "ENABLED" },
  { id: "rec-spec-2", name: "records-spec-polluting-channel-2", status: "ENABLED" },
] as const;

export const ADR003_CLEAN_GREEN_FACT_INPUT = {
  domain: "italsol.example",
  homepageUrl: "https://italsol.example",
  legalName: "Italsol S.r.l.",
  country: "IT",
  tradeRole: "distributor",
  websiteSummary: "Italian solar photovoltaic modules and BESS wholesale distributor.",
  emails: ["info@italsol.example", "vendite@italsol.example"],
  phones: ["+39 045 5550100"],
  inquiryFormUrl: "https://italsol.example/contatti",
  contactPageUrl: "https://italsol.example/contatti",
  impressumUrl: "https://italsol.example/note-legali",
  linkedinCompanyUrl: "https://www.linkedin.com/company/italsol-srl",
  productCategories: ["solar modules", "inverters", "energy storage"],
  sourceKind: "public_directory",
} as const;

export const ADR003_NEGATIVE_PII_FACT = {
  domain: "acme-pii.example",
  homepageUrl: "https://acme-pii.example",
  legalName: "Acme Solar S.r.l.",
  country: "IT",
  tradeRole: "distributor",
  websiteSummary: "Solar distributor contact https://www.linkedin.com/in/mario-rossi-example",
  roleEmails: ["private.fixture@acme-pii.example"],
  switchboardPhones: [],
  inquiryFormUrl: null,
  contactPageUrl: null,
  impressumUrl: null,
  linkedinCompanyUrl: "https://www.linkedin.com/in/mario-rossi-example",
  productCategories: ["solar modules"],
  sourceKind: "public_web",
} as const;

export const REGISTRY_FIXTURES = {
  patentsCacheRow: [
    {
      publicationNumber: "EP4012345A1",
      title: "High-efficiency heterojunction solar module assembly",
      filingDate: "2024-03-15",
      applicants: [{ name: "Italsol S.r.l.", country: "IT" }],
      inventors: [{ name: "Marco Bellini", country: "IT" }],
    },
  ],
  companiesHouseSearch: {
    items: [
      {
        company_number: "99009900",
        title: "UK SOLAR IMPORTER LTD",
        company_status: "active",
        company_type: "ltd",
      },
    ],
  },
  companiesHouseOfficers: {
    items: [
      {
        name: "SMITH, Arthur James",
        officer_role: "director",
        appointed_on: "2020-01-10",
        links: { officer: { appointments: "/officers/ch-off-001/appointments" } },
      },
    ],
  },
  gleifActive: {
    records: [
      {
        lei: "5493001KJTIIGC8Y1R12",
        legalName: "SolarBau GmbH",
        legalFormId: "2HBR",
        entityStatus: "ACTIVE",
        registrationStatus: "ISSUED",
        country: "DE",
        city: "Munich",
        hasDirectParent: true,
        hasUltimateParent: false,
      },
    ],
  },
  gleifInactive: {
    records: [
      {
        lei: "5493001KJTIIGC8Y1R99",
        legalName: "Defunct Solar GmbH",
        legalFormId: "2HBR",
        entityStatus: "INACTIVE",
        registrationStatus: "LAPSED",
        country: "DE",
        city: "Berlin",
        hasDirectParent: false,
        hasUltimateParent: false,
      },
    ],
  },
  tedNotices: {
    awards: [
      {
        publicationNumber: "2026/S 045-123456",
        noticeType: "can-standard",
        title: "Supply and installation of 12MW PV solar plant",
        publicationDate: "2026-09-10",
        buyerNames: ["Comune di Verona"],
        buyerCountries: ["ITA"],
        cpvCodes: ["09331200"],
        winners: [
          {
            name: "Italsol Srl",
            country: "ITA",
            identifier: "IT01234560234",
            internetAddress: "https://italsol.example",
          },
        ],
      },
    ],
  },
  greenhouseHtml: `<div id="careers"><iframe src="https://boards.greenhouse.io/embed/job_board?for=solarbau"></iframe></div>`,
  greenhouseJobsJson: {
    jobs: [
      {
        title: "Head of Solar Procurement",
        location: { name: "Munich, Germany" },
        departments: [{ name: "Supply Chain" }],
        updated_at: "2026-10-15T09:00:00Z",
      },
    ],
  },
} as const;

export const SIGNALS_AND_DOCLING_FIXTURES = {
  changedetectionWatches: {
    "watch-uuid-1": {
      uuid: "watch-uuid-1",
      url: "https://italsol.example/news/new-pv-distribution-hub",
      title: "Italsol opens new PV distribution hub",
      last_changed: 1760000000,
    },
  },
  rssFeedXml: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Solar Buyer News</title>
    <item>
      <title>Italsol expands 50MW HJT warehouse</title>
      <link>https://italsol.example/press/50mw-hjt</link>
      <description>New wholesale stock for Italian installers.</description>
      <pubDate>Tue, 10 Nov 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`,
  unattributedRssXml: `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Industry Wire</title>
    <item>
      <title>Unrelated global solar policy note</title>
      <link>https://unrelated-wire.example/policy</link>
      <description>General EU solar tariff update.</description>
      <pubDate>Tue, 10 Nov 2026 09:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`,
  doclingBuyerCatalogResponse: {
    status: "success",
    document: {
      md_content: [
        "# Italsol S.r.l. - 2026 Solar PV Catalog",
        "Legal Representative: Alba Fixture (Amministratore)",
        "Procurement Contact: ufficio.acquisti@italsol.example",
        "VAT: IT01234560234",
        "Product Specs: HJT Bifacial 730W Modules, BESS 215kWh",
      ].join("\n"),
      json_content: { pages: [{ page_no: 1 }] },
    },
  },
  doclingTedTenderResponse: {
    status: "success",
    document: {
      md_content: [
        "# TED Tender Award 2026/S 045-123456",
        "Contracting Authority Procurement Officer: Elena Moretti",
        "Contact: procurement@italsol.example | +39 045 5550199",
      ].join("\n"),
      json_content: { pages: [{ page_no: 1 }] },
    },
  },
  syntheticPdfBytes: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF"),
  searxGreyZoneConfirm: {
    results: [
      {
        url: "https://italsol.example/team",
        title: "Giulia Bianchi - Procurement - Italsol Srl",
        content: "Giulia Bianchi leads solar PV module procurement at Italsol Srl in Verona.",
      },
    ],
    suggestions: [],
    infoboxes: [],
    number_of_results: 1,
  },
} as const;
