import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';
import { PLATFORM_EXECUTION_TECHNICAL_QUOTE_HTTP_PATH } from '@global/contracts/platform-authority';

const RAW_BODY_PARSER_ERROR_TYPES = new Set([
  'charset.unsupported',
  'encoding.unsupported',
  'entity.parse.failed',
  'entity.too.large',
  'entity.verify.failed',
]);

function dataProperty(value: object, name: string): unknown {
  let current: object | null = value;
  for (let depth = 0; current !== null && depth < 4; depth += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, name);
    if (descriptor) {
      return Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function boundedHttpStatus(exception: unknown): number | null {
  try {
    if (exception instanceof HttpException) return exception.getStatus();
    if (exception === null || typeof exception !== 'object') return null;
    const type = dataProperty(exception, 'type');
    const status =
      dataProperty(exception, 'status') ??
      dataProperty(exception, 'statusCode');
    if (
      typeof type !== 'string' ||
      !RAW_BODY_PARSER_ERROR_TYPES.has(type) ||
      typeof status !== 'number' ||
      ![
        HttpStatus.BAD_REQUEST,
        HttpStatus.PAYLOAD_TOO_LARGE,
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
      ].includes(status)
    ) {
      return null;
    }
    return status;
  } catch {
    return null;
  }
}

/**
 * 统一错误模型（PRD 11.15 / packages/contracts README）：
 * 所有错误响应都是 { error: { code, message, details? } }。
 * 业务代码抛的 HttpException 已按该形状构造则透传；其余（含 class-validator
 * 的 400 数组、未知异常）在此归一。
 */
@Catch()
export class GlobalHttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('HttpError');

  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const req = host.switchToHttp().getRequest<{ originalUrl?: unknown }>();
    const originalUrl = req?.originalUrl;
    const requestPath =
      typeof originalUrl === 'string' ? originalUrl.split('?', 1)[0] : null;
    const status = boundedHttpStatus(exception);
    if (requestPath === PLATFORM_EXECUTION_TECHNICAL_QUOTE_HTTP_PATH) {
      if (
        status === HttpStatus.BAD_REQUEST ||
        status === HttpStatus.PAYLOAD_TOO_LARGE ||
        status === HttpStatus.UNSUPPORTED_MEDIA_TYPE
      ) {
        res.status(HttpStatus.BAD_REQUEST).json({
          error: {
            code: 'PLATFORM_EXECUTION_BUDGET_QUOTE_INVALID',
            message: 'platform technical quote request is invalid',
          },
        });
        return;
      }
      if (status === HttpStatus.TOO_MANY_REQUESTS) {
        res.status(HttpStatus.TOO_MANY_REQUESTS).json({
          error: {
            code: 'PLATFORM_TECHNICAL_QUOTE_RATE_LIMITED',
            message: 'platform technical quote rate limit exceeded',
          },
        });
        return;
      }
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      // 已按契约构造（error 是对象）→ 透传；class-validator 的 error 是字符串 → 归一
      if (
        typeof body === 'object' &&
        body !== null &&
        typeof (body as Record<string, unknown>).error === 'object'
      ) {
        res.status(status).json(body);
        return;
      }
      // class-validator: { statusCode, message: string[] | string, error }
      const raw = body as { message?: string | string[]; error?: string };
      const messages = Array.isArray(raw.message) ? raw.message : [raw.message ?? exception.message];
      res.status(status).json({
        error: {
          code: status === 400 ? 'VALIDATION_ERROR' : (raw.error ?? 'HTTP_ERROR').toUpperCase().replace(/\s+/g, '_'),
          message: messages[0] ?? 'request failed',
          ...(messages.length > 1 ? { details: { messages } } : {}),
        },
      });
      return;
    }

    this.logger.error(String(exception instanceof Error ? exception.stack : exception));
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: { code: 'INTERNAL', message: 'internal server error' },
    });
  }
}
