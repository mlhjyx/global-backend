import { beforeEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const socket = {
    setTimeout: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.set(event, handler);
      return socket;
    }),
    write: vi.fn(),
    destroy: vi.fn(),
  };
  return {
    handlers,
    socket,
    createConnection: vi.fn(() => socket),
  };
});

vi.mock('node:net', () => ({
  default: { createConnection: transport.createConnection },
}));

import { smtpRcptProbe } from './smtp-probe';

const emit = (event: string, value?: unknown): void => {
  const handler = transport.handlers.get(event);
  if (!handler) throw new Error(`missing handler ${event}`);
  handler(value);
};

describe('smtpRcptProbe transport state machine', () => {
  beforeEach(() => {
    transport.handlers.clear();
    transport.createConnection.mockClear();
    transport.socket.setTimeout.mockClear();
    transport.socket.on.mockClear();
    transport.socket.write.mockClear();
    transport.socket.destroy.mockReset();
  });

  it('runs greeting, EHLO, MAIL and each RCPT without sending DATA', async () => {
    const result = smtpRcptProbe(
      '203.0.113.10',
      'probe@example.com',
      ['one@example.com', 'two@example.com'],
      1234,
    );
    emit('connect');
    emit('data', Buffer.from('220 mx ready\r\n'));
    emit('data', Buffer.from('250-mx capabilities\r\n'));
    expect(transport.socket.write).toHaveBeenCalledTimes(1);
    emit('data', Buffer.from('250 PIPELINING\r\n'));
    emit('data', Buffer.from('250 sender ok\r\n'));
    emit('data', Buffer.from('250 first ok\r\n'));
    emit('data', Buffer.from('550 second rejected\r\n'));
    emit('data', Buffer.from('221 bye\r\n'));

    await expect(result).resolves.toEqual({
      reachable: true,
      mailFromCode: 250,
      codes: [250, 550],
    });
    expect(transport.createConnection).toHaveBeenCalledWith(25, '203.0.113.10');
    expect(transport.socket.setTimeout).toHaveBeenCalledWith(1234);
    const commands = transport.socket.write.mock.calls.map(([value]) => String(value));
    expect(commands).toEqual([
      expect.stringMatching(/^EHLO /),
      'MAIL FROM:<probe@example.com>\r\n',
      'RCPT TO:<one@example.com>\r\n',
      'RCPT TO:<two@example.com>\r\n',
      'QUIT\r\n',
    ]);
    expect(commands.join('')).not.toContain('DATA');
  });

  it('buffers multiline responses until the terminating SMTP line', async () => {
    const result = smtpRcptProbe('203.0.113.11', 'probe@example.com', []);
    emit('data', Buffer.from('220-mx.example\r\n'));
    expect(transport.socket.write).not.toHaveBeenCalled();
    emit('data', Buffer.from('220 ready\r\n'));
    emit('data', Buffer.from('250 hello\r\n'));
    emit('data', Buffer.from('250 sender\r\n'));
    emit('data', Buffer.from('221 bye\r\n'));
    await expect(result).resolves.toEqual({
      reachable: false,
      mailFromCode: 250,
      codes: [],
    });
  });

  it('returns a bounded failure on socket error before reachability', async () => {
    const result = smtpRcptProbe('203.0.113.12', 'probe@example.com', ['one@example.com']);
    emit('error', new Error('private socket diagnostic'));
    emit('close');
    await expect(result).resolves.toEqual({
      reachable: false,
      mailFromCode: null,
      codes: [],
    });
  });

  it('preserves observed reachability on timeout and handles destroy failure', async () => {
    transport.socket.destroy.mockImplementationOnce(() => {
      throw new Error('destroy failed');
    });
    const result = smtpRcptProbe('203.0.113.13', 'probe@example.com', ['one@example.com']);
    emit('connect');
    emit('timeout');
    emit('close');
    await expect(result).resolves.toEqual({
      reachable: true,
      mailFromCode: null,
      codes: [],
    });
  });
});
