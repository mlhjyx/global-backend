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
  return result.data?.people ?? [];
}
