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
/** 与 cleanEmail 同口径的尾部归一：sales2 → sales，info-eu → info。 */
const TRAILING_DIGITS = /[._-]?\d+$/u;
const REGION_SUFFIX = /[._-](eu|us|de|uk|global|team)$/u;

export interface ContactEmailClassification {
  emailType: ContactEmailType;
  dataClass: ContactEmailDataClass;
}

function dataClassFor(type: ContactEmailType): ContactEmailDataClass {
  return type === 'personal' ? 'red' : 'amber';
}

function classification(type: ContactEmailType): ContactEmailClassification {
  return { emailType: type, dataClass: dataClassFor(type) };
}

export function classifyContactEmail(email: string): ContactEmailClassification {
  const match = EMAIL_SHAPE.exec(email.trim().toLowerCase());
  if (!match) return classification('other');
  // local-part 归一：去 +tag。
  const localPart = match[1]!.split('+')[0]!;
  // ① 整词词表（cleanEmail 口径）：sales2 / info-eu / einkauf-2 这类「职能词+数字/地区尾缀」。
  const bare = localPart.replace(TRAILING_DIGITS, '').replace(REGION_SUFFIX, '');
  const wholeWord = VOCAB_LOOKUP.get(bare);
  if (wholeWord) return classification(wholeWord);
  // ② 全段词表（info.kontakt / kontakt-vertrieb）：每段都是职能词才算职能邮箱。
  const segments = localPart.split(/[._-]+/u).filter((s) => s && !/^\d+$/u.test(s));
  const segmentTypes = segments.map((s) => VOCAB_LOOKUP.get(s));
  if (segmentTypes.length > 0 && segmentTypes.every((t) => t !== undefined)) {
    return classification(segmentTypes[0]!);
  }
  // ③ 人名形态 → personal（red）。与 cleanEmail 的保守裁决收敛：info.schmidt / vertrieb.mueller
  //    这类「职能词+人名」混合形态不冒认职能邮箱（下游 A6 若按 role 类放行会误触个人邮箱）。
  if (PERSON_NAME_SHAPE.test(localPart)) return classification('personal');
  // ④ 判不出（jdoe 这类单段词绝不冒认人名）→ other（amber）。
  return classification('other');
}
