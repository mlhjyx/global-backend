import { ModelGateway } from '../../model-gateway/model-gateway';
import { executeStructuredTaskWithRuntime } from '../../model-runtime/structured-task-runtime-bridge';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import type { ExecutionContext } from '../provider-contract';

/**
 * `contact.find_decision_makers` 契约的共享抽取入口（decision_maker 官网页与 social_presence
 * 社媒工共用）。prompt 骨架、durable schema 与失败语义只有这一份——两处调用方各自从
 * task registry 取契约并传进来，页面类型由 label 区分（"企业页面文本"/"社媒公开个人页文本"）。
 */

interface ExtractedPeople {
  people?: {
    full_name?: string;
    title?: string;
    email?: string;
    phone?: string;
    department?: string;
    seniority?: string;
    buying_role?: string;
    is_target_role?: boolean;
    evidence?: string;
  }[];
}

export type ExtractedPerson = NonNullable<ExtractedPeople['people']>[number];

export interface ContactExtractionContract {
  id?: string;
  description?: string;
  model?: string;
  outputSchema?: Record<string, unknown>;
}

export interface ContactPage {
  url: string;
  text: string;
  /** 页面类型标签，进 prompt 首行（例如「企业页面文本」「社媒公开个人页文本」）。 */
  label: string;
}

export interface ContactSellerContext {
  seller?: string;
  target_roles?: string[];
  offering?: string;
}

/**
 * 「人名字段」带组织特征说明抽取把公司/机构当成了人（M5 评估：LinkedIn 的机构页
 * 曾以整条公司名入库）。词表只收「作为整个人名 token 出现就基本不可能是姓」的
 * 法律形式与机构词；`Co`（华人/荷兰姓氏）与 `ag` 不在其中，全大写 `AG` 与带点的
 * `Co.` 走单独的、区分大小写的规则。
 */
const ORGANIZATION_NAME_TOKENS = new Set([
  'gmbh','mbh','kg','ohg','ug','gbr','ek','inc','incorporated','ltd','limited',
  'plc','llc','corp','corporation','company','consulting','consultants','solutions',
  'services','systems','technologies','technology','engineering','engineers',
  'industries','institute','holding','holdings','group','gruppe','international',
  'sa','sas','sarl','bv','nv',
]);

export function looksLikeOrganizationName(name: string): boolean {
  if (!name) return false;
  // 全大写 AG / 带点的 Co. 几乎只出现在公司名里；混写的人名姓氏（Ag/Co）不误伤。
  if (/(?:^|\s)AG(?:\s|$)/u.test(name)) return true;
  if (/(?:^|\s)Co\.(?:\s|$)/u.test(name)) return true;
  return name
    .toLowerCase()
    .split(/[^a-z0-9äöüß]+/u)
    .filter(Boolean)
    .some((token) => ORGANIZATION_NAME_TOKENS.has(token));
}

/**
 * 抽取出的人名字段规范化：去掉括号注记（模型常写成 `Max Mustermann (Geschäftsführer)`
 * 或 `(MBA)`），剩余部分仍带机构特征才丢弃；清洗后至少两个词。
 */
export function cleanPersonName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const stripped = trimmed
    .replace(/[(（][^()（）]*[)）]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  const candidate = stripped || trimmed;
  if (looksLikeOrganizationName(candidate)) return null;
  if (candidate.split(/\s+/u).filter(Boolean).length < 2) return null;
  return candidate;
}

export async function extractPeopleFromPage(
  gateway: ModelGateway,
  contract: ContactExtractionContract | undefined,
  page: ContactPage,
  ctx: ExecutionContext,
  sellerContext?: ContactSellerContext,
  telemetry?: RuntimeTelemetry,
): Promise<ExtractedPerson[]> {
  const result = await executeStructuredTaskWithRuntime<ExtractedPeople>(
    gateway,
    {
      task: contract?.id ?? 'contact.find_decision_makers',
      prompt:
        `卖方/ICP 上下文（用于判断谁是目标买家角色；禁止照抄进字段）：${JSON.stringify(
          sellerContext ?? {},
        ).slice(0, 600)}\n\n` +
        `${page.label}（URL: ${page.url}）：\n${page.text}`,
      system: contract?.description,
      model: contract?.model,
      schema: contract?.outputSchema ?? { required: ['people'] },
    },
    { ...ctx, durableResultSchema: 'contact-decision-makers/v1' },
    { telemetry },
  );
  const people: ExtractedPerson[] = [];
  for (const person of result.data?.people ?? []) {
    const name = cleanPersonName(person.full_name ?? '');
    if (name === null) continue;
    people.push({ ...person, full_name: name });
  }
  return people;
}
