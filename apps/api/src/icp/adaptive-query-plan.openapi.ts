import { applyDecorators } from '@nestjs/common';
import { ApiResponse } from '@nestjs/swagger';

function errorSchema(codes: readonly string[]) {
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

export function ApiAdaptiveQueryPlanErrors(): MethodDecorator {
  return applyDecorators(
    ApiResponse({
      status: 400,
      description: 'runId 或轮次参数校验失败',
      schema: errorSchema(['VALIDATION_ERROR']),
    }),
    ApiResponse({
      status: 403,
      description: '缺少获客写权限',
      schema: errorSchema(['SCOPE_REQUIRED', 'AUTH_CONTEXT_MISSING', 'SCOPE_METADATA_MISSING']),
    }),
    ApiResponse({
      status: 404,
      description: '当前 workspace 不可见该 DiscoveryRun 或其原查询计划',
      schema: errorSchema(['NOT_FOUND']),
    }),
    ApiResponse({
      status: 409,
      description: '任务状态、采集事实或同 run 幂等内容冲突',
      schema: errorSchema(['INVALID_STATE', 'ADAPTIVE_FACTS_UNAVAILABLE', 'IDEMPOTENCY_CONFLICT']),
    }),
  );
}
