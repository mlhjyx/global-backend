import 'reflect-metadata';
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule } from '@nestjs/swagger';
import { apiReference } from '@scalar/nestjs-api-reference';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RoleScopePolicy } from './auth/auth-scopes';
import { GlobalHttpExceptionFilter } from './common/http-exception.filter';
import { buildOpenApi } from './openapi-document';
import {
  resolveRuntimeAdmission,
  type RuntimeBootstrapSnapshot,
} from './runtime/runtime-admission';
import { unverifiedBuildIdentity } from './runtime/build-identity';

/**
 * Documentation-only metadata carrier. Nest preview mode never instantiates
 * providers/controllers, so this object cannot authorize a runtime or a dev
 * token verifier. It only satisfies static module metadata while OpenAPI is
 * generated before runtime admission.
 */
const OPENAPI_DOCUMENTATION_RUNTIME = Object.freeze({
  process: Object.freeze({
    deploymentStage: 'development',
    environment: Object.freeze({}),
    safety: Object.freeze({
      auth: Object.freeze({
        mode: 'jwks',
        jwksUri: 'https://openapi.invalid/jwks.json',
        issuer: 'https://openapi.invalid',
        audience: 'openapi-only',
        clockSkewSeconds: 60,
        workspaceClaim: 'workspace_id',
        rolesClaim: 'roles',
      }),
      model: Object.freeze({ allowStub: false }),
      storage: Object.freeze({
        available: false,
        allowUnavailable: false,
        manageVariantAttemptLifecycle: false,
        strictVariantAttemptLifecycle: true,
      }),
      processorJurisdiction: 'EU',
      siteRendererBuildIdentity: 'site-renderer@openapi-only',
      temporal: Object.freeze({
        address: '127.0.0.1:7233',
        namespace: 'default',
        connectTimeoutMs: 3_000,
      }),
    }),
  }),
  admission: Object.freeze({
    deploymentStage: 'development',
    apiBindHost: '127.0.0.1',
    port: 3_000,
    corsOrigins: Object.freeze([]),
    buildIdentity: unverifiedBuildIdentity(),
  }),
}) satisfies RuntimeBootstrapSnapshot;

function configureContractSurface(
  app: Parameters<typeof SwaggerModule.createDocument>[0],
): void {
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
}

async function exportOpenApi(): Promise<void> {
  const app = await NestFactory.create(
    AppModule.register(OPENAPI_DOCUMENTATION_RUNTIME),
    {
      preview: true,
      logger: false,
    },
  );
  try {
    configureContractSurface(app);
    const document = buildOpenApi(app);
    const out = resolve(
      __dirname,
      '../../../packages/contracts/openapi/openapi.json',
    );
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, JSON.stringify(document, null, 2));

    console.log(
      `[openapi] exported ${Object.keys(document.paths ?? {}).length} paths → ${out}`,
    );
  } finally {
    await app.close();
  }
}

async function bootstrap(): Promise<void> {
  // Documentation is a metadata-only command, not an admitted API runtime.
  // Branch before environment/build admission and before provider construction.
  if (process.argv.includes('--export-openapi')) {
    await exportOpenApi();
    return;
  }

  const runtime = resolveRuntimeAdmission(process.env);
  // Authorization policy is server-owned and must be validated from the same
  // copied runtime environment before Nest constructs any provider or socket.
  RoleScopePolicy.parse(runtime.process.environment.AUTH_ROLE_SCOPE_MAP);
  const app = await NestFactory.create(AppModule.register(runtime));
  configureContractSurface(app);
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new GlobalHttpExceptionFilter()); // 统一错误模型（PRD 11.15）

  // ── 面向前端的安全护栏 ──────────────────────────────────────────────
  app.use(helmet({ contentSecurityPolicy: false })); // API 无 HTML，关 CSP 免误伤 Swagger UI
  // CORS 白名单来自同一个已准入运行时快照；pilot/production 缺省会在建 app 前失败。
  app.enableCors({
    origin: runtime.admission.corsOrigins.length
      ? [...runtime.admission.corsOrigins]
      : true,
    credentials: true,
    exposedHeaders: ['Location', 'X-Request-Id', 'ETag'],
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

  await app.listen(runtime.admission.port, runtime.admission.apiBindHost);

  console.log(`[api] listening on http://${runtime.admission.apiBindHost}:${runtime.admission.port}/api  (docs: /api/docs)`);
}

void bootstrap();
