export const PILOT_WORKSPACE_ID = "51000000-0000-4000-8000-000000000001";
export const PILOT_ICP_ID = "51000000-0000-4000-8000-000000000002";
export const PILOT_SELLER_PROFILE_ID = "51000000-0000-4000-8000-000000000003";
export const PILOT_IMAC_COMPANY_ID = "51000000-0000-4000-8000-000000000004";
export const PILOT_ITALSOL_COMPANY_ID = "11111111-aaaa-4111-8111-111111111101";
export const PILOT_EFFE_COMPANY_ID = "22222222-bbbb-4222-8222-222222222202";

export const PILOT_REDACTED_DIRTY_EMAIL = "11***@qq.com";
export const PILOT_CONSUMER_EMAIL_SAMPLES = [
  "11***@qq.com",
  "te***@163.com",
  "us***@gmail.com",
] as const;

export const PILOT_LIVE_OFFERINGS = [
  { name: "G12-0BB天王星Pro 730-765W", description: null, attributes: null },
  { name: "G12-0BB金星PRO 530-565W", description: null, attributes: null },
  { name: "高效异质结（HJT）组件", description: null, attributes: null },
  { name: "异质结（HJT）电池片", description: null, attributes: null },
  { name: "异质结光伏瓦 / BIPV光伏建材", description: null, attributes: null },
  { name: "琏升G12-0BB太阳能芯片", description: null, attributes: null },
  { name: "天王星PRO / 金星PRO异质结组件", description: null, attributes: null },
  { name: "储能微电网系统 / 光储解决方案", description: null, attributes: null },
] as const;

export const PILOT_SELLER_CLEAN_PROFILE = {
  id: PILOT_SELLER_PROFILE_ID,
  name: "Lianstech PV",
  website: "https://lianstech.example",
  summary: "High-efficiency HJT solar module and cell manufacturer",
  industry: "Solar Photovoltaics",
  businessEmail: "export@lianstech.example",
  publicContacts: [
    { type: "email", value: "export@lianstech.example" },
    { type: "whatsapp", value: "+12025550142" },
  ],
} as const;

export const WAVE1_SOCIAL_FIXTURES = {
  italsolCompany: {
    name: "Italsol Srl",
    domain: "italsol.example",
    country: "IT",
    city: "Verona",
    industryKeywords: ["fotovoltaico", "solar", "pv"],
  },
  italsolDirectorHit: {
    url: "https://www.linkedin.com/in/albafixtureitalsol",
    title: "Alba Fixture - Amministratore - Italsol Srl | LinkedIn",
    snippet: "Amministratore presso Italsol Srl, impianti fotovoltaici e distribuzione solare.",
    highlights: ["Amministratore presso Italsol Srl - settore fotovoltaico"],
  },
  effeCompany: {
    name: "Effe Energy Srl",
    domain: "effe-energy.example",
    country: "IT",
    city: "Brescia",
    industryKeywords: ["solar", "energy", "pv"],
  },
  effeDirectorHit: {
    url: "https://www.linkedin.com/in/bruno-fixture-00000000",
    title: "Bruno Fixture - Managing Director - effe energy srl | LinkedIn",
    snippet: "Managing Director at effe energy srl in Brescia, Italy. Solar energy distributor.",
    highlights: ["effe energy srl - Brescia - Solar Energy"],
  },
  namesakeDifferentEmployerHit: {
    url: "https://www.linkedin.com/in/mrossi-unrelated",
    title: "Marco Rossi - Sales Director - OtherValves Srl | LinkedIn",
    snippet: "Industrial valves sales director at OtherValves Srl in Milan.",
    highlights: ["Sales Director at OtherValves Srl"],
  },
  formerEmployeeHit: {
    url: "https://www.linkedin.com/in/luca-verdi-former",
    title: "Luca Verdi - Procurement Manager - UnrelatedCorp | LinkedIn",
    snippet: "Ex-Italsol Srl (2019-2021). Currently Procurement Manager at UnrelatedCorp.",
    highlights: ["Former Italsol Srl 2019-2021"],
  },
  genericTokenOnlyHit: {
    url: "https://www.linkedin.com/in/john-smith-energy",
    title: "John Smith - Energy Consultant - Energy Group | LinkedIn",
    snippet: "Independent energy consultant working across Srl groups.",
    highlights: ["Energy Consultant"],
  },
  greyZoneHit: {
    url: "https://www.linkedin.com/in/giulia-bianchi-pv",
    title: "Giulia Bianchi - Buyer - Solar Distribution | LinkedIn",
    snippet: "Solar procurement specialist in Verona working on PV module sourcing.",
    highlights: ["Solar procurement in Verona"],
  },
} as const;

export const WAVE1_STATUTORY_HTML_FIXTURES = {
  deImpressumUtf8: `<!doctype html><html lang="de"><body><main><h1>Impressum</h1><p>SolarBau GmbH</p><p>Vertreten durch den Geschäftsführer: Hans Müller</p><p>Kontakt: info@solarbau.example</p></main></body></html>`,
  deImpressumLatin1: Buffer.from(
    `<!doctype html><html><body><p>Impressum</p><p>Geschäftsführer: Hans Müller</p></body></html>`,
    "latin1",
  ),
  itInformativaPrivacy: `<!doctype html><html lang="it"><body><main><h1>Informativa Privacy</h1><p>Italsol S.r.l.</p></main><footer><p>Titolare del trattamento: Italsol S.r.l.</p><p>Legale Rappresentante: Mario Fixture</p></footer></body></html>`,
  frMentionsLegales: `<!doctype html><html lang="fr"><body><section><h1>Mentions Légales</h1><p>Directeur Général: Claire Dupont</p></section></body></html>`,
  jpGaiyou: `<!doctype html><html lang="ja"><body><section><h1>会社概要</h1><table><tr><th>代表取締役</th><td>山田太郎</td></tr></table></section></body></html>`,
  krFooter: `<!doctype html><html lang="ko"><body><main><p>Solar Korea Co.</p></main><footer><p>대표자: 김철수 | 사업자등록번호 123-45-67890</p></footer></body></html>`,
  nonPersonNoise: `<!doctype html><html><body><footer><p>Cookie Policy | Privacy Officer</p></footer></body></html>`,
} as const;

export const WAVE1_DNS_FIXTURES = {
  googleWorkspace: {
    mx: [{ exchange: "aspmx.l.google.com", priority: 1 }],
    txt: [["v=spf1 include:_spf.google.com ~all"], ["v=DMARC1; p=none;"]],
  },
  microsoft365: {
    mx: [{ exchange: "acme-example.mail.protection.outlook.com", priority: 0 }],
    txt: [["v=spf1 include:spf.protection.outlook.com -all"], ["MS=ms12345678"]],
  },
  mimecastSeg: {
    mx: [{ exchange: "eu-smtp-inbound-1.mimecast.com", priority: 10 }],
    txt: [["v=spf1 include:eu._netblocks.mimecast.com ~all"]],
  },
  hubspotSalesforceSpf: {
    mx: [{ exchange: "aspmx.l.google.com", priority: 1 }],
    txt: [
      ["v=spf1 include:_spf.google.com include:hubspotemail.net include:_spf.salesforce.com ~all"],
      ["v=DMARC1; p=reject; rua=mailto:dmarc@acme.example"],
    ],
  },
  parkedNoMail: {
    mx: [],
    txt: [["v=spf1 -all"]],
  },
} as const;

export const WAVE1_IMAC_ENERGY_FIXTURE = {
  id: PILOT_IMAC_COMPANY_ID,
  name: "IMAC Energy Srl",
  domain: "imac-srl.example",
  country: "IT",
  industry: "Industrial Valves & Fluid Control",
  fitVerdict: "weak" as const,
  totalScore: 0.38,
  antiEvidence: ["industrial_valve_distributor", "non_pv_b2b_equipment"],
} as const;
