import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Site } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RequestContext } from '../auth/request-context';
import { invalidProfileGroups, mergeProfile, Profile } from './profile-merge';

/** 站点列表/详情/建站向导档案（07 §2）。租户隔离由 withWorkspace + RLS 兜底。 */
@Injectable()
export class SitesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: RequestContext): Promise<Site[]> {
    return this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.site.findMany({ orderBy: { createdAt: 'asc' } }),
    );
  }

  async get(ctx: RequestContext, siteId: string): Promise<Site> {
    const site = await this.prisma.withWorkspace(ctx.workspaceId, (tx) =>
      tx.site.findUnique({ where: { id: siteId } }),
    );
    if (!site) throw new NotFoundException('site not found');
    return site;
  }

  async getProfile(ctx: RequestContext, siteId: string): Promise<Profile> {
    const site = await this.get(ctx, siteId);
    return ((site.profile as Profile | null) ?? {}) as Profile;
  }

  /** 向导分步保存：组级替换（profile-merge），未知组 400。返回合并后的完整档案。 */
  async patchProfile(
    ctx: RequestContext,
    siteId: string,
    patch: Record<string, unknown>,
  ): Promise<Profile> {
    const invalid = invalidProfileGroups(patch);
    if (invalid.length > 0) {
      throw new BadRequestException(`unknown profile groups: ${invalid.join(', ')}`);
    }
    return this.prisma.withWorkspace(ctx.workspaceId, async (tx) => {
      const site = await tx.site.findUnique({ where: { id: siteId } });
      if (!site) throw new NotFoundException('site not found');
      const merged = mergeProfile(site.profile as Record<string, unknown> | null, patch);
      await tx.site.update({
        where: { id: siteId },
        data: { profile: merged as Prisma.InputJsonValue },
      });
      return merged;
    });
  }
}
