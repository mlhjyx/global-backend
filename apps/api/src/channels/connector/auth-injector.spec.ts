import { describe, expect, it } from 'vitest';
import { resolveChannelAuth } from './auth-injector';
import { ChannelRuntimeError } from './errors';
import type { ChannelSecretResolver, ResolvedChannelSecret } from './secret-resolver';

const SECRET_VALUES: Record<string, string> = {
  'channel/acme/api-key': 'api-key-value',
  'channel/acme/user': 'user-name',
  'channel/acme/pass': 'p@ss:word',
};

const resolver: ChannelSecretResolver = {
  async resolve(ref: string): Promise<ResolvedChannelSecret> {
    const value = SECRET_VALUES[ref];
    if (value === undefined) throw new Error(`missing ${ref}`);
    return { value, version: 1, provider: 'env' };
  },
};

describe('认证注入（值不进入返回值以外的任何输出）', () => {
  it('none：不注入任何头/参数', async () => {
    await expect(resolveChannelAuth({ type: 'none' }, resolver)).resolves.toEqual({ headers: {}, query: {} });
    await expect(resolveChannelAuth(undefined, resolver)).resolves.toEqual({ headers: {}, query: {} });
  });

  it('apiKey + query：参数名来自 auth.name', async () => {
    const material = await resolveChannelAuth(
      { type: 'apiKey', secretRef: 'channel/acme/api-key', in: 'query', name: 'api_key' },
      resolver,
    );
    expect(material.query).toEqual({ api_key: 'api-key-value' });
    expect(material.headers).toEqual({});
  });

  it('apiKey + header：默认 Authorization 头，可自定义头名', async () => {
    await expect(
      resolveChannelAuth({ type: 'apiKey', secretRef: 'channel/acme/api-key' }, resolver),
    ).resolves.toEqual({ headers: { Authorization: 'api-key-value' }, query: {} });
    await expect(
      resolveChannelAuth({ type: 'apiKey', secretRef: 'channel/acme/api-key', name: 'X-Api-Key' }, resolver),
    ).resolves.toEqual({ headers: { 'X-Api-Key': 'api-key-value' }, query: {} });
  });

  it('bearer：Authorization: Bearer <value>', async () => {
    await expect(
      resolveChannelAuth({ type: 'bearer', secretRef: 'channel/acme/api-key' }, resolver),
    ).resolves.toEqual({ headers: { Authorization: 'Bearer api-key-value' }, query: {} });
  });

  it('header：自定义头名必填', async () => {
    await expect(
      resolveChannelAuth({ type: 'header', secretRef: 'channel/acme/api-key', name: 'X-Custom' }, resolver),
    ).resolves.toEqual({ headers: { 'X-Custom': 'api-key-value' }, query: {} });
    await expect(
      resolveChannelAuth({ type: 'header', secretRef: 'channel/acme/api-key' }, resolver),
    ).rejects.toMatchObject({ code: 'CHANNEL_MANIFEST_INVALID' });
  });

  it('basic：base64(user:pass)', async () => {
    const material = await resolveChannelAuth(
      { type: 'basic', usernameRef: 'channel/acme/user', passwordRef: 'channel/acme/pass' },
      resolver,
    );
    expect(material.headers.Authorization).toBe(`Basic ${Buffer.from('user-name:p@ss:word').toString('base64')}`);
    expect(material.query).toEqual({});
  });

  it('oauth2_client_credentials：v1 不执行，明确 CHANNEL_AUTH_UNSUPPORTED', async () => {
    const error = await resolveChannelAuth(
      {
        type: 'oauth2_client_credentials',
        tokenUrl: 'https://auth.example/token',
        clientIdRef: 'channel/acme/user',
        clientSecretRef: 'channel/acme/pass',
      },
      resolver,
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ChannelRuntimeError);
    expect((error as ChannelRuntimeError).code).toBe('CHANNEL_AUTH_UNSUPPORTED');
    expect(String((error as Error).message)).not.toContain('p@ss:word');
  });

  it('禁止把凭据注入受保护头（host/content-length/cookie 等）', async () => {
    for (const name of ['Host', 'Content-Length', 'Cookie', 'Connection']) {
      const error = await resolveChannelAuth(
        { type: 'header', secretRef: 'channel/acme/api-key', name },
        resolver,
      ).catch((cause: unknown) => cause);
      expect((error as ChannelRuntimeError).code, name).toBe('CHANNEL_MANIFEST_INVALID');
    }
  });

  it('密钥值不出现在错误信息中', async () => {
    const error = await resolveChannelAuth(
      { type: 'apiKey', secretRef: 'channel/acme/missing', in: 'query', name: 'api_key' },
      resolver,
    ).catch((cause: unknown) => cause);
    expect(String(error)).not.toContain('api-key-value');
  });
});
