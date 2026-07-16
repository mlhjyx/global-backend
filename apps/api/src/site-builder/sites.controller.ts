import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { ApiEnvelope, ApiListEnvelope } from '../common/api-envelope.decorator';
import { Enveloped, envelope } from '../common/envelope';
import { SiteDto } from './dto/site.dto';
import { previewUrlFor } from './preview-url';
import {
  PROFILE_PATCH_SCHEMA,
  PROFILE_RESPONSE_SCHEMA,
  ProfileMigrationRequiredException,
  ProfilePatchPipe,
  ProfileResult,
  ProfileVersionConflictException,
  ValidatedProfilePatch,
  profileEtag,
  resolveProfilePrecondition,
} from './profile-contract';
import { SitesService } from './sites.service';

const PROFILE_RESPONSE_HEADERS = {
  ETag: {
    description: 'Profile 强校验器，格式为 "profile:<versionId>"',
    schema: { type: 'string' },
  },
  'Cache-Control': {
    description: 'Profile 为租户私有且每次使用前须重新验证',
    schema: { type: 'string', example: 'private, no-cache' },
  },
};

const PROFILE_ERROR_SCHEMA = {
  type: 'object',
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
};

@ApiTags('SiteBuilder')
@ApiBearerAuth()
@Controller('site-builder')
@UseGuards(AuthGuard)
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Get('sites')
  @ApiOperation({ summary: '列出本 workspace 站点（含预览地址）' })
  @ApiListEnvelope(SiteDto)
  async list(@Ctx() ctx: RequestContext): Promise<Enveloped<SiteDto[]>> {
    const rows = await this.sites.list(ctx);
    return envelope(rows.map((row) => SiteDto.from(row, previewUrlFor(row))));
  }

  @Get('sites/:id')
  @ApiOperation({ summary: '站点详情' })
  @ApiEnvelope(SiteDto)
  async get(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Enveloped<SiteDto>> {
    const row = await this.sites.get(ctx, id);
    return envelope(SiteDto.from(row, previewUrlFor(row)));
  }

  @Get('sites/:id/profile')
  @ApiOperation({ summary: '建站向导档案（五组）' })
  @ApiEnvelope(PROFILE_RESPONSE_SCHEMA, { headers: PROFILE_RESPONSE_HEADERS })
  @ApiResponse({
    status: 409,
    description: '历史 Profile 不符合当前严格 schema，须显式替换无效组',
    schema: PROFILE_ERROR_SCHEMA,
    headers: PROFILE_RESPONSE_HEADERS,
  })
  async getProfile(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Enveloped<ProfileResult>> {
    try {
      const profile = await this.sites.getProfile(ctx, id);
      this.setProfileHeaders(response, profile.versionId);
      return envelope(profile);
    } catch (error) {
      if (error instanceof ProfileMigrationRequiredException) {
        this.setProfileHeaders(response, error.currentVersionId);
      }
      throw error;
    }
  }

  @Patch('sites/:id/profile')
  @ApiOperation({
    summary:
      '向导分步保存：组级替换（companyProfile/trustAssets/onlineAssets/brand/contact），可跳过',
  })
  @ApiHeader({
    name: 'if-match',
    required: false,
    description: 'Profile 强 ETag；与 body.baseVersionId 至少提供一个',
    schema: {
      type: 'string',
      example: '"profile:11111111-1111-4111-8111-111111111111"',
    },
  })
  @ApiBody({ schema: PROFILE_PATCH_SCHEMA })
  @ApiEnvelope(PROFILE_RESPONSE_SCHEMA, { headers: PROFILE_RESPONSE_HEADERS })
  @ApiResponse({
    status: 400,
    description: 'If-Match 非法或双判据矛盾',
    schema: PROFILE_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 404,
    description: '当前 workspace 不可见该 Site',
    schema: PROFILE_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 409,
    description: 'baseVersionId 已过期',
    schema: PROFILE_ERROR_SCHEMA,
    headers: PROFILE_RESPONSE_HEADERS,
  })
  @ApiResponse({
    status: 412,
    description: 'If-Match 已过期',
    schema: PROFILE_ERROR_SCHEMA,
    headers: PROFILE_RESPONSE_HEADERS,
  })
  @ApiResponse({
    status: 422,
    description: 'Profile schema、数量、URL、引用或大小不合格',
    schema: PROFILE_ERROR_SCHEMA,
  })
  @ApiResponse({
    status: 428,
    description: '缺少 If-Match/baseVersionId',
    schema: PROFILE_ERROR_SCHEMA,
  })
  async patchProfile(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(ProfilePatchPipe) patch: ValidatedProfilePatch,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Enveloped<ProfileResult>> {
    const precondition = resolveProfilePrecondition(
      ifMatch,
      patch.baseVersionId,
    );
    try {
      const profile = await this.sites.patchProfile(
        ctx,
        id,
        patch.groups,
        precondition,
      );
      this.setProfileHeaders(response, profile.versionId);
      return envelope(profile);
    } catch (error) {
      if (error instanceof ProfileVersionConflictException) {
        this.setProfileHeaders(response, error.currentVersionId);
      }
      throw error;
    }
  }

  private setProfileHeaders(response: Response, versionId: string): void {
    response.setHeader('ETag', profileEtag(versionId));
    response.setHeader('Cache-Control', 'private, no-cache');
  }
}
