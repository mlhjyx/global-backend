import { describe, expect, it } from 'vitest';
import { resolveOutboxRelayDatabaseUrl } from './outbox-relay.service';

function env(values: Record<string, string | undefined>): NodeJS.ProcessEnv {
  return values as NodeJS.ProcessEnv;
}

describe('Outbox relay owner database admission', () => {
  it('fails closed without an explicit relay or owner URL and never falls back to ordinary application URLs', () => {
    const ordinarySecret = 'ordinary-app-password';

    expect(() =>
      resolveOutboxRelayDatabaseUrl(
        env({
          NODE_ENV: 'production',
          APP_DATABASE_URL: `postgresql://app_user:${ordinarySecret}@db.example/global`,
          DATABASE_URL: `postgresql://app_user:${ordinarySecret}@db.example/global`,
        }),
      ),
    ).toThrow('OUTBOX_RELAY_DATABASE_URL or OWNER_DATABASE_URL');

    try {
      resolveOutboxRelayDatabaseUrl(
        env({ DATABASE_URL: `postgresql://app_user:${ordinarySecret}@db.example/global` }),
      );
      throw new Error('expected relay database admission to fail');
    } catch (error) {
      expect(String(error)).not.toContain(ordinarySecret);
    }
  });

  it('prefers the relay-specific URL and permits the explicit owner fallback', () => {
    const relayUrl = 'postgresql://relay_owner:relay-secret@db.example/global';
    const ownerUrl = 'postgresql://platform_owner:owner-secret@db.example/global';

    expect(
      resolveOutboxRelayDatabaseUrl(
        env({ OUTBOX_RELAY_DATABASE_URL: relayUrl, OWNER_DATABASE_URL: ownerUrl }),
      ),
    ).toBe(relayUrl);
    expect(resolveOutboxRelayDatabaseUrl(env({ OWNER_DATABASE_URL: ownerUrl }))).toBe(ownerUrl);
  });

  it('rejects app_user and malformed explicit URLs without exposing credentials', () => {
    const appSecret = 'do-not-log-app-secret';
    const malformedSecret = 'do-not-log-malformed-secret';

    for (const candidate of [
      `postgresql://app_user:${appSecret}@db.example/global`,
      `postgresql://app%5Fuser:${appSecret}@db.example/global`,
      `not-a-postgres-url-${malformedSecret}`,
    ]) {
      try {
        resolveOutboxRelayDatabaseUrl(env({ OUTBOX_RELAY_DATABASE_URL: candidate }));
        throw new Error('expected relay database admission to fail');
      } catch (error) {
        expect(String(error)).toContain('Outbox relay database configuration rejected');
        expect(String(error)).not.toContain(appSecret);
        expect(String(error)).not.toContain(malformedSecret);
      }
    }
  });

  it('rejects an explicit URL that aliases APP_DATABASE_URL', () => {
    const explicit = 'postgresql://misnamed_role:relay-secret@db.example:5432/global?schema=public';
    const application = 'postgresql://misnamed_role:app-secret@db.example/global';

    expect(() =>
      resolveOutboxRelayDatabaseUrl(
        env({ OUTBOX_RELAY_DATABASE_URL: explicit, APP_DATABASE_URL: application }),
      ),
    ).toThrow('Outbox relay database configuration rejected');
  });
});
