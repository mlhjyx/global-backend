import { Controller, Get, Param, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';

import { SitePreviewArtifactService } from './site-preview-artifact.service';

@ApiExcludeController()
@Controller('preview')
export class SitePreviewController {
  constructor(private readonly previews: SitePreviewArtifactService) {}

  private async send(
    slug: string,
    assetPath: string,
    response: Response,
  ): Promise<void> {
    const artifact = await this.previews.get(slug, assetPath);
    response
      .status(200)
      .set({
        'Cache-Control': 'public, no-cache',
        'Content-Type': artifact.contentType,
        ETag: artifact.etag,
        'X-Content-Type-Options': 'nosniff',
      })
      .send(artifact.body);
  }

  @Get(':slug')
  async index(
    @Param('slug') slug: string,
    @Res() response: Response,
  ): Promise<void> {
    return this.send(slug, '', response);
  }

  @Get(':slug/:assetPath(*)')
  async asset(
    @Param('slug') slug: string,
    @Param('assetPath') assetPath: string,
    @Res() response: Response,
  ): Promise<void> {
    return this.send(slug, assetPath, response);
  }
}
