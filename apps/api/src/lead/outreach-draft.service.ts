import {
  BadGatewayException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { RequestContext } from '../auth/request-context';
import { getTask } from '../ai-tasks/task-registry';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { LangfuseRuntimeTelemetryService } from '../model-runtime';
import { executeStructuredTaskWithRuntime } from '../model-runtime/structured-task-runtime-bridge';
import { type BudgetStore, TOOL_BUDGET_STORE, UnavailableBudgetStore } from '../tools/budget-store';
import {
  assertFreshExecutionBudgetBinding,
  ExecutionBudgetAuthorityService,
} from '../execution-budget/execution-budget-authority.service';
import { workspaceExecutionBudgetRequestScope } from '../execution-budget/execution-budget-request-scope';
import { executeGrantedModelTask } from '../execution-budget/granted-model-task';
import {
  applyDomainAckConsumerTransaction,
  domainAggregateIdForReceipt,
} from '../durable-results/domain-ack-consumer-bindings';
import {
  buyerOutreachFacts,
  fitOutreachFacts,
  outreachDraftLanguage,
  outreachDraftPrompt,
  replyEntryFooter,
  sellerOutreachFacts,
  signalOutreachFacts,
  ungroundedFacts,
  type OutreachFact,
} from './outreach-draft';

const PRODUCER_ID = 'outreach.first_contact_draft';
const DURABLE_RESULT_SCHEMA = 'outreach-first-contact-draft/v1' as const;
const MAX_VERSION_ATTEMPTS = 3;

interface OutreachModelOutput {
  subject: string;
  body: string;
  body_zh: string;
  used_facts: string[];
}

export interface OutreachDraftRow {
  readonly id: string;
  readonly leadId: string;
  readonly version: number;
  readonly language: string;
  readonly subject: string;
  readonly body: string;
  readonly bodyZh: string;
  readonly usedFacts: readonly string[];
  readonly model: string;
  readonly createdAt: Date;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

const E164 = /^\+[1-9][0-9]{7,14}$/u;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

@Injectable()
export class OutreachDraftService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ModelGateway,
    private readonly runtimeTelemetry: LangfuseRuntimeTelemetryService,
    private readonly authority: ExecutionBudgetAuthorityService,
    @Optional() @Inject(TOOL_BUDGET_STORE) private readonly budgetStore?: BudgetStore,
  ) {}

  /**
   * BI-15: generate the next version of a lead's first-contact draft under a workspace
   * grant. The draft is stored, never sent; a failure leaves the lead untouched.
   */
  async generate(
    ctx: RequestContext,
    leadId: string,
    compactJws?: string,
  ): Promise<OutreachDraftRow> {
    const binding = await this.authority.consumeWorkspaceGrant({
      compactJws,
      identity: ctx,
      scope: workspaceExecutionBudgetRequestScope({
        operation: 'POST /leads/:leadId/outreach-drafts',
        leadId,
      }),
    });
    assertFreshExecutionBudgetBinding(binding);

    const loaded = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const lead = await tx.lead.findUnique({
        where: { id: leadId },
        select: {
          id: true,
          icpId: true,
          canonicalCompanyId: true,
          fitVerdict: true,
          totalScore: true,
          queue: true,
          scores: true,
          scoreDetail: true,
          decisions: {
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: { action: true },
          },
        },
      });
      if (!lead) return null;
      const icp = await tx.icpDefinition.findUnique({
        where: { id: lead.icpId },
        select: { companyId: true },
      });
      const seller = icp
        ? await tx.companyProfile.findUnique({
            where: { id: icp.companyId },
            select: { id: true, name: true, website: true, summary: true, publicContacts: true },
          })
        : null;
      const buyer = await tx.canonicalCompany.findUnique({
        where: { id: lead.canonicalCompanyId },
        select: { name: true, domain: true, country: true, attributes: true },
      });
      const claims = seller
        ? await tx.claim.findMany({
            where: { companyId: seller.id, status: 'APPROVED' },
            select: { id: true, type: true, statement: true },
            orderBy: { createdAt: 'asc' },
            take: 20,
          })
        : [];
      const offerings = seller
        ? await tx.offering.findMany({
            where: { companyId: seller.id },
            select: { id: true, name: true, description: true },
            orderBy: { confidence: 'desc' },
            take: 10,
          })
        : [];
      const site = seller
        ? await tx.site.findFirst({
            where: { companyProfileId: seller.id, profile: { not: Prisma.DbNull } },
            select: { profile: true },
            orderBy: { updatedAt: 'desc' },
          })
        : null;
      return { lead, seller, buyer, claims, offerings, site };
    });
    if (!loaded || !loaded.seller || !loaded.buyer) {
      throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'lead not found' } });
    }
    if (loaded.lead.decisions[0]?.action !== 'accept') {
      throw new UnprocessableEntityException({
        error: {
          code: 'OUTREACH_DRAFT_LEAD_NOT_ACCEPTED',
          message: 'first-contact drafts are written only for leads the operator accepted',
        },
      });
    }

    const { lead, seller, buyer } = loaded;
    const facts: OutreachFact[] = [
      ...sellerOutreachFacts({
        name: seller.name,
        website: seller.website,
        summary: seller.summary,
        claims: loaded.claims,
        offerings: loaded.offerings,
      }),
      ...buyerOutreachFacts(buyer),
      ...fitOutreachFacts(lead),
      ...signalOutreachFacts(buyer.attributes),
    ];
    const language = outreachDraftLanguage(buyer.country);
    const contract = getTask(PRODUCER_ID);
    if (!contract) {
      throw new Error('outreach.first_contact_draft task contract is missing');
    }

    const result = await executeGrantedModelTask<OutreachModelOutput>({
      budgetStore:
        this.budgetStore ??
        new UnavailableBudgetStore('Outreach draft generation requires an authoritative BudgetStore'),
      binding,
      durableResultSchema: DURABLE_RESULT_SCHEMA,
      execute: (budgetContext) =>
        executeStructuredTaskWithRuntime<OutreachModelOutput>(
          this.gateway,
          {
            task: contract.id,
            prompt: outreachDraftPrompt(facts, language),
            system: contract.description,
            model: contract.model,
            schema: contract.outputSchema,
          },
          { workspaceId: ctx.workspaceId, userId: ctx.userId, ...budgetContext },
          { telemetry: this.runtimeTelemetry },
        ),
    });

    const out = result.data;
    const subject = out.subject.trim();
    const draftBody = out.body.trim();
    const bodyZh = out.body_zh.trim();
    if (!subject || !draftBody || !bodyZh) {
      throw new BadGatewayException({
        error: {
          code: 'OUTREACH_DRAFT_UNGROUNDED',
          message: 'draft left the subject, body or translation empty; discarded',
        },
      });
    }
    const allowedKeys = new Set(facts.map((fact) => fact.key));
    const ungrounded = ungroundedFacts(out.used_facts, allowedKeys);
    if (ungrounded.length > 0) {
      throw new BadGatewayException({
        error: {
          code: 'OUTREACH_DRAFT_UNGROUNDED',
          message: `draft cited facts that were not provided (${ungrounded.slice(0, 3).join(', ')}); discarded`,
        },
      });
    }
    const usedFacts = [...new Set(out.used_facts.map((key) => key.trim()))];

    const footer = replyEntryFooter(sellerReplyContact(seller, loaded.site?.profile));
    const body = footer ? `${draftBody}\n\n${footer}` : draftBody;
    const model = result.reportedModel ?? result.model;
    const draftId = result.durableReceipt
      ? domainAggregateIdForReceipt(result.durableReceipt, PRODUCER_ID)
      : undefined;

    for (let attempt = 1; ; attempt += 1) {
      try {
        const applied = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
          return applyDomainAckConsumerTransaction({
            transaction: tx,
            producerId: PRODUCER_ID,
            receipt: result.durableReceipt,
            domainAckKey: draftId ?? leadId,
            domainRevision: result.durableReceipt?.resultDigest ?? '1',
            apply: async (transaction) => {
              const last = await transaction.leadOutreachDraft.findFirst({
                where: { leadId },
                orderBy: { version: 'desc' },
                select: { version: true },
              });
              return transaction.leadOutreachDraft.create({
                data: {
                  ...(draftId ? { id: draftId } : {}),
                  workspaceId: ctx.workspaceId,
                  leadId,
                  version: (last?.version ?? 0) + 1,
                  language,
                  subject,
                  body,
                  bodyZh,
                  usedFacts: usedFacts as Prisma.InputJsonValue,
                  model,
                },
              });
            },
          });
        });
        if (applied.status === 'REPLAYED') {
          // The original attempt already wrote this exact receipt's draft; return it.
          const existing = draftId
            ? await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
                tx.leadOutreachDraft.findUnique({ where: { id: draftId } }),
              )
            : null;
          if (!existing) {
            throw new Error('replayed outreach draft ack without its draft row');
          }
          return toRow(existing);
        }
        if (!applied.value) {
          throw new Error('outreach draft ack applied without a draft row');
        }
        return toRow(applied.value);
      } catch (error) {
        // Two operators drafting the same lead concurrently: recompute the next version.
        if (isUniqueViolation(error) && attempt < MAX_VERSION_ATTEMPTS) continue;
        throw error;
      }
    }
  }
}

function sellerReplyContact(
  seller: { name: string; website: string | null; publicContacts: unknown },
  siteProfile: unknown,
): { sellerName: string; website: string | null; email: string | null; whatsapp: string | null } {
  const site = record(siteProfile);
  const contact = record(site.contact);
  const siteCompany = record(site.companyProfile);
  const website =
    text(seller.website) || text(siteCompany.website) || null;
  const publicContacts = Array.isArray(seller.publicContacts) ? seller.publicContacts : [];
  const publicEmail = publicContacts
    .map((entry) => record(entry))
    .find((entry) => text(entry.type) === 'email' && EMAIL.test(text(entry.value)));
  const siteEmail = (Array.isArray(contact.publicEmails) ? contact.publicEmails : [])
    .map((value) => text(value))
    .find((value) => EMAIL.test(value));
  const email = publicEmail ? text(publicEmail.value) : (siteEmail ?? null);
  const whatsapp = (Array.isArray(contact.whatsappNumbers) ? contact.whatsappNumbers : [])
    .map((value) => text(value))
    .find((value) => E164.test(value));
  return { sellerName: seller.name, website, email, whatsapp: whatsapp ?? null };
}

function toRow(row: {
  id: string;
  leadId: string;
  version: number;
  language: string;
  subject: string;
  body: string;
  bodyZh: string;
  usedFacts: unknown;
  model: string;
  createdAt: Date;
}): OutreachDraftRow {
  return Object.freeze({
    id: row.id,
    leadId: row.leadId,
    version: row.version,
    language: row.language,
    subject: row.subject,
    body: row.body,
    bodyZh: row.bodyZh,
    usedFacts: Array.isArray(row.usedFacts) ? row.usedFacts.filter((item): item is string => typeof item === 'string') : [],
    model: row.model,
    createdAt: row.createdAt,
  });
}
