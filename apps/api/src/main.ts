import 'reflect-metadata';
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { GlobalHttpExceptionFilter } from './common/http-exception.filter';

/** code-first OpenAPI 文档（单一事实源：从实现的装饰器生成）。 */
function buildOpenApi(app: Parameters<typeof SwaggerModule.createDocument>[0]) {
  const config = new DocumentBuilder()
    .setTitle('Global API')
    .setDescription('出海企业 AI 全球客户开发与增长平台 · 后端 API（前端接入见 packages/contracts/INTEGRATION.md）')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  return SwaggerModule.createDocument(app, config);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new GlobalHttpExceptionFilter()); // 统一错误模型（PRD 11.15）

  // ── 面向前端的安全护栏 ──────────────────────────────────────────────
  app.use(helmet({ contentSecurityPolicy: false })); // API 无 HTML，关 CSP 免误伤 Swagger UI
  // CORS 白名单：逗号分隔的允许源；未配置时 dev 放行、prod 收紧。
  const origins = (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  app.enableCors({
    origin: origins.length ? origins : process.env.NODE_ENV === 'production' ? false : true,
    credentials: true,
    exposedHeaders: ['Location', 'X-Request-Id'],
  });
  app.getHttpAdapter().getInstance().set('trust proxy', 1); // 限流/日志取真实 IP（经网关时）

  // ── code-first OpenAPI（唯一事实源）──────────────────────────────────
  const document = buildOpenApi(app);
  SwaggerModule.setup('api/docs', app, document); // 内部调试用（Swagger UI）
  // 给前端的统一门户（自托管 Scalar，数据全留本地）：可浏览 + try-it 调试。
  // 一个稳定入口 /api/portal，吃 code-first OpenAPI，无需外部 SaaS。
  app.use(
    '/api/portal',
    apiReference({
      content: document,
      theme: 'purple',
      metaData: { title: 'Global API · 前端接入门户' },
    }),
  );

  // --export-openapi：把契约落盘到 packages/contracts，供门户/CI 消费后退出。
  // 让 code-first 装饰器成为唯一事实源，手写 openapi.yaml 降级为生成物。
  if (process.argv.includes('--export-openapi')) {
    const out = resolve(__dirname, '../../../packages/contracts/openapi/openapi.json');
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(document, null, 2));
     
    console.log(`[openapi] exported ${Object.keys(document.paths ?? {}).length} paths → ${out}`);
    await app.close();
    return;
  }

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  await app.listen(port);
   
  console.log(`[api] listening on http://localhost:${port}/api  (docs: /api/docs)`);
}

void bootstrap();
