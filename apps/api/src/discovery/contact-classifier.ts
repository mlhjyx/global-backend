/**
 * A4（2026-11-08）：联系方式分类器 v2。
 *
 * 产品口径：核心交付是「可转化的分类联系方式」——每个邮箱要能回答「这是什么邮箱」：
 * 职能/总入口（role）、销售（generic_sales）、采购（procurement）、管理层（management）、
 * 财务（finance）、客服（support）、具名个人（personal）或无法判定（other）。
 * 国家语言词表覆盖德语区优先（info/kontakt/anfrage/vertrieb/einkauf/geschaeftsfuehrung/
 * buchhaltung/service）与英/法/西/意常见入口词。
 *
 * 数据分级口径（与既有 emailDataClass 一致）：personal=red（GDPR 个人数据），
 * 其余=amber（职能邮箱 ePrivacy）。**绝不猜测**：判不出人名形态的不冒认 personal。
 * 纯函数、无 IO——分类结果随 contact_point.email_type 落库供下游筛选与合规门使用。
 */

export type ContactEmailType =
  | 'role'
  | 'generic_sales'
  | 'procurement'
  | 'management'
  | 'finance'
  | 'support'
  | 'personal'
  | 'other';

export type ContactEmailDataClass = 'amber' | 'red';

const VOCAB: Readonly<Record<Exclude<ContactEmailType, 'personal' | 'other'>, readonly string[]>> =
  Object.freeze({
    role: [
      // 德语区优先
      'info', 'kontakt', 'anfrage', 'office', 'zentrale', 'post', 'mail',
      // 英/法/西/意
      'contact', 'hello', 'hi', 'enquiries', 'enquiry', 'inquiry', 'contacto', 'contatto',
    ],
    generic_sales: [
      'vertrieb', 'sales', 'verkauf', 'commercial', 'ventas', 'ventes', 'vendite',
      'marketing',
    ],
    procurement: [
      'einkauf', 'purchasing', 'procurement', 'beschaffung', 'achat', 'compras', 'acquisti',
      'sourcing',
    ],
    management: [
      'geschaeftsfuehrung', 'geschäftsführung', 'gf', 'management', 'direction', 'direccion',
      'direzione', 'leitung', 'vorstand',
    ],
    finance: [
      'buchhaltung', 'accounting', 'billing', 'rechnung', 'rechnungen', 'finance', 'finanzen',
      'facturacion', 'comptabilite',
    ],
    support: [
      'support', 'service', 'hilfe', 'kundendienst', 'helpdesk', 'assistance', 'soporte',
      'assistenza',
    ],
  });

const VOCAB_LOOKUP: ReadonlyMap<string, ContactEmailType> = new Map(
  Object.entries(VOCAB).flatMap(([type, words]) =>
    words.map((word) => [word, type as ContactEmailType] as const),
  ),
);

/** 人名形态：两段以上以 . _ - 分隔，或 f.last 这类缩写+姓氏；单段短词不冒认。 */
const PERSON_NAME_SHAPE = /^[a-z]{1,}([._-][a-z]{1,})+$/u;
const EMAIL_SHAPE = /^([^@\s]+)@([^@\s]+\.[^@\s]+)$/u;

export interface ContactEmailClassification {
  emailType: ContactEmailType;
  dataClass: ContactEmailDataClass;
}

function dataClassFor(type: ContactEmailType): ContactEmailDataClass {
  return type === 'personal' ? 'red' : 'amber';
}

export function classifyContactEmail(email: string): ContactEmailClassification {
  const match = EMAIL_SHAPE.exec(email.trim().toLowerCase());
  if (!match) return { emailType: 'other', dataClass: dataClassFor('other') };
  // local-part 归一：去 +tag，词表按段匹配（einkauf-2 → einkauf；info.web → info? 不——多段先看词表段）。
  const localPart = match[1]!.split('+')[0]!;
  const segments = localPart.split(/[._-]+/u).filter(Boolean);
  for (const segment of segments) {
    const mapped = VOCAB_LOOKUP.get(segment);
    if (mapped) return { emailType: mapped, dataClass: dataClassFor(mapped) };
  }
  if (PERSON_NAME_SHAPE.test(localPart)) {
    return { emailType: 'personal', dataClass: dataClassFor('personal') };
  }
  return { emailType: 'other', dataClass: dataClassFor('other') };
}
