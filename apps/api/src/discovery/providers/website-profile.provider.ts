import { getTask } from '../../ai-tasks/task-registry';
import { extractSameSiteLinks } from '../../adapters/site-links';
import type { CrawlHtmlResult, CrawlResult } from '../../adapters/web-crawler';
import { isExecutionControlError } from '../../execution-budget/execution-control-error';
import { settledModelFailureReason } from '../settled-model-failure';
import type { ModelGateway } from '../../model-gateway/model-gateway';
import { executeStructuredTaskWithRuntime } from '../../model-runtime/structured-task-runtime-bridge';
import type { RuntimeTelemetry } from '../../model-runtime/types';
import { artifactSubjectSkipReason } from '../../tools/artifact-subject-denial';
import type { ArtifactSubjectRef } from '../../tools/artifact-execution-port';
import type { ExecutionBroker, ToolContext } from '../../tools/tool-contract';
import type { ExecutionContext } from '../provider-contract';
import { matchCarriedBrands } from '../website-profile/brands';
import {
  findContactPaths,
  hasContactForm,
  type CompanyContactLinks,
} from '../website-profile/contact-paths';
import { parseImpressum, type ImpressumRegister } from '../website-profile/impressum';
import { classifyTradeRoleByRules } from '../website-profile/trade-role-rules';
import { scrubPii, scrubPiiKeepingTaxIds } from '../../site-builder/agents/pii';

export const WEBSITE_PROFILE_TASK = 'discovery.classify_trade_role' as const;
/** data_provider kill switch and canonical attribute namespace. */
export const WEBSITE_PROFILE_PROVIDER_KEY = 'website_profile' as const;
/** crawl4ai.fetch text cap per page; a homepage this long may have been cut. */
const PAGE_FETCH_MAX_CHARS = 40_000;
const HOME_PROMPT_CHARS = 12_000;
const IMPRESSUM_PROMPT_CHARS = 4_000;
const RULES_CONFIDENCE = 0.7;
const IMPRESSUM_LINK = /impressum|imprint|legal-notice|legal_notice/iu;
/** Lines about people (management, owners, contacts) never become stored evidence. */
const PERSON_MARKERS =
  /gesch(?:ä|ae)ftsf(?:ü|ue)hr|inhaber|ansprechpartner|vorstand|\b(?:herr|frau|mr|mrs|ms)\b\.?|\bdr\.\s/iu;
/** Impressum labels whose value is a person, beyond PERSON_MARKERS. */
const PERSON_LABELS =
  /vertreten|vertretungsberechtig|verantwortlich|prokur|datenschutzbeauftrag|kontaktperson|managing director|contact person|\bceo\b|\bowner\b/iu;
const MAX_EVIDENCE_SNIPPETS = 3;

/** Company-level evidence only: person lines dropped, phones and emails redacted. */
function companyEvidence(snippets: readonly string[]): string[] {
  return snippets
    .map((snippet) => scrubPii(snippet).trim())
    .filter((snippet) => snippet.length > 0 && !PERSON_MARKERS.test(snippet))
    .slice(0, MAX_EVIDENCE_SNIPPETS);
}

/**
 * Page text for the model, which sits with a third-country provider: person
 * lines are dropped, together with the value line after a bare label such as
 * "Vertreten durch:" (labels may be stacked), and emails and phones are
 * redacted. Register numbers and VAT IDs stay, because they are company facts.
 */
function modelSafeText(text: string): string {
  const kept: string[] = [];
  let dropValueLine = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) {
      kept.push(line);
      continue;
    }
    const personLine = PERSON_MARKERS.test(trimmed) || PERSON_LABELS.test(trimmed);
    if (personLine || dropValueLine) {
      dropValueLine = personLine && trimmed.endsWith(':');
      continue;
    }
    kept.push(line);
  }
  return scrubPiiKeepingTaxIds(kept.join('\n'));
}

export type WebsiteTradeRole =
  | 'distributor' | 'wholesaler' | 'manufacturer' | 'mixed' | 'service' | 'other';

/**
 * BI-14: links to the company's own contact paths found on its homepage, and
 * whether its linked contact page carries a contact form. Links only.
 */
export interface CompanyContactPaths extends CompanyContactLinks {
  /**
   * False when the homepage text reached the fetch cap: links past the cut may exist, so a
   * kind missing from the links proves nothing.
   */
  readonly linksChecked: boolean;
  /** The contact page, when its rendered HTML has a contact form. */
  readonly contactForm: string | null;
  /** False when the contact page could not be rendered: its form is then unknown, not absent. */
  readonly contactFormChecked: boolean;
}

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
  /** BI-15 / L6: registered postal address; null for sole traders and unstated addresses. */
  readonly registeredAddress: string | null;
  readonly evidence: readonly string[];
  /** Present only when the caller asked for contact paths (data_provider company_contact). */
  readonly contactPaths?: CompanyContactPaths;
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
  /**
   * BI-14: also find the company's contact paths among the homepage links and render
   * the linked contact page (at most one page) to look for a contact form.
   */
  readonly contactPaths?: boolean;
}

/**
 * G3 5.4 website-profile enrichment for one already materialized company:
 * both fetches are bound to that company (ToolBroker per-call subject
 * binding), rules decide clear cases and the model only the rest.
 * Prohibition-class denials propagate so the caller can skip the company.
 * When asked (BI-14), it also reads the company's contact paths from the
 * homepage links and renders the linked contact page, under the same subject,
 * to look for a contact form: one page at most, never filled in or submitted.
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
    const contactPaths = input.contactPaths
      ? await this.contactPaths(input.domain, home, ctx)
      : undefined;

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
      registeredAddress: identifiers.registeredAddress,
      evidence: companyEvidence(classified?.evidence ?? []),
      ...(contactPaths ? { contactPaths } : {}),
    };
  }

  /**
   * Contact paths from the homepage links. Only the linked contact page is rendered
   * (MAX_WEBSITE_PROFILE_RENDERS_PER_COMPANY); a page that robots, an error or an
   * empty render keeps unread leaves its form unknown rather than absent.
   */
  private async contactPaths(
    domain: string,
    home: string,
    ctx: ExecutionContext & { artifactSubject: ArtifactSubjectRef },
  ): Promise<CompanyContactPaths> {
    const links = findContactPaths(home, domain);
    const linksChecked = home.length < PAGE_FETCH_MAX_CHARS;
    // No contact page in a complete homepage: there is no form to look for. In a cut one: unknown.
    if (!links.contactPage) {
      return { ...links, linksChecked, contactForm: null, contactFormChecked: linksChecked };
    }
    let html = '';
    try {
      html = await this.render(links.contactPage, ctx);
    } catch (error) {
      if (artifactSubjectSkipReason(error) || isExecutionControlError(error)) throw error;
      html = ''; // an unreadable contact page keeps its link; only the form stays unknown
    }
    if (!html) return { ...links, linksChecked, contactForm: null, contactFormChecked: false };
    return {
      ...links,
      linksChecked,
      contactForm: hasContactForm(html) ? links.contactPage : null,
      contactFormChecked: true,
    };
  }

  private toolContext(ctx: ExecutionContext & { artifactSubject: ArtifactSubjectRef }): ToolContext {
    return {
      ...ctx,
      taskContractId: WEBSITE_PROFILE_TASK,
      purpose: ['enrichment'],
    };
  }

  private async fetch(url: string, ctx: ExecutionContext & { artifactSubject: ArtifactSubjectRef }): Promise<string> {
    const result = await this.deps.broker.invoke<{ url: string; maxChars?: number }, CrawlResult>(
      'crawl4ai.fetch',
      { url, maxChars: PAGE_FETCH_MAX_CHARS },
      this.toolContext(ctx),
    );
    return result.data.text ?? '';
  }

  /**
   * Rendered HTML of one page; empty when robots disallow it. robots and source_policy apply in
   * the tool, whose durable result keeps the HTML as a PERSONAL_DATA artifact for 24 hours under
   * the company subject (as for the homepage and Impressum fetches; DSR erasure covers it).
   */
  private async render(url: string, ctx: ExecutionContext & { artifactSubject: ArtifactSubjectRef }): Promise<string> {
    const result = await this.deps.broker.invoke<{ url: string }, CrawlHtmlResult & { robotsBlocked?: boolean }>(
      'crawl4ai.render',
      { url },
      this.toolContext(ctx),
    );
    return result.data.robotsBlocked ? '' : result.data.html ?? '';
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
          prompt: `品类上下文（只用于判断相关品类，禁止照抄进字段）：${input.icpContext.slice(0, 600)}\n\n首页（${homepageUrl}）：\n${modelSafeText(home).slice(0, HOME_PROMPT_CHARS)}\n\nImpressum：\n${modelSafeText(impressum).slice(0, IMPRESSUM_PROMPT_CHARS)}`,
          system: contract?.description,
          model: contract?.model,
          schema: contract?.outputSchema ?? { required: ['trade_role'] },
        },
        { ...ctx, durableResultSchema: 'discovery-classify-trade-role/v1' },
        { telemetry: this.deps.runtimeTelemetry },
      );
      return result.data ?? null;
    } catch (error) {
      // A transport failure usually hits every company, so it stops the run. A lone stream the
      // gateway settled as cut short is one company's failure, like an unusable answer; a
      // truncation outage is still stopped by the fit pass, which halts on two cuts in a row.
      if (isExecutionControlError(error) && settledModelFailureReason(error) === undefined) throw error;
      return null; // model unavailable/invalid output: keep the deterministic facts
    }
  }
}
