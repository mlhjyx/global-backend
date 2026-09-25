import { getTask } from '../../ai-tasks/task-registry';
import { extractSameSiteLinks } from '../../adapters/site-links';
import type { CrawlResult } from '../../adapters/web-crawler';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import type { ModelGateway } from '../../model-gateway/model-gateway';
import { executeStructuredTaskWithRuntime } from '../../model-runtime/structured-task-runtime-bridge';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import { artifactSubjectSkipReason } from '../../tools/artifact-subject-denial';
import type { ArtifactSubjectRef } from '../../tools/artifact-execution-port';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import type { ExecutionContext } from '../provider-contract';
import { matchCarriedBrands } from '../website-profile/brands';
import { parseImpressum, type ImpressumRegister } from '../website-profile/impressum';
import { classifyTradeRoleByRules } from '../website-profile/trade-role-rules';

export const WEBSITE_PROFILE_TASK = 'discovery.classify_trade_role' as const;
export const WEBSITE_PROFILE_MAX_FETCHES_PER_COMPANY = 2;
const HOME_PROMPT_CHARS = 12_000;
const IMPRESSUM_PROMPT_CHARS = 4_000;
const RULES_CONFIDENCE = 0.7;
const IMPRESSUM_LINK = /impressum|imprint|legal-notice|legal_notice/iu;

export type WebsiteTradeRole =
  | 'distributor' | 'wholesaler' | 'manufacturer' | 'mixed' | 'service' | 'other';

/** Company-level website facts only: no person names, emails or phones. */
export interface WebsiteProfile {
  readonly homepageUrl: string;
  readonly impressumUrl: string | null;
  readonly tradeRole: WebsiteTradeRole | null;
  readonly tradeRoleSource: 'rules' | 'model' | null;
  readonly tradeRoleConfidence: number | null;
  readonly ownManufacturing: boolean | null;
  readonly carriedBrands: readonly { readonly name: string; readonly country: string | null }[];
  readonly carriesChineseBrand: boolean;
  readonly carriesForeignBrand: boolean;
  readonly legalName: string | null;
  readonly register: ImpressumRegister | null;
  readonly vatId: string | null;
  readonly evidence: readonly string[];
}

interface ClassifiedRole {
  readonly trade_role: WebsiteTradeRole;
  readonly confidence?: number;
  readonly own_manufacturing?: boolean;
  readonly carried_brands?: string[];
  readonly evidence?: string[];
}

export interface WebsiteProfileInput {
  readonly domain: string;
  /** ISO-3166 alpha-2 target market, lower case (home brands are not foreign). */
  readonly homeCountry: string;
  /** ICP product/industry context for the model; never copied into output. */
  readonly icpContext: string;
}

/**
 * G3 5.4 website-profile enrichment for one already materialized company:
 * both fetches are bound to that company (ToolBroker per-call subject
 * binding), rules decide clear cases and the model only the rest.
 * Prohibition-class denials propagate so the caller can skip the company.
 */
export class WebsiteProfileProvider {
  constructor(private readonly deps: {
    gateway: ModelGateway;
    broker: ExecutionBroker;
    runtimeTelemetry?: RuntimeTelemetry;
  }) {}

  async profile(
    input: WebsiteProfileInput,
    ctx: ExecutionContext & { artifactSubject: ArtifactSubjectRef },
  ): Promise<WebsiteProfile | null> {
    const homepageUrl = `https://${input.domain}/`;
    const home = await this.fetch(homepageUrl, ctx);
    if (!home.trim()) return null; // robots-blocked or empty: nothing truthful to profile

    const impressumUrl =
      extractSameSiteLinks(home, homepageUrl).find((link) => IMPRESSUM_LINK.test(link)) ??
      `${homepageUrl}impressum`;
    let impressum = '';
    try {
      impressum = await this.fetch(impressumUrl, ctx);
    } catch (error) {
      if (artifactSubjectSkipReason(error) || isExecutionControlError(error)) throw error;
      impressum = ''; // a missing Impressum page does not void the homepage profile
    }

    const identifiers = parseImpressum(impressum || home);
    const dictionary = matchCarriedBrands(home, input.homeCountry);
    const rules = classifyTradeRoleByRules(`${home}\n${impressum}`);
    const classified = rules.decisive
      ? null
      : await this.classify(input, homepageUrl, home, impressum, ctx);

    const modelBrands = (classified?.carried_brands ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    const brands = [
      ...dictionary.brands,
      ...modelBrands
        .filter((name) => !dictionary.brands.some((b) => b.name.toLowerCase() === name.toLowerCase()))
        .map((name) => ({ name, country: null })),
    ].slice(0, 30);

    return {
      homepageUrl,
      impressumUrl: impressum ? impressumUrl : null,
      tradeRole: rules.decisive ? rules.role : classified?.trade_role ?? null,
      tradeRoleSource: rules.decisive ? 'rules' : classified ? 'model' : null,
      tradeRoleConfidence: rules.decisive ? RULES_CONFIDENCE : classified?.confidence ?? null,
      ownManufacturing: classified?.own_manufacturing ?? (rules.scores.manufacturer > 0 ? true : null),
      carriedBrands: brands,
      carriesChineseBrand: dictionary.carriesChineseBrand,
      carriesForeignBrand: dictionary.carriesForeignBrand,
      legalName: identifiers.legalName,
      register: identifiers.register,
      vatId: identifiers.vatId,
      evidence: (classified?.evidence ?? []).slice(0, 3),
    };
  }

  private async fetch(url: string, ctx: ExecutionContext & { artifactSubject: ArtifactSubjectRef }): Promise<string> {
    const toolCtx: ToolContext = {
      ...ctx,
      taskContractId: WEBSITE_PROFILE_TASK,
      purpose: ['enrichment'],
    };
    const result = await this.deps.broker.invoke<{ url: string; maxChars?: number }, CrawlResult>(
      'crawl4ai.fetch',
      { url, maxChars: 40_000 },
      toolCtx,
    );
    return result.data.text ?? '';
  }

  private async classify(
    input: WebsiteProfileInput,
    homepageUrl: string,
    home: string,
    impressum: string,
    ctx: ExecutionContext,
  ): Promise<ClassifiedRole | null> {
    const contract = getTask(WEBSITE_PROFILE_TASK);
    try {
      const result = await executeStructuredTaskWithRuntime<ClassifiedRole>(
        this.deps.gateway,
        {
          task: WEBSITE_PROFILE_TASK,
          prompt: `品类上下文（只用于判断相关品类，禁止照抄进字段）：${input.icpContext.slice(0, 600)}\n\n首页（${homepageUrl}）：\n${home.slice(0, HOME_PROMPT_CHARS)}\n\nImpressum：\n${impressum.slice(0, IMPRESSUM_PROMPT_CHARS)}`,
          system: contract?.description,
          model: contract?.model,
          schema: contract?.outputSchema ?? { required: ['trade_role'] },
        },
        { ...ctx, durableResultSchema: 'discovery-classify-trade-role/v1' },
        { telemetry: this.deps.runtimeTelemetry },
      );
      return result.data ?? null;
    } catch (error) {
      if (isExecutionControlError(error)) throw error;
      return null; // model unavailable/invalid output: keep the deterministic facts
    }
  }
}
