import { ForbiddenException, Inject, Injectable, Optional } from '@nestjs/common';
import { RequestContext } from '../auth/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { recordPersonalDataAccess } from '../compliance/personal-data-access-audit';
import type { EnrichCompanyContactsResult } from '../enrichment/waterfall/enrich-company-contacts';
import type { ContactEnrichmentSafetyService } from '../enrichment/safety/contact-enrichment-safety.service';
import { isValidLawfulBasis, stampLawfulBasis } from './compliance/email-verification-gate';
import type { LawfulBasis } from './provider-contract';
export const CONTACT_ENRICHMENT_SAFETY_EXECUTOR = Symbol('CONTACT_ENRICHMENT_SAFETY_EXECUTOR');

/**
 * P1-10a：公司级邮箱富集入口。
 *
 * The safety lane is now the only execution path: without it the service fails closed
 * before any Grant is consumed or any legacy finder is wired.
 */
@Injectable()
export class ContactEnrichmentService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(CONTACT_ENRICHMENT_SAFETY_EXECUTOR) private readonly safety?: Pick<ContactEnrichmentSafetyService, 'executeHttp'>,
  ) {}

  async enrichContacts(
    ctx: RequestContext,
    companyId: string,
    opts: {
      lawfulBasis?: LawfulBasis;
      contactIds?: string[];
      maxProviders?: number;
      maxProbe?: number;
      attemptId?: string;
    },
    compactJws?: string,
  ): Promise<EnrichCompanyContactsResult> {
    if (!isValidLawfulBasis(opts?.lawfulBasis)) {
      throw new ForbiddenException({
        error: {
          code: 'CONTACT_ENRICH_LAWFUL_BASIS_REQUIRED',
          message: 'an explicit lawful basis is required for external contact enrichment',
        },
      });
    }
    if (!this.safety) {
      throw new ForbiddenException({
        error: {
          code: 'GOVERNANCE_PENDING',
          message: 'contact enrichment safety lane is not composed',
        },
      });
    }
    const recordedBasis = stampLawfulBasis(opts.lawfulBasis, ctx.userId, new Date().toISOString());
    const safetyResult = await this.safety.executeHttp(
      ctx,
      companyId,
      {
        lawfulBasis: recordedBasis,
        ...(opts.contactIds === undefined ? {} : { contactIds: opts.contactIds }),
        ...(opts.maxProviders === undefined ? {} : { maxProviders: opts.maxProviders }),
        ...(opts.maxProbe === undefined ? {} : { maxProbe: opts.maxProbe }),
        ...(opts.attemptId === undefined ? {} : { attemptId: opts.attemptId }),
      },
      compactJws,
    );
    await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      recordPersonalDataAccess(tx, {
        workspaceId: ctx.workspaceId,
        actorId: ctx.userId,
        actorKind: 'user',
        purpose: 'contact_discovery',
        companyId,
        fieldClasses: ['person_name', 'email'],
        subjectCount: safetyResult.attempted,
        lawfulBasisRef: opts.lawfulBasis?.ref ?? null,
      }),
    );
    return safetyResult;
  }
}
