import 'reflect-metadata';
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { GlobalHttpExceptionFilter } from './common/http-exception.filter';
import { PLATFORM_TECHNICAL_QUOTE_OPENAPI_SECURITY_SCHEME } from './platform-authority/platform-technical-quote-service-auth';
import { PLATFORM_AUTHORITY_TARGET_READER_SECURITY_SCHEME } from './platform-authority/platform-target-lookup.openapi';
import {
  resolveCorsOrigin,
  resolveRuntimeSettings,
} from './runtime/runtime-environment';
import { initializeRuntimeReleaseIdentity } from './runtime/runtime-release-identity';
import { PORTAL_INTRO_MARKDOWN } from './docs/portal-intro';
import { OPERATION_DESCRIPTIONS } from './docs/operation-descriptions';
import { resolveDevFastLane } from './runtime/dev-fast-lane';
import { installPlatformRevocationHttpBoundary } from './platform-authority/platform-revocation-http.middleware';

/** The filled weekly CSV: UTF-8 text, one export back, bounded. */
const CSV_BODY_ROUTE = '/api/v1/reports/weekly/feedback';
const CSV_BODY_MAX_BYTES = 5 * 1024 * 1024;

/**
 * BI-23: read a text/csv body on the weekly-feedback route into `req.body` as a string.
 * Plain listener (no parser dependency): applied after Nest's own parsers, it only touches
 * this one route, and it answers 413 the moment the cap is crossed instead of buffering on.
 */
function installCsvTextBodyReader(app: { use: (handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void }): void {
  app.use((req, res, next) => {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (
      req.method !== 'POST' ||
      !req.url?.split('?', 1)[0]?.startsWith(CSV_BODY_ROUTE) ||
      !(contentType.startsWith('text/csv') || contentType.startsWith('application/csv'))
    ) {
      next();
      return;
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > CSV_BODY_MAX_BYTES) {
        settled = true;
        res.statusCode = 413;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(
          JSON.stringify({
            error: { code: 'PAYLOAD_TOO_LARGE', message: `csv body must not exceed ${CSV_BODY_MAX_BYTES} bytes` },
          }),
        );
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      (req as IncomingMessage & { body?: unknown }).body = Buffer.concat(chunks).toString('utf8');
      next();
    });
    req.on('error', () => {
      if (!settled) {
        settled = true;
        next();
      }
    });
  });
}

/** code-first OpenAPI 文档（单一事实源：从实现的装饰器生成）。 */
function buildOpenApi(app: Parameters<typeof SwaggerModule.createDocument>[0]) {
  const config = new DocumentBuilder()
    .setTitle('Global API')
    .setDescription(PORTAL_INTRO_MARKDOWN)
    .setVersion('0.1.0')
    .addServer('/', '同源部署（相对路径；具体 host 由部署环境决定）')
    .addTag('Companies', '企业画像：提交官网、看完整度、审批后人工确认')
    .addTag('Claims', '企业事实与来源：审批 / 驳回 / 撤销、冲突裁决')
    .addTag('ICP', '理想客户画像：规则、回溯测试、查询计划')
    .addTag('Discovery', '查询计划执行、规范化公司、联系人补全、抑制名单')
    .addTag('Leads', '评分产出与交付：交付包、接受 / 拒绝、制裁复核')
    .addTag('Reports', '周报与反馈')
    .addTag('Events', '事件投递账本与确认回执')
    .addTag('Compliance', '数据主体删除请求（Art.17）')
    .addTag('SiteBuilder', '独立站：intake、资料、素材、构建、预览')
    .addTag('ExecutionBudget', '平台内部执行预算包络（服务间调用，普通前端不调用）')
    .addTag('PlatformAuthority', '平台权威通道（服务间调用，普通前端不调用）')
    .addTag('System', '健康探针与身份')
    .addBearerAuth()
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'GrowthOS service token for the Platform Technical Quote reader only.',
      },
      PLATFORM_TECHNICAL_QUOTE_OPENAPI_SECURITY_SCHEME,
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT',
        description: 'Fixed-purpose GrowthOS service identity for exact platform target lookup; not a user or budget token.' },
      PLATFORM_AUTHORITY_TARGET_READER_SECURITY_SCHEME,
    )
    .build();
  const document = SwaggerModule.createDocument(app, config);
  // 每个操作的正文说明集中维护在 docs/operation-descriptions.ts；控制器上已有的
  // description 优先，这里只补空缺。新增端点漏写会被 operation-descriptions.spec.ts 拦下。
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    const operations = item as Record<string, { description?: string } | undefined>;
    for (const method of ['get', 'post', 'put', 'patch', 'delete'] as const) {
      const operation = operations[method];
      if (!operation || operation.description) continue;
      const description = OPERATION_DESCRIPTIONS[`${method.toUpperCase()} ${path}`];
      if (description) operation.description = description;
    }
  }
  // 门户左侧按接入顺序分组，而不是按标签字母序。
  Object.assign(document, {
    'x-tagGroups': [
      { name: '获客主链路', tags: ['Companies', 'Claims', 'ICP', 'Discovery', 'Leads'] },
      { name: '运营与合规', tags: ['Reports', 'Events', 'Compliance'] },
      { name: '建站', tags: ['SiteBuilder'] },
      { name: '平台间通道', tags: ['ExecutionBudget', 'PlatformAuthority'] },
      { name: '系统', tags: ['System'] },
    ],
  });
  const buildStatus = document.components?.schemas?.BuildStatusResponseDto;
  if (buildStatus && !('$ref' in buildStatus)) {
    // ApiProperty uses `required` both for the parent property flag and the
    // nested object's required field list. Keep the closed nested schema and
    // restore the pre-existing required+nullable response key explicitly.
    buildStatus.required = Array.from(
      new Set([...(buildStatus.required ?? []), 'costSummary']),
    );
  }
  const technicalBudgetQuote =
    document.components?.schemas?.SiteBuildTechnicalBudgetQuoteResponseDto;
  if (technicalBudgetQuote && !('$ref' in technicalBudgetQuote)) {
    // Swagger DTO metadata does not emit a closed-object marker. The quote is
    // a signed-authority input, so unknown commercial/balance fields must not
    // become part of its public contract through permissive code generation.
    technicalBudgetQuote.additionalProperties = false;
  }
  const workspaceTechnicalBudgetQuote =
    document.components?.schemas?.WorkspaceTechnicalBudgetQuoteResponseDto;
  if (workspaceTechnicalBudgetQuote && !('$ref' in workspaceTechnicalBudgetQuote)) {
    workspaceTechnicalBudgetQuote.additionalProperties = false;
  }
  return document;
}

async function bootstrap(): Promise<void> {
  const runtimeSettings = resolveRuntimeSettings(process.env);
  // Fail closed on any lane variable outside development before Nest starts.
  // The lane only routes; it never changes this process's release identity.
  const devFastLane = resolveDevFastLane(runtimeSettings.mode, process.env);
  if (devFastLane.enabled) {
    console.warn(
      `[api] DEV FAST LANE: acquisition commands of one workspace route to task queue '${devFastLane.taskQueue}' on ${devFastLane.temporalAddress}`,
    );
  }
  await initializeRuntimeReleaseIdentity({
    mode: runtimeSettings.mode,
    artifactRoot: resolve(__dirname),
    env: process.env,
  });
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  // Exact signed-body parser and no-store boundary precede Nest's JSON parser
  // and all guards. Never expose compact JWS through enumerable request.body.
  installPlatformRevocationHttpBoundary(app);
  // BI-23: the filled weekly CSV comes back as text/csv, which no built-in parser reads. This
  // listener is scoped to its one route (no other path buffers a large text body before the
  // guards), caps the size while reading, and answers 413 instead of buffering past the cap.
  installCsvTextBodyReader(app);
  // Express 5 defaults to the simple query parser. Preserve the existing
  // nested-query contract while using the patched qs release from its tree.
  app.set('query parser', 'extended');
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new GlobalHttpExceptionFilter()); // 统一错误模型（PRD 11.15）

  // ── 面向前端的安全护栏 ──────────────────────────────────────────────
  app.use(helmet()); // Keep CSP enabled for the locally served Swagger/Scalar HTML.
  // CORS 白名单：逗号分隔的允许源；未配置时 dev 放行、prod 收紧。
  app.enableCors({
    origin: resolveCorsOrigin(runtimeSettings.mode, process.env.CORS_ORIGINS),
    credentials: true,
    exposedHeaders: ['Location', 'X-Request-Id', 'ETag'],
  });
  app.getHttpAdapter().getInstance().set('trust proxy', 1); // 限流/日志取真实 IP（经网关时）

  // ── code-first OpenAPI（唯一事实源）──────────────────────────────────
  const document = buildOpenApi(app);
  SwaggerModule.setup('api/docs', app, document); // 内部调试用（Swagger UI）
  // 给前端的统一门户（自托管 Scalar，数据全留本地）：可浏览 + try-it 调试。
  // 一个稳定入口 /api/portal，吃 code-first OpenAPI，无需外部 SaaS。
  // Scalar 的页面由两段脚本组成：页面里的内联配置（含整份 OpenAPI，数据不出本机），
  // 以及由浏览器从 jsdelivr 取的 Scalar 运行时库。全局 helmet 的 script-src 'self'
  // 会把两者都拦掉、页面渲染成白屏；这条文档路由单独放开这两处，其余指令沿用默认。
  // 运行时库走 CDN 意味着门户需要浏览器能出网——这是当前实现的已知限制，接口与数据本身仍在本地。
  app.use(
    '/api/portal',
    helmet({
      contentSecurityPolicy: {
        directives: {
          scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
        },
      },
    }),
  );
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

  await app.listen(runtimeSettings.port, runtimeSettings.bindHost);
   
  console.log(
    `[api] listening on http://${runtimeSettings.bindHost}:${runtimeSettings.port}/api  (docs: /api/docs)`,
  );
}

void bootstrap();
