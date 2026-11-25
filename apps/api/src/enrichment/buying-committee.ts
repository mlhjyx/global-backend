/**
 * 「告别 info@」4 轨决策委员会穿透与领英人机协同副驾（Batch 1.3-A）：
 *
 * 100% 合法 API 与纯确定性编排（零 LinkedIn 自动爬虫 / 零自动外挂防封）：
 *  - 轨 1（sourcing）：寻源/采购决策主轨（Sourcing > Procurement > Purchasing > Buyer）；
 *  - 轨 2（technical）：技术定标旁路轨（Technical Manager / Engineering / CTO / Project Manager）；
 *  - 轨 3（executive）：老板/高管直击轨（Owner / Founder / MD / Geschäftsführer / CEO）；
 *  - 轨 4（assistant）：大公司助理/执行层破门轨（Referent der Einkaufsleitung / Buyer Specialist）。
 *
 * 通道 4 级分层（S > A > B > C）：
 *  - S 级：具名决策人 + SMTP 验真直邮；
 *  - A 级：职能部门直达箱（einkauf@ / acquisti@ / procurement@ / sales@ / tech@，严格剥离 info@）；
 *  - B 级：非邮件高转化入口（LinkedIn 3 句附言 + 触发帖钩子 / 供应商门户 / 公开商务 WhatsApp）；
 *  - C 级：info@ 仅作最后兜底，且强制切换为「3 句转交请求信（Referral-First）」。
 */
import { classifyContactEmail, type ContactEmailType } from '../discovery/contact-classifier';

export type BuyingCommitteeTrack = 'sourcing' | 'technical' | 'executive' | 'assistant' | 'other';
export type ContactChannelTier = 'S' | 'A' | 'B' | 'C';
export type LinkedInOpenerTemplate = 'common_ground' | 'differentiated_cold' | 'technical_question';

export interface BuyingCommitteeQueryPlan {
  readonly exaPeopleQuery: string;
  readonly serperXrayQueries: readonly string[];
  readonly serperTriggerQuery: string;
}

export interface TrackClassification {
  readonly track: BuyingCommitteeTrack;
  readonly priority: number;
  readonly label: string;
}

export interface ContactChannelInput {
  readonly fullName?: string | null;
  readonly title?: string | null;
  readonly email?: string | null;
  readonly emailVerificationState?: 'VALID' | 'CATCH_ALL_RISKY' | 'UNKNOWN' | 'INVALID' | null;
  readonly linkedinUrl?: string | null;
  readonly vendorPortalUrl?: string | null;
  readonly publicWhatsappUrl?: string | null;
}

export interface LinkedInNoteValidation {
  readonly ok: boolean;
  readonly charCount: number;
  readonly violations: readonly string[];
}

export interface LinkedInCoPilotPlaybook {
  readonly templates: Readonly<Record<LinkedInOpenerTemplate, string>>;
  readonly followUpRule: {
    readonly commentAfterDays: number;
    readonly switchSecondContactAfterDays: number;
    readonly firstMessageWithinHoursAfterAccept: number;
  };
  readonly pacingLimits: {
    readonly newAccountMaxPerDay: number;
    readonly agedAccountMaxPerDay: number;
    readonly maxTouchesPerPersonPerWeek: number;
  };
  readonly profileAuditChecklist: readonly string[];
}

const LOCALIZED_ROLE_KEYWORDS: Readonly<Record<string, { sourcing: string; technical: string; executive: string }>> =
  Object.freeze({
    DE: {
      sourcing: 'Einkaufsleiter OR "Strategischer Einkäufer" OR "Head of Purchasing" OR Procurement',
      technical: 'Technischer Leiter OR "Head of Engineering" OR "Product Management" OR CTO',
      executive: 'Geschäftsführer OR "Managing Director" OR Gründer OR Inhaber',
    },
    AT: {
      sourcing: 'Einkaufsleiter OR Einkauf OR Procurement OR Sourcing',
      technical: 'Technischer Leiter OR Engineering OR Projektleiter',
      executive: 'Geschäftsführer OR "Managing Director" OR Inhaber',
    },
    CH: {
      sourcing: 'Einkaufsleiter OR Procurement OR "Responsable Achats" OR Sourcing',
      technical: 'Technischer Leiter OR "Head of Engineering" OR CTO',
      executive: 'Geschäftsführer OR "Managing Director" OR CEO',
    },
    IT: {
      sourcing: '"Responsabile Acquisti" OR Buyer OR Procurement OR Sourcing',
      technical: '"Direttore Tecnico" OR "Head of Engineering" OR "Project Manager" OR "Responsabile Tecnico"',
      executive: '"Amministratore Delegato" OR CEO OR Titolare OR Founder',
    },
    ES: {
      sourcing: '"Director de Compras" OR "Gerente de Compras" OR Procurement OR Sourcing',
      technical: '"Director Técnico" OR "Jefe de Ingeniería" OR CTO',
      executive: '"Director General" OR CEO OR Fundador',
    },
    MX: {
      sourcing: '"Gerente de Compras" OR "Director de Compras" OR Sourcing OR Procurement',
      technical: '"Director Técnico" OR "Gerente de Ingeniería" OR CTO',
      executive: '"Director General" OR CEO OR Fundador',
    },
    BR: {
      sourcing: '"Gerente de Compras" OR "Coordenador de Compras" OR Suprimentos OR "Supply Chain"',
      technical: '"Diretor Técnico" OR "Gerente de Engenharia" OR CTO',
      executive: 'Diretor OR CEO OR Sócio OR Fundador',
    },
    FR: {
      sourcing: '"Responsable Achats" OR "Directeur Achats" OR Acheteur OR Sourcing',
      technical: '"Directeur Technique" OR "Responsable Ingénierie" OR CTO',
      executive: 'PDG OR "Directeur Général" OR Fondateur',
    },
    NL: {
      sourcing: '"Inkoopmanager" OR Procurement OR Sourcing OR Buyer',
      technical: '"Technisch Directeur" OR "Head of Engineering" OR CTO',
      executive: 'Directeur OR "Managing Director" OR Eigenaar',
    },
    PL: {
      sourcing: '"Kierownik Zakupów" OR "Dyrektor Zakupów" OR Procurement OR Sourcing',
      technical: '"Dyrektor Techniczny" OR Engineering OR CTO',
      executive: 'Prezes OR "Managing Director" OR Właściciel',
    },
    TR: {
      sourcing: '"Satın Alma Müdürü" OR Procurement OR Sourcing',
      technical: '"Teknik Müdür" OR Engineering OR CTO',
      executive: '"Genel Müdür" OR CEO OR Kurucu',
    },
    DEFAULT: {
      sourcing: '"Head of Sourcing" OR "Sourcing Manager" OR Procurement OR "Head of Purchasing" OR Buyer',
      technical: '"Technical Manager" OR "Head of Engineering" OR "Director Product Management" OR CTO',
      executive: '"Managing Director" OR Founder OR Owner OR CEO',
    },
  });

const TRACK_PATTERNS: readonly { track: BuyingCommitteeTrack; priority: number; label: string; pattern: RegExp }[] =
  Object.freeze([
    {
      track: 'sourcing',
      priority: 1,
      label: '寻源/采购主轨',
      pattern:
        /\b(?:sourcing|procurement|purchasing|buyer|category\s+manager|supply\s+chain|scm|einkauf(?:sleiter)?|strategischer\s+eink[äa]ufer|beschaffung|acquisti|compras|suprimentos|achats?|acheteur|inkoop|zakup[óo]w|sat[ıi]n\s*alma)\b/iu,
    },
    {
      track: 'technical',
      priority: 2,
      label: '技术定标旁路轨',
      pattern:
        /\b(?:technical|engineering|engineer|cto|chief\s+technology|product\s+management|project\s+manager|r&d|photovoltaic|solar\s+engineer|technischer\s+leiter|direttore\s+tecnico|responsabile\s+tecnico|ingenier[íi]a|engenharia|ing[ée]nierie|teknik)\b/iu,
    },
    {
      track: 'executive',
      priority: 3,
      label: '老板/高管直击轨',
      pattern:
        /\b(?:owner|founder|co-?founder|ceo|chief\s+executive|managing\s+director|president|gesch[äa]ftsf[üu]hrer|inhaber|gr[üu]nder|amministratore|titolare|director\s+general|diretor|directeur\s+g[ée]n[ée]ral|pdg|prezes|genel\s+m[üu]d[üu]r)\b/iu,
    },
    {
      track: 'assistant',
      priority: 4,
      label: '助理/执行层破门轨',
      pattern:
        /\b(?:referent(?:in)?\s+der\s+einkaufsleitung|executive\s+assistant|assistant|buyer\s+specialist|procurement\s+specialist|purchasing\s+coordinator|coordenador\s+de\s+compras)\b/iu,
    },
  ]);

const FUNCTIONAL_A_TIER_TYPES: ReadonlySet<ContactEmailType> = new Set([
  'procurement',
  'generic_sales',
  'management',
  'support',
  'finance',
]);

const LINKEDIN_MAX_CHARS = 280;
const LINKEDIN_PLACEHOLDER_RE = /\[[^\]]{1,40}\]|\{[^}]{1,40}\}|<[^>]{1,40}>/u;
const LINKEDIN_URL_RE = /\b(?:https?:\/\/|www\.)\S+/iu;
const LINKEDIN_SPAM_ATTACHMENT_RE = /\b(?:pdf|brochure|catalog(?:ue)?|price\s*list|quotation|quote\s+attached)\b/iu;
const LINKEDIN_ROBOTIC_OPENER_RE =
  /\b(?:i\s+would\s+like\s+to\s+introduce|hope\s+this\s+(?:message|email)\s+finds\s+you\s+well|dear\s+sir\s*\/?\s*madam|we\s+are\s+a\s+leading\s+manufacturer)\b/iu;

function quoteCompanyName(name: string): string {
  const cleaned = name.replace(/["\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return `"${cleaned}"`;
}

/** 生成 4 轨穿透查询计划：Exa People + Serper 引号精搜 X-Ray + 实时破冰触发帖雷达。 */
export function buildBuyingCommitteeQueries(input: {
  companyName: string;
  domain?: string | null;
  country?: string | null;
  industry?: string | null;
  tradeFairs?: readonly string[];
}): BuyingCommitteeQueryPlan {
  const cc = (input.country ?? '').trim().toUpperCase();
  const roles = LOCALIZED_ROLE_KEYWORDS[cc] ?? LOCALIZED_ROLE_KEYWORDS.DEFAULT!;
  const quoted = quoteCompanyName(input.companyName);
  const domainPart = input.domain ? ` ${input.domain.trim().toLowerCase()}` : '';
  const industryPart = input.industry ? ` ${input.industry.trim()}` : '';
  const fairHook = (input.tradeFairs ?? []).slice(0, 3).map((f) => `"${f.replace(/"/gu, '')}"`).join(' OR ');

  const exaPeopleQuery = `${input.companyName.trim()}${domainPart} ${roles.sourcing} ${roles.technical} ${roles.executive}`.trim();
  const serperXrayQueries = [
    `site:linkedin.com/in ${quoted} (${roles.sourcing})`,
    `site:linkedin.com/in ${quoted} (${roles.technical} OR ${roles.executive})`,
  ];
  const triggerTerms = fairHook
    ? `("hiring" OR "MW" OR "GW" OR "project" OR "tender" OR "expansion" OR ${fairHook})`
    : `("hiring" OR "MW" OR "project" OR "tender" OR "expansion" OR "new supplier")`;
  const serperTriggerQuery = `site:linkedin.com/posts ${quoted}${industryPart} ${triggerTerms}`;

  return { exaPeopleQuery, serperXrayQueries, serperTriggerQuery };
}

/** 根据目标国家生成 1 条本土化采购/决策委员会 LinkedIn X-Ray 检索串（缺国家时返回 null）。 */
export function localizedCommitteeXrayQuery(company: {
  name: string;
  domain?: string;
  country?: string;
}): string | null {
  const country = (company.country ?? '').trim().toUpperCase();
  if (!country || !company.name.trim()) return null;
  const plan = buildBuyingCommitteeQueries({
    companyName: company.name,
    domain: company.domain,
    country,
  });
  return plan.serperXrayQueries[0] ?? null;
}

/**
 * 按 4 轨决策委员会优先级排序并优先保底不同轨道各取 1 人（sourcing → technical → executive → assistant），
 * 再按轨道优先级补足剩余名额，避免有限富集预算浪费在非关键岗位或同一轨道重复联系人上。
 */
export function prioritizeBuyingCommitteeContacts<T extends { title?: string | null }>(
  contacts: readonly T[],
  limit?: number,
): T[] {
  const cap = limit === undefined ? contacts.length : Math.max(0, limit);
  if (contacts.length <= 1 || cap === 0) return contacts.slice(0, cap);
  const indexed = contacts.map((contact, idx) => ({
    contact,
    idx,
    cls: classifyBuyingCommitteeTrack(contact.title),
  }));
  indexed.sort((a, b) => a.cls.priority - b.cls.priority || a.idx - b.idx);

  const primary: typeof indexed = [];
  const rest: typeof indexed = [];
  const seenTracks = new Set<BuyingCommitteeTrack>();
  for (const item of indexed) {
    if (item.cls.track !== 'other' && !seenTracks.has(item.cls.track)) {
      seenTracks.add(item.cls.track);
      primary.push(item);
    } else {
      rest.push(item);
    }
  }
  return [...primary, ...rest].slice(0, cap).map((item) => item.contact);
}

/** 将多语种职位头衔归入 4 轨决策委员会之一。 */
export function classifyBuyingCommitteeTrack(title?: string | null): TrackClassification {
  const text = (title ?? '').trim();
  if (!text) return { track: 'other', priority: 9, label: '其他岗位' };
  // 若同时含助理/专员与采购词，优先识别欧洲大公司破门助理轨（如 Referent der Einkaufsleitung）
  if (/\b(?:referent(?:in)?\s+der\s+einkaufsleitung|executive\s+assistant)\b/iu.test(text)) {
    return { track: 'assistant', priority: 4, label: '助理/执行层破门轨' };
  }
  for (const rule of TRACK_PATTERNS) {
    if (rule.pattern.test(text)) {
      return { track: rule.track, priority: rule.priority, label: rule.label };
    }
  }
  return { track: 'other', priority: 9, label: '其他岗位' };
}

/** 按 S > A > B > C 4 级通道分层，彻底把具名直邮/部门直达箱与 info@ 剥离。 */
export function classifyContactChannelTier(input: ContactChannelInput): ContactChannelTier {
  const email = (input.email ?? '').trim().toLowerCase();
  const hasNamedPerson = Boolean((input.fullName ?? '').trim());
  const classified = email ? classifyContactEmail(email) : null;

  if (
    email &&
    hasNamedPerson &&
    input.emailVerificationState === 'VALID' &&
    (classified?.emailType === 'personal' || classified?.emailType === 'other')
  ) {
    return 'S';
  }
  if (email && classified && FUNCTIONAL_A_TIER_TYPES.has(classified.emailType)) {
    return 'A';
  }
  if (
    (input.linkedinUrl && input.linkedinUrl.trim()) ||
    (input.vendorPortalUrl && input.vendorPortalUrl.trim()) ||
    (input.publicWhatsappUrl && input.publicWhatsappUrl.trim())
  ) {
    return 'B';
  }
  return 'C';
}

/** 硬校验领英 3 句连接附言：≤280 字符、禁未替换占位符、禁外链/附件推销、禁模板化套话。 */
export function validateLinkedInConnectionNote(note: string): LinkedInNoteValidation {
  const trimmed = note.trim();
  const charCount = Array.from(trimmed).length;
  const violations: string[] = [];
  if (charCount === 0) violations.push('EMPTY_NOTE');
  if (charCount > LINKEDIN_MAX_CHARS) violations.push(`EXCEEDS_280_CHARS:${charCount}`);
  if (LINKEDIN_PLACEHOLDER_RE.test(trimmed)) violations.push('UNREPLACED_PLACEHOLDER');
  if (LINKEDIN_URL_RE.test(trimmed)) violations.push('CONTAINS_URL');
  if (LINKEDIN_SPAM_ATTACHMENT_RE.test(trimmed)) violations.push('CONTAINS_ATTACHMENT_OR_PRICE_PITCH');
  if (LINKEDIN_ROBOTIC_OPENER_RE.test(trimmed)) violations.push('ROBOTIC_OPENER');
  return { ok: violations.length === 0, charCount, violations };
}

function clipLinkedInNote(text: string): string {
  const compact = text.replace(/\s+/gu, ' ').trim();
  const chars = Array.from(compact);
  if (chars.length <= LINKEDIN_MAX_CHARS) return compact;
  return `${chars.slice(0, LINKEDIN_MAX_CHARS - 1).join('').trimEnd()}…`;
}

/** 生成人机协同领英副驾剧本（3 套开场模板 + 三次法则 + 账号安全限速 + 5 项主页体检）。 */
export function buildLinkedInCoPilotPlaybook(input: {
  firstName: string;
  companyName: string;
  sellerValueProp: string;
  commonGroundHook?: string | null;
  technicalQuestion?: string | null;
}): LinkedInCoPilotPlaybook {
  const first = input.firstName.trim() || 'there';
  const company = input.companyName.trim();
  const prop = input.sellerValueProp.trim();
  const hook =
    (input.commonGroundHook ?? '').trim() || `your recent projects at ${company}`;
  const techQ =
    (input.technicalQuestion ?? '').trim() ||
    `how ${company} currently evaluates new backup suppliers on technical specs and delivery stability?`;

  return {
    templates: {
      common_ground: clipLinkedInNote(
        `Hi ${first}, saw ${hook}. We manufacture directly in-house (${prop}). Would a brief technical exchange be useful?`,
      ),
      differentiated_cold: clipLinkedInNote(
        `Hi ${first}, noticed ${company}'s market focus. As a factory-direct team (${prop}), we help European & global buyers add a resilient second source. Open to connecting?`,
      ),
      technical_question: clipLinkedInNote(
        `Hi ${first}, quick technical question on ${techQ} We build ${prop} in-house — happy to swap notes if relevant.`,
      ),
    },
    followUpRule: {
      commentAfterDays: 7,
      switchSecondContactAfterDays: 7,
      firstMessageWithinHoursAfterAccept: 48,
    },
    pacingLimits: {
      newAccountMaxPerDay: 15,
      agedAccountMaxPerDay: 25,
      maxTouchesPerPersonPerWeek: 1,
    },
    profileAuditChecklist: [
      '真人专业商务头像（非公司 Logo 或卡通图）',
      'Headline 写清能为买家解决的具体产能/规格问题，而非仅写 Sales Manager',
      'About 首段用英文写清核心认证、产能、交期与出口市场',
      'Featured 置顶 1 份认证清单或工厂实拍图集（不放硬广报价单）',
      '近 30 天有 ≥2 条行业技术/展会真实原创或转发动态',
    ],
  };
}

/** C 级 info@ 兜底策略改造：强制改发 3 句「转交请求信（Referral-First）」，绝不发长篇推销信。 */
export function buildReferralFirstInfoDraft(input: {
  language: string;
  buyerCompanyName: string;
  targetDepartmentLabel: string;
  sellerProductSummary: string;
  sellerLegalName: string;
}): { subject: string; body: string } {
  const lang = input.language.trim().toLowerCase().slice(0, 2);
  const dept = input.targetDepartmentLabel.trim();
  const prod = input.sellerProductSummary.trim();
  const seller = input.sellerLegalName.trim();
  const buyer = input.buyerCompanyName.trim();

  if (lang === 'de') {
    return {
      subject: `Kurze Weiterleitungsbitte – ${dept} (${buyer})`,
      body: [
        `Guten Tag,`,
        `könnten Sie diese kurze Anfrage bitte an die zuständige Person im Bereich ${dept} bei ${buyer} weiterleiten?`,
        `Wir fertigen ${prod} direkt im eigenen Werk und möchten kurz prüfen, ob ein technischer Austausch sinnvoll ist.`,
        `Vielen Dank für Ihre kurze Hilfe — ${seller}.`,
      ].join('\n\n'),
    };
  }
  if (lang === 'it') {
    return {
      subject: `Cortese richiesta di inoltro – ${dept} (${buyer})`,
      body: [
        `Buongiorno,`,
        `potrebbe gentilmente inoltrare questo breve messaggio al referente ${dept} di ${buyer}?`,
        `Produciamo direttamente ${prod} e vorremmo verificare se possa essere utile un breve confronto tecnico.`,
        `Grazie mille per la collaborazione — ${seller}.`,
      ].join('\n\n'),
    };
  }
  if (lang === 'es') {
    return {
      subject: `Breve solicitud de reenvío – ${dept} (${buyer})`,
      body: [
        `Hola,`,
        `¿podría reenviar este breve mensaje al responsable de ${dept} en ${buyer}?`,
        `Fabricamos directamente ${prod} y quisiéramos confirmar si tiene sentido un breve intercambio técnico.`,
        `Muchas gracias por su ayuda — ${seller}.`,
      ].join('\n\n'),
    };
  }
  if (lang === 'pt') {
    return {
      subject: `Breve pedido de encaminhamento – ${dept} (${buyer})`,
      body: [
        `Olá,`,
        `poderia encaminhar esta breve mensagem ao responsável por ${dept} na ${buyer}?`,
        `Fabricamos diretamente ${prod} e gostaríamos de verificar se faz sentido uma breve conversa técnica.`,
        `Muito obrigado pela ajuda — ${seller}.`,
      ].join('\n\n'),
    };
  }
  if (lang === 'fr') {
    return {
      subject: `Demande de transmission – ${dept} (${buyer})`,
      body: [
        `Bonjour,`,
        `pourriez-vous transmettre ce court message au responsable ${dept} chez ${buyer} ?`,
        `Nous fabriquons directement ${prod} et souhaitons vérifier si un bref échange technique serait pertinent.`,
        `Merci beaucoup pour votre aide — ${seller}.`,
      ].join('\n\n'),
    };
  }
  return {
    subject: `Quick routing request – ${dept} at ${buyer}`,
    body: [
      `Hello,`,
      `could you kindly point me to the right person handling ${dept} at ${buyer}?`,
      `We manufacture ${prod} directly in-house and would appreciate a brief check on whether a technical note is relevant.`,
      `Thank you for your help — ${seller}.`,
    ].join('\n\n'),
  };
}
