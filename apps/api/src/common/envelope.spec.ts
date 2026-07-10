import { describe, expect, it } from 'vitest';
import { ApiProperty } from '@nestjs/swagger';
import { envelope, pageEnvelope } from './envelope';
import {
  ApiEnvelope,
  ApiListEnvelope,
  ApiPageEnvelope,
  envelopeSchema,
  pageEnvelopeSchema,
} from './api-envelope.decorator';

class SampleDto {
  @ApiProperty()
  id!: string;
}

/** 读 @nestjs/swagger 写在方法上的响应元数据（swagger/apiResponse）。 */
function apiResponseMetadata(decorator: MethodDecorator): Record<string, { schema?: unknown }> {
  class Host {
    method(): void {}
  }
  const descriptor = Object.getOwnPropertyDescriptor(Host.prototype, 'method')!;
  decorator(Host.prototype, 'method', descriptor);
  return Reflect.getMetadata('swagger/apiResponse', descriptor.value) as Record<
    string,
    { schema?: unknown }
  >;
}

describe('envelope（统一响应信封定稿）', () => {
  it('envelope 把任意值包进 { data }', () => {
    expect(envelope({ id: 'x' })).toEqual({ data: { id: 'x' } });
    expect(envelope(null)).toEqual({ data: null });
  });

  it('pageEnvelope 把服务层 camelCase 分页映射成协议 snake_case page 键', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    expect(pageEnvelope(rows, { nextCursor: '42', hasMore: true })).toEqual({
      data: rows,
      page: { next_cursor: '42', has_more: true },
    });
  });

  it('pageEnvelope 末页 next_cursor 为 null', () => {
    expect(pageEnvelope([], { nextCursor: null, hasMore: false })).toEqual({
      data: [],
      page: { next_cursor: null, has_more: false },
    });
  });
});

describe('envelopeSchema / pageEnvelopeSchema（OpenAPI 形状与运行时一致）', () => {
  it('envelopeSchema 生成 required data 的对象 schema', () => {
    expect(envelopeSchema({ type: 'string' })).toEqual({
      type: 'object',
      required: ['data'],
      properties: { data: { type: 'string' } },
    });
  });

  it('pageEnvelopeSchema 生成 data 数组 + snake_case page schema', () => {
    const schema = pageEnvelopeSchema({ $ref: '#/components/schemas/SampleDto' });
    expect(schema).toEqual({
      type: 'object',
      required: ['data', 'page'],
      properties: {
        data: { type: 'array', items: { $ref: '#/components/schemas/SampleDto' } },
        page: {
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
        },
      },
    });
  });
});

describe('ApiEnvelope / ApiPageEnvelope（swagger 装饰器接线）', () => {
  it('ApiEnvelope(Dto) 声明 200 响应，data 指向 Dto $ref', () => {
    const meta = apiResponseMetadata(ApiEnvelope(SampleDto));
    expect(meta['200']?.schema).toEqual(
      envelopeSchema({ $ref: '#/components/schemas/SampleDto' }),
    );
  });

  it('ApiEnvelope(Dto, { status: 201 }) 声明 201 响应', () => {
    const meta = apiResponseMetadata(ApiEnvelope(SampleDto, { status: 201 }));
    expect(meta['201']?.schema).toEqual(
      envelopeSchema({ $ref: '#/components/schemas/SampleDto' }),
    );
  });

  it('ApiEnvelope 也接受裸 schema 对象（无 DTO 类的 ad-hoc 响应）', () => {
    const raw = { type: 'object', properties: { ok: { type: 'boolean' } } };
    const meta = apiResponseMetadata(ApiEnvelope(raw));
    expect(meta['200']?.schema).toEqual(envelopeSchema(raw));
  });

  it('ApiPageEnvelope(Dto) 声明分页信封 200 响应', () => {
    const meta = apiResponseMetadata(ApiPageEnvelope(SampleDto));
    expect(meta['200']?.schema).toEqual(
      pageEnvelopeSchema({ $ref: '#/components/schemas/SampleDto' }),
    );
  });

  it('ApiListEnvelope(Dto) 声明无分页列表信封 { data: Dto[] }（无 page 键）', () => {
    const meta = apiResponseMetadata(ApiListEnvelope(SampleDto));
    expect(meta['200']?.schema).toEqual(
      envelopeSchema({
        type: 'array',
        items: { $ref: '#/components/schemas/SampleDto' },
      }),
    );
  });
});
