import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Response } from 'express';

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
