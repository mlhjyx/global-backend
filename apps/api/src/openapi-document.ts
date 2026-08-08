import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';

type OpenApiOperation = NonNullable<OpenAPIObject['paths'][string]['get']>;

const AUTH_ERROR_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
};

function authErrorResponse(description: string, example: Readonly<Record<string, unknown>>) {
  return {
    description,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/AuthErrorResponse' },
        example,
      },
    },
  };
}

const UNAUTHORIZED_RESPONSE = authErrorResponse('Bearer token is missing or invalid.', {
  error: { code: 'TOKEN_INVALID', message: 'token verification failed' },
});
const FORBIDDEN_RESPONSE = authErrorResponse('Authenticated role lacks one or more required scopes.', {
  error: {
    code: 'INSUFFICIENT_SCOPE',
    message: 'the authenticated role is not authorized for this operation',
    details: { requiredScopes: ['acquisition:read'] },
  },
});
const UNAUTHORIZED_REFERENCE = { $ref: '#/components/responses/AuthUnauthorized' };
const FORBIDDEN_REFERENCE = { $ref: '#/components/responses/AuthForbidden' };

function hasBearerSecurity(value: unknown): value is OpenApiOperation {
  return (
    typeof value === 'object' &&
    value !== null &&
    'operationId' in value &&
    Array.isArray((value as OpenApiOperation).security) &&
    ((value as OpenApiOperation).security?.length ?? 0) > 0
  );
}

function withAuthErrorContract(document: OpenAPIObject): OpenAPIObject {
  const paths = Object.fromEntries(
    Object.entries(document.paths).map(([path, item]) => [
      path,
      Object.fromEntries(
        Object.entries(item).map(([key, value]) => {
          if (!hasBearerSecurity(value)) return [key, value];
          return [
            key,
            {
              ...value,
              responses: {
                ...value.responses,
                '401': UNAUTHORIZED_REFERENCE,
                '403': FORBIDDEN_REFERENCE,
              },
            },
          ];
        }),
      ),
    ]),
  ) as OpenAPIObject['paths'];

  return {
    ...document,
    paths,
    components: {
      ...document.components,
      schemas: {
        ...document.components?.schemas,
        AuthErrorResponse: AUTH_ERROR_RESPONSE_SCHEMA,
      },
      responses: {
        ...document.components?.responses,
        AuthUnauthorized: UNAUTHORIZED_RESPONSE,
        AuthForbidden: FORBIDDEN_RESPONSE,
      },
    },
  };
}

/** code-first OpenAPI document (the repository's single REST contract source). */
export function buildOpenApi(app: INestApplication) {
  const config = new DocumentBuilder()
    .setTitle('Global API')
    .setDescription('出海企业 AI 全球客户开发与增长平台 · 后端 API（前端接入见 packages/contracts/INTEGRATION.md）')
    .setVersion('0.1.0')
    .addServer('/', '同源部署（相对路径；具体 host 由部署环境决定）')
    .addTag('Companies')
    .addTag('Claims')
    .addTag('ICP')
    .addTag('Discovery')
    .addTag('Leads')
    .addTag('Events')
    .addTag('System')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  const buildStatus = document.components?.schemas?.BuildStatusResponseDto;
  if (buildStatus && !('$ref' in buildStatus)) {
    // ApiProperty uses `required` both for the parent property flag and the
    // nested object's required field list. Keep the closed nested schema and
    // restore the pre-existing required+nullable response key explicitly.
    buildStatus.required = Array.from(new Set([...(buildStatus.required ?? []), 'costSummary']));
  }
  return withAuthErrorContract(document);
}
