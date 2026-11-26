import { ArgumentsHost, BadRequestException, HttpException, Logger } from '@nestjs/common';
import { PLATFORM_EXECUTION_TECHNICAL_QUOTE_HTTP_PATH } from '@global/contracts/platform-authority';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalHttpExceptionFilter } from './http-exception.filter';
import { PLATFORM_AUTHORITY_TARGET_LOOKUP_PATH } from '../platform-authority/platform-target-lookup.service';
import { PLATFORM_TARGET_LOOKUP_HTTP_ERRORS } from '../platform-authority/platform-target-lookup.openapi';

function responseHost(
  originalUrl: unknown = '/api/v1/example?token=canary',
  extra: { method?: string; route?: { path: string }; headers?: Record<string, unknown> } = {},
) {
  const response = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
  response.status.mockReturnValue(response);
  const host = {
    switchToHttp: () => ({
      getResponse: () => response,
      getRequest: () => ({ originalUrl, ...extra }),
    }),
  } as unknown as ArgumentsHost;
  return { response, host };
}

afterEach(() => vi.restoreAllMocks());

describe('unknown HTTP exception diagnostics', () => {
  it.each([
    [400, 'invalid'], [413, 'invalid'], [415, 'invalid'], [401, 'denied'],
    [403, 'scope'], [404, 'unavailable'], [429, 'rateLimited'], [503, 'unavailable'],
    [500, 'unavailable'], [302, 'unavailable'],
  ] as const)('closes target lookup HTTP %s diagnostics without leaking input', (status, kind) => {
    const { response, host } = responseHost(`${PLATFORM_AUTHORITY_TARGET_LOOKUP_PATH}?secret=canary`);
    const expected = PLATFORM_TARGET_LOOKUP_HTTP_ERRORS[kind];
    new GlobalHttpExceptionFilter().catch(new HttpException({ error: { code: 'untrusted', message: 'private-canary' } }, status), host);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.status).toHaveBeenCalledWith(expected.status);
    expect(response.json).toHaveBeenCalledWith({ error: { code: expected.code, message: expected.message } });
  });
  it('does not trust a forged business NOT_FOUND body or inspect its getter', () => {
    const { response, host } = responseHost(PLATFORM_AUTHORITY_TARGET_LOOKUP_PATH);
    const forged = new HttpException({ error: { code: 'PLATFORM_AUTHORITY_TARGET_LOOKUP_NOT_FOUND', message: 'platform authority target was not found' } }, 404);
    new GlobalHttpExceptionFilter().catch(forged, host);
    expect(response.status).toHaveBeenCalledWith(503);
    expect(response.json).toHaveBeenCalledWith({ error: { code: 'PLATFORM_AUTHORITY_TARGET_LOOKUP_UNAVAILABLE', message: 'platform target lookup is unavailable' } });
    const bodyAccess = vi.spyOn(forged, 'getResponse').mockImplementation(() => { throw new Error('private getter'); });
    expect(() => new GlobalHttpExceptionFilter().catch(forged, host)).not.toThrow();
    expect(bodyAccess).not.toHaveBeenCalled();
  });
  it.each([PLATFORM_AUTHORITY_TARGET_LOOKUP_PATH, `${PLATFORM_AUTHORITY_TARGET_LOOKUP_PATH}/`, PLATFORM_AUTHORITY_TARGET_LOOKUP_PATH.toUpperCase()])('sanitizes parser failures before the lookup guard for %s', path => {
    const { response, host } = responseHost(path);
    const parser = { type: 'entity.parse.failed', status: 400, message: 'raw-private-body' };
    new GlobalHttpExceptionFilter().catch(parser, host);
    expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({ error: { code: PLATFORM_TARGET_LOOKUP_HTTP_ERRORS.invalid.code, message: PLATFORM_TARGET_LOOKUP_HTTP_ERRORS.invalid.message } });
  });
  it('emits redacted diagnostic frames for unknown 500s without leaking cause, email, tokens, or query strings', () => {
    const log = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { response, host } = responseHost('/api/v1/example/raw-path-canary?token=canary', {
      method: 'POST',
      route: { path: '/api/v1/example/:exampleId' },
      headers: { 'x-request-id': 'client-control-canary' },
    });
    const error = Object.assign(
      new Error('raw-message-canary {"phone":"+1 202 555 0142"}', {
        cause: new Error('private-body-canary'),
      }),
      { code: 'ECONNRESET' },
    );
    new GlobalHttpExceptionFilter().catch(error, host);
    expect(log).toHaveBeenCalledTimes(1);
    const logged = log.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(logged).toMatchObject({
      code: 'INTERNAL',
      status: 500,
      errorName: 'Error',
      path: '/api/v1/example/:exampleId',
      method: 'POST',
      errorCode: 'ECONNRESET',
    });
    expect(JSON.stringify(logged)).not.toMatch(/raw-message-canary|raw-path-canary|client-control-canary|555 0142/);
    expect(JSON.stringify(logged)).not.toContain('private-body-canary');
    expect(Array.isArray(logged.topFrames)).toBe(true);
    expect(logged.topFrames).toEqual(expect.arrayContaining([
      expect.stringMatching(/^common\/http-exception\.filter\.spec\.ts:\d+:\d+$/u),
    ]));
    expect((logged.topFrames as string[]).length).toBeLessThanOrEqual(5);
    expect(response.status).toHaveBeenCalledWith(500);
    expect(response.json).toHaveBeenCalledWith({ error: { code: 'INTERNAL', message: 'internal server error' } });
  });

  it.each(['stack', 'toString', 'name', 'message'] as const)('does not inspect an untrusted %s accessor', (field) => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { response, host } = responseHost();
    const read = vi.fn(() => { throw new Error('diagnostic accessor must not run'); });
    const error = new Error('canary');
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
    expect(log.mock.calls).toEqual([[{
      code: 'INTERNAL',
      status: 500,
      errorName: 'Unknown',
      path: null,
      method: null,
      errorCode: null,
      topFrames: [],
    }]]);
    expect(response.status).toHaveBeenCalledWith(500);
  });
});
