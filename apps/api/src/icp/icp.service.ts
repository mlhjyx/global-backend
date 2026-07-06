import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModelGateway } from '../model-gateway/model-gateway';
import { RequestContext } from '../auth/request-context';
import { getTask } from '../ai-tasks/task-registry';

interface IcpModelOutput {
  name: string;
  company_attributes: Record<string, unknown>;
  pain_points: string[];
  trigger_signals: string[];
  exclusions: string[];
  value_props: string[];
  target_markets: string[];
  personas: { title: string; goals: string[]; pain_points: string[] }[];
  buying_committee: { role: string; title: string; concerns: string[] }[];
}

const json = (v: unknown): Prisma.InputJsonValue => (v ?? []) as Prisma.InputJsonValue;

@Injectable()
export class IcpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: ModelGateway,
  ) {}

  /** AI-design an ICP from the seller company's APPROVED claims (PRD 5.4 / 7.5). */
  async generateFromCompany(ctx: RequestContext, companyId: string) {
    const { company, claims } = await this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const company = await tx.companyProfile.findUnique({ where: { id: companyId } });
      if (!company) {
        throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'company not found' } });
      }
      const claims = await tx.claim.findMany({ where: { companyId, status: 'APPROVED' } });
      return { company, claims };
    });

    if (claims.length === 0) {
      throw new BadRequestException({
        error: { code: 'NO_APPROVED_CLAIMS', message: '先审批一些企业事实(Claim)再生成 ICP' },
      });
    }

    const contract = getTask('icp.design')!;
    const facts = claims.map((c) => `- [${c.type}] ${c.statement}`).join('\n');
    const prompt = `卖方企业：${company.name}${company.website ? ` (${company.website})` : ''}\n已确认的企业事实：\n${facts}\n\n请据此设计其理想客户画像(ICP)与买家委员会，输出中文。`;

    const result = await this.gateway.generateStructured<IcpModelOutput>(
      {
        task: contract.id,
        prompt,
        system: contract.description,
        model: contract.model,
        schema: contract.outputSchema,
      },
      { workspaceId: ctx.workspaceId, userId: ctx.userId },
    );
    const out = result.data;

    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const icp = await tx.icpDefinition.create({
        data: {
          workspaceId: ctx.workspaceId,
          companyId,
          name: out.name ?? '未命名 ICP',
          status: 'HYPOTHESIS', // AI-generated, not yet backtested
          companyAttributes: json(out.company_attributes),
          painPoints: json(out.pain_points),
          triggerSignals: json(out.trigger_signals),
          exclusions: json(out.exclusions),
          valueProps: json(out.value_props),
          targetMarkets: json(out.target_markets),
        },
      });
      for (const p of out.personas ?? []) {
        await tx.persona.create({
          data: {
            workspaceId: ctx.workspaceId,
            icpId: icp.id,
            title: p.title,
            goals: json(p.goals),
            painPoints: json(p.pain_points),
          },
        });
      }
      for (const r of out.buying_committee ?? []) {
        await tx.buyingCommitteeRole.create({
          data: {
            workspaceId: ctx.workspaceId,
            icpId: icp.id,
            role: r.role,
            title: r.title,
            concerns: json(r.concerns),
          },
        });
      }
      return this.full(tx, icp.id);
    });
  }

  list(ctx: RequestContext, companyId?: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.icpDefinition.findMany({
        where: companyId ? { companyId } : {},
        orderBy: { createdAt: 'desc' },
        include: { personas: true, roles: true },
      }),
    );
  }

  get(ctx: RequestContext, icpId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) => this.full(tx, icpId));
  }

  /** Human Gate: promote to ACTIVE (PRD ICP state machine); emits ICPActivated. */
  async activate(ctx: RequestContext, icpId: string) {
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const icp = await tx.icpDefinition.findUnique({ where: { id: icpId } });
      if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
      if (!['DRAFT', 'HYPOTHESIS', 'VALIDATING'].includes(icp.status)) {
        throw new ConflictException({
          error: { code: 'INVALID_STATE', message: `icp is ${icp.status}; cannot activate` },
        });
      }
      await tx.icpDefinition.update({
        where: { id: icpId },
        data: { status: 'ACTIVE', version: { increment: 1 } },
      });
      await tx.outboxEvent.create({
        data: {
          workspaceId: ctx.workspaceId,
          eventType: 'ICPActivated',
          aggregateType: 'ICP',
          aggregateId: icpId,
          payload: { companyId: icp.companyId },
        },
      });
      return this.full(tx, icpId);
    });
  }

  private async full(tx: Prisma.TransactionClient, icpId: string) {
    const icp = await tx.icpDefinition.findUnique({
      where: { id: icpId },
      include: { personas: true, roles: true },
    });
    if (!icp) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'icp not found' } });
    return icp;
  }
}
