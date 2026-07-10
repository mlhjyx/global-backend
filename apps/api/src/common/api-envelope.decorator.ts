import { applyDecorators, Type } from '@nestjs/common';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';

/**
 * 信封形响应的 swagger 声明（与 common/envelope.ts 的运行时形状同源）。
 * code-first 单一真值：装饰器生成的 openapi.json 即前端契约，
 * 所以这里的 schema 必须与 envelope()/pageEnvelope() 的输出严格一致。
 */

/** OpenAPI schema 片段（不引 openapi 类型包，保持零依赖）。 */
type RawSchema = Record<string, unknown>;
type ModelOrSchema = Type<unknown> | RawSchema;

const PAGE_SCHEMA: RawSchema = {
  type: 'object',
  required: ['next_cursor', 'has_more'],
  properties: {
    next_cursor: {
      type: 'string',
      nullable: true,
      description: '下一页游标；null = 没有更多',
    },
    has_more: { type: 'boolean' },
  },
};

export function envelopeSchema(dataSchema: RawSchema): RawSchema {
  return {
    type: 'object',
    required: ['data'],
    properties: { data: dataSchema },
  };
}

export function pageEnvelopeSchema(itemSchema: RawSchema): RawSchema {
  return {
    type: 'object',
    required: ['data', 'page'],
    properties: {
      data: { type: 'array', items: itemSchema },
      page: PAGE_SCHEMA,
    },
  };
}

function isDtoClass(model: ModelOrSchema): model is Type<unknown> {
  return typeof model === 'function';
}

function toSchema(model: ModelOrSchema): RawSchema {
  return isDtoClass(model) ? { $ref: getSchemaPath(model) } : model;
}

interface EnvelopeOptions {
  status?: number;
  description?: string;
}

/** `{ data: Model }` 响应声明。DTO 类走 $ref（自动注册 extraModels），裸 schema 内联。 */
export function ApiEnvelope(model: ModelOrSchema, opts: EnvelopeOptions = {}): MethodDecorator {
  const decorators = [
    ApiResponse({
      status: opts.status ?? 200,
      description: opts.description,
      schema: envelopeSchema(toSchema(model)),
    }),
  ];
  if (isDtoClass(model)) decorators.unshift(ApiExtraModels(model));
  return applyDecorators(...decorators);
}

/** `{ data: Model[] }` 无分页列表信封（有界小集合，如 offerings/rules）。 */
export function ApiListEnvelope(
  model: ModelOrSchema,
  opts: Omit<EnvelopeOptions, 'status'> = {},
): MethodDecorator {
  const decorators = [
    ApiResponse({
      status: 200,
      description: opts.description,
      schema: envelopeSchema({ type: 'array', items: toSchema(model) }),
    }),
  ];
  if (isDtoClass(model)) decorators.unshift(ApiExtraModels(model));
  return applyDecorators(...decorators);
}

/** `{ data: Model[], page }` 分页信封响应声明。 */
export function ApiPageEnvelope(
  model: ModelOrSchema,
  opts: Omit<EnvelopeOptions, 'status'> = {},
): MethodDecorator {
  const decorators = [
    ApiResponse({
      status: 200,
      description: opts.description,
      schema: pageEnvelopeSchema(toSchema(model)),
    }),
  ];
  if (isDtoClass(model)) decorators.unshift(ApiExtraModels(model));
  return applyDecorators(...decorators);
}
