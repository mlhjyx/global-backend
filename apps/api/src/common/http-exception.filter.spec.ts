import { BadRequestException, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from './http-exception.filter';

function responseHarness() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status, json }) }),
  };
  return { host: host as never, status, json };
}

describe('GlobalHttpExceptionFilter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through an already contracted HttpException envelope', () => {
    const response = responseHarness();
    const body = { error: { code: 'NOT_FOUND', message: 'resource not found' } };
    new GlobalHttpExceptionFilter().catch(new HttpException(body, 404), response.host);
    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith(body);
  });

  it('normalizes class-validator arrays and retains bounded details', () => {
    const response = responseHarness();
    new GlobalHttpExceptionFilter().catch(
      new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: ['workspaceId must be a UUID', 'limit must be positive'],
      }),
      response.host,
    );
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'workspaceId must be a UUID',
        details: { messages: ['workspaceId must be a UUID', 'limit must be positive'] },
      },
    });
  });

  it.each([
    [{ error: 'Not Acceptable', message: 'unsupported media' }, 'NOT_ACCEPTABLE', 'unsupported media'],
    [{ message: undefined }, 'HTTP_ERROR', 'fallback exception'],
    ['plain failure', 'HTTP_ERROR', 'fallback exception'],
  ])('normalizes non-validation HTTP responses without exposing internals', (body, code, message) => {
    const response = responseHarness();
    const exception = new HttpException(body as never, HttpStatus.NOT_ACCEPTABLE);
    Object.defineProperty(exception, 'message', { value: 'fallback exception' });
    new GlobalHttpExceptionFilter().catch(exception, response.host);
    expect(response.json).toHaveBeenCalledWith({ error: { code, message } });
  });

  it.each([new Error('internal marker content'), { diagnostic: 'private-marker' }, null])(
    'maps unknown failures to a stable internal envelope',
    (failure) => {
      const logger = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const response = responseHarness();
      new GlobalHttpExceptionFilter().catch(failure, response.host);
      expect(response.status).toHaveBeenCalledWith(500);
      expect(response.json).toHaveBeenCalledWith({
        error: { code: 'INTERNAL', message: 'internal server error' },
      });
      expect(JSON.stringify(response.json.mock.calls)).not.toContain('internal marker');
      expect(JSON.stringify(response.json.mock.calls)).not.toContain('private-marker');
      expect(logger).toHaveBeenCalledOnce();
    },
  );
});
