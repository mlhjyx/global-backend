import { readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOptionalOutboxWakeup } from './outbox-wakeup';
import { OUTBOX_WAKEUP_CHANNEL, PgNotifyListener } from './pg-notify-listener';

describe('M10-PR2 Block 4: Outbox PG NOTIFY wakeup and kb.service defense-in-depth', () => {
  it('validates PG NOTIFY channel name and rejects SQL injection attempts', () => {
    expect(OUTBOX_WAKEUP_CHANNEL).toBe('global_outbox_wakeup');
    expect(
      () =>
        new PgNotifyListener({
          connectionString: 'postgresql://u:p@127.0.0.1:5432/db',
          channel: 'bad; DROP TABLE outbox_event;',
          onNotification: vi.fn(),
        }),
    ).toThrow(/invalid PostgreSQL LISTEN channel/);
  });

  it('keeps PG NOTIFY wakeup disabled when db is mock-injected or OUTBOX_PG_NOTIFY_DISABLED=true', () => {
    const onWakeup = vi.fn();
    expect(
      createOptionalOutboxWakeup(false, onWakeup, {
        OUTBOX_RELAY_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
      }),
    ).toBeUndefined();
    expect(
      createOptionalOutboxWakeup(true, onWakeup, {
        OUTBOX_RELAY_DATABASE_URL: 'postgresql://u:p@127.0.0.1:5432/db',
        OUTBOX_PG_NOTIFY_DISABLED: 'true',
      }),
    ).toBeUndefined();
  });

  it('explicitly binds c.workspace_id and d.workspace_id in kb.service.ts vector search SQL', () => {
    const source = readFileSync(
      join(import.meta.dirname, '../site-builder/kb.service.ts'),
      'utf8',
    );
    expect(source).toContain('AND c.workspace_id = ${ctx.workspaceId}::uuid');
    expect(source).toContain('AND d.workspace_id = ${ctx.workspaceId}::uuid');
  });

  it('handles truncated PG wire frames gracefully without throwing uncaught RangeError', async () => {
    const server = net.createServer((socket) => {
      socket.once('data', () => {
        // Send truncated 'R' authentication frame: header length = 5 (only 1 body byte instead of >= 4)
        const malformed = Buffer.from([0x52, 0x00, 0x00, 0x00, 0x05, 0x00]);
        socket.write(malformed);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as net.AddressInfo;

    const errors: Error[] = [];
    let resolveError!: () => void;
    const errorSeen = new Promise<void>((resolve) => {
      resolveError = resolve;
    });
    const listener = new PgNotifyListener({
      connectionString: `postgresql://u:p@127.0.0.1:${addr.port}/db`,
      reconnectDelayMs: 60_000,
      onNotification: vi.fn(),
      onError: (err) => {
        errors.push(err);
        resolveError();
      },
    });
    try {
      listener.start();
      await Promise.race([
        errorSeen,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('EXPECTED_TRUNCATED_FRAME_ERROR')), 2_000),
        ),
      ]);
      expect(errors[0]?.message).toContain('PG_NOTIFY_FRAME_TRUNCATED');
    } finally {
      await listener.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
