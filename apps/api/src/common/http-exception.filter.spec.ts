import { ArgumentsHost, BadRequestException, HttpException, Logger } from '@nestjs/common';
import { PLATFORM_EXECUTION_TECHNICAL_QUOTE_HTTP_PATH } from '@global/contracts/platform-authority';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from './http-exception.filter';

function responseHost(originalUrl: unknown = '/api/v1/example?token=canary') {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ originalUrl }),
    }),
  } as unknown as ArgumentsHost;
  return { response, host };
}

afterEach(() => vi.restoreAllMocks());

describe('unknown HTTP exception diagnostics', () => {
  it('emits only a fixed diagnostic for a secret-bearing stack and cause', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { response, host } = responseHost();
    const error = new Error('synthetic-token-canary', { cause: new Error('private-body-canary') });
    new GlobalHttpExceptionFilter().catch(error, host);
    expect(log.mock.calls).toEqual([[{ code: 'INTERNAL', status: 500 }]]);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });

  it.each(['stack', 'toString'] as const)('does not inspect an untrusted %s accessor', (field) => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { response, host } = responseHost();
    const read = vi.fn(() => { throw new Error('diagnostic accessor must not run'); });
    const error = field === 'stack' ? new Error('canary') : {};
    Object.defineProperty(error, field, { get: read });
    expect(() => new GlobalHttpExceptionFilter().catch(error, host)).not.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(500);
  });

  it('preserves explicit validation responses', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { response, host } = responseHost();
    const body = { error: { code: 'INPUT_REQUIRED', message: 'name is required' } };
    new GlobalHttpExceptionFilter().catch(new BadRequestException(body), host);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith(body);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    [400, { message: ['name required', 'name too short'], error: 'Bad Request' },
      { code: 'VALIDATION_ERROR', message: 'name required', details: { messages: ['name required', 'name too short'] } }],
    [404, { message: 'record missing', error: 'Not Found' }, { code: 'NOT_FOUND', message: 'record missing' }],
    [403, 'access denied', { code: 'HTTP_ERROR', message: 'access denied' }],
  ])('preserves normalized HTTP %s responses', (status, body, error) => {
    const { response, host } = responseHost();
    new GlobalHttpExceptionFilter().catch(new HttpException(body, status), host);
    expect(response.status).toHaveBeenCalledWith(status);
    expect(response.json).toHaveBeenCalledWith({ error });
  });

  it('keeps technical quote rate-limit diagnostics fixed', () => {
    const { response, host } = responseHost(PLATFORM_EXECUTION_TECHNICAL_QUOTE_HTTP_PATH);
    new GlobalHttpExceptionFilter().catch(new HttpException('untrusted rate-limit text', 429), host);
    expect(response.status).toHaveBeenCalledWith(429);
    expect(response.json).toHaveBeenCalledWith({ error: {
      code: 'PLATFORM_TECHNICAL_QUOTE_RATE_LIMITED', message: 'platform technical quote rate limit exceeded',
    } });
  });

  it.each([null, 'synthetic secret string', Object.create(null)])('handles non-Error failures with no request URL', (failure) => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { response, host } = responseHost(null);
    new GlobalHttpExceptionFilter().catch(failure, host);
    expect(log.mock.calls).toEqual([[{ code: 'INTERNAL', status: 500 }]]);
    expect(response.status).toHaveBeenCalledWith(500);
  });
});
