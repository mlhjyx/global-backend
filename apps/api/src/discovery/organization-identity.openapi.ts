import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

type IdentityErrorOptions = {
  notFound?: boolean;
  conflictCodes?: readonly string[];
  precondition?: boolean;
};

function identityErrorSchema(codes: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', enum: [...codes] },
          message: { type: 'string' },
          details: { type: 'object', additionalProperties: true },
        },
      },
    },
  };
}

/**
 * Organization Identity 读写端点的统一错误合同。
 *
 * 400/403 是所有受保护端点的实际公共边界；其余响应按操作能力显式加入，
 * 避免 Swagger 只展示成功响应而让前端猜测错误形状。
 */
export function ApiOrganizationIdentityErrors(options: IdentityErrorOptions = {}): MethodDecorator {
  const decorators: MethodDecorator[] = [
    ApiResponse({
      status: 400,
      description: '路径、查询、请求体或 If-Match 格式校验失败',
      schema: identityErrorSchema(['VALIDATION_ERROR']),
    }),
    ApiResponse({
      status: 403,
      description: '缺少身份审核权限或认证上下文',
      schema: identityErrorSchema(['SCOPE_REQUIRED', 'AUTH_CONTEXT_MISSING', 'SCOPE_METADATA_MISSING']),
    }),
  ];

  if (options.notFound) {
    decorators.push(
      ApiResponse({
        status: 404,
        description: '当前 workspace 不可见该身份资源',
        schema: identityErrorSchema(['NOT_FOUND']),
      }),
    );
  }
  if (options.conflictCodes?.length) {
    decorators.push(
      ApiResponse({
        status: 409,
        description: '幂等事实、候选企业、映射或已交付商业事实冲突',
        schema: identityErrorSchema(options.conflictCodes),
      }),
    );
  }
  if (options.precondition) {
    decorators.push(
      ApiResponse({
        status: 412,
        description: 'If-Match 已过期，须重新读取当前资源',
        schema: identityErrorSchema(['IDENTITY_REVISION_CONFLICT']),
      }),
      ApiResponse({
        status: 428,
        description: '缺少必需的 If-Match',
        schema: identityErrorSchema(['PRECONDITION_REQUIRED']),
      }),
    );
  }
  return applyDecorators(...decorators);
}
