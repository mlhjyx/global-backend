import { Controller, Get, Module, Query } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterEach, describe, expect, it } from 'vitest';

import { SitePreviewArtifactService } from './site-preview-artifact.service';
import { SitePreviewController } from './site-preview.controller';

@Controller('query-contract')
class QueryContractController {
  @Get()
  read(@Query('filter') filter: unknown): { filter: unknown } {
    return { filter };
  }
}

@Module({
  controllers: [SitePreviewController, QueryContractController],
  providers: [
    {
      provide: SitePreviewArtifactService,
      useValue: {
        get: async (slug: string, assetPath: string) => ({
          body: Buffer.from(`${slug}|${assetPath}`, 'utf8'),
          contentType: 'text/plain; charset=utf-8',
          etag: '"express-5-route"',
        }),
      },
    },
  ],
})
class Express5ContractModule {}

describe('NestJS 11 / Express 5 HTTP compatibility', () => {
  let app: NestExpressApplication | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('routes a deeply nested preview asset through the named wildcard', async () => {
    app = await NestFactory.create<NestExpressApplication>(
      Express5ContractModule,
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('EXPRESS5_TEST_LISTENER_UNAVAILABLE');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/preview/acme/assets/css/app.css`,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('acme|assets/css/app.css');
  });

  it('preserves nested query parsing when the extended parser is configured', async () => {
    app = await NestFactory.create<NestExpressApplication>(
      Express5ContractModule,
      { logger: false },
    );
    app.set('query parser', 'extended');
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address();
    if (address === null || typeof address === 'string') {
      throw new Error('EXPRESS5_TEST_LISTENER_UNAVAILABLE');
    }

    const response = await fetch(
      `http://127.0.0.1:${address.port}/query-contract?filter[where][name]=Acme`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      filter: { where: { name: 'Acme' } },
    });
  });
});
