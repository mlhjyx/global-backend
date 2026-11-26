import { createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

export const OUTBOX_WAKEUP_CHANNEL = 'global_outbox_wakeup' as const;
const VALID_CHANNEL_RE = /^[a-z_][a-z0-9_]{0,62}$/u;

export interface PgNotifyMessage {
  readonly processId: number;
  readonly channel: string;
  readonly payload: string;
}

export interface PgNotifyListenerOptions {
  readonly connectionString: string;
  readonly channel?: string;
  readonly onNotification: (msg: PgNotifyMessage) => void;
  readonly onError?: (err: Error) => void;
  readonly onReady?: () => void;
  readonly reconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
}

function encodeCString(value: string): Buffer {
  return Buffer.concat([Buffer.from(value, 'utf8'), Buffer.from([0])]);
}

function buildStartupPacket(user: string, database: string): Buffer {
  const parts: Buffer[] = [
    Buffer.from([0, 3, 0, 0]), // protocol 3.0
    encodeCString('user'),
    encodeCString(user),
    encodeCString('database'),
    encodeCString(database),
    encodeCString('application_name'),
    encodeCString('global-outbox-wakeup'),
    Buffer.from([0]),
  ];
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(4);
  header.writeInt32BE(body.length + 4, 0);
  return Buffer.concat([header, body]);
}

function buildTaggedMessage(tag: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(tag.charCodeAt(0), 0);
  header.writeInt32BE(payload.length + 4, 1);
  return Buffer.concat([header, payload]);
}

function buildQueryMessage(sql: string): Buffer {
  return buildTaggedMessage('Q', encodeCString(sql));
}

function xorBuffers(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i += 1) {
    out[i] = a[i]! ^ b[i]!;
  }
  return out;
}

function parseScramAttrs(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const part of text.split(',')) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      map[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  return map;
}

/**
 * Minimal zero-dependency PostgreSQL v3 wire-protocol LISTEN client.
 * Supports `trust`, `cleartext`, `md5`, and `SCRAM-SHA-256` (PG16 default)
 * plus optional TLS (`sslmode=require|verify-ca|verify-full`). Used by
 * `OutboxRelayService` to achieve <1s outbox wakeup while keeping the 2s
 * polling loop as an unconditional fallback.
 */
export class PgNotifyListener {
  private readonly channel: string;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private socket?: net.Socket | tls.TLSSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private closed = false;
  private attempt = 0;

  constructor(private readonly options: PgNotifyListenerOptions) {
    const channel = options.channel ?? OUTBOX_WAKEUP_CHANNEL;
    if (!VALID_CHANNEL_RE.test(channel)) {
      throw new TypeError(`invalid PostgreSQL LISTEN channel: ${channel}`);
    }
    this.channel = channel;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
  }

  start(): void {
    if (this.closed) return;
    this.connect();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const sock = this.socket;
    this.socket = undefined;
    if (!sock) return;
    try {
      sock.write(buildTaggedMessage('X', Buffer.alloc(0)));
    } catch {
      // Ignore write-after-close errors during shutdown.
    }
    sock.destroy();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(
      this.maxReconnectDelayMs,
      this.reconnectDelayMs * Math.pow(2, Math.min(this.attempt, 6)),
    );
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private connect(): void {
    if (this.closed) return;
    let parsed: URL;
    try {
      parsed = new URL(this.options.connectionString);
    } catch {
      this.options.onError?.(new Error('PG_NOTIFY_CONNECTION_URL_INVALID'));
      return;
    }
    const host = parsed.hostname || '127.0.0.1';
    const port = parsed.port ? Number(parsed.port) : 5432;
    const user = decodeURIComponent(parsed.username || 'postgres');
    const password = decodeURIComponent(parsed.password || '');
    const database = decodeURIComponent(parsed.pathname.replace(/^\//u, '') || user);
    const sslMode = (parsed.searchParams.get('sslmode') ?? 'disable').toLowerCase();
    const requireSsl = ['require', 'verify-ca', 'verify-full'].includes(sslMode);

    const rawSocket = net.createConnection({ host, port });
    rawSocket.setKeepAlive(true, 15_000);
    this.socket = rawSocket;

    if (requireSsl) {
      rawSocket.once('connect', () => {
        const sslReq = Buffer.alloc(8);
        sslReq.writeInt32BE(8, 0);
        sslReq.writeInt32BE(80877103, 4);
        rawSocket.write(sslReq);
      });
      rawSocket.once('data', (chunk) => {
        if (chunk.length > 0 && chunk[0] === 0x53) {
          const tlsSocket = tls.connect({
            socket: rawSocket,
            ...(net.isIP(host) === 0 ? { servername: host } : {}),
            rejectUnauthorized: sslMode === 'verify-ca' || sslMode === 'verify-full',
          });
          this.socket = tlsSocket;
          this.attachProtocol(tlsSocket, user, password, database);
          tlsSocket.once('secureConnect', () => {
            tlsSocket.write(buildStartupPacket(user, database));
          });
        } else {
          rawSocket.destroy(new Error('PG_NOTIFY_TLS_REFUSED'));
        }
      });
      rawSocket.once('error', (err) => {
        this.options.onError?.(err);
      });
      rawSocket.once('close', () => {
        if (this.socket === rawSocket) {
          this.socket = undefined;
          this.scheduleReconnect();
        }
      });
      return;
    }

    this.attachProtocol(rawSocket, user, password, database);
    rawSocket.once('connect', () => {
      rawSocket.write(buildStartupPacket(user, database));
    });
  }

  private attachProtocol(
    sock: net.Socket | tls.TLSSocket,
    _user: string,
    password: string,
    _database: string,
  ): void {
    let buf = Buffer.alloc(0);
    let listeningSent = false;
    let readyNotified = false;
    let scramClientNonce = '';
    let scramClientFirstBare = '';
    let scramServerSignature = '';

    const handleMessage = (tag: number, body: Buffer): void => {
      if (tag === 0x52) {
        // 'R' Authentication
        if (body.length < 4) {
          sock.destroy(new Error('PG_NOTIFY_FRAME_TRUNCATED'));
          return;
        }
        const authType = body.readInt32BE(0);
        if (authType === 0) return; // AuthenticationOk
        if (authType === 3) {
          sock.write(buildTaggedMessage('p', encodeCString(password)));
        } else if (authType === 5) {
          // Reject legacy weak MD5 password auth; PG16 uses SCRAM-SHA-256 by default.
          sock.destroy(new Error('PG_NOTIFY_MD5_AUTH_UNSUPPORTED'));
        } else if (authType === 10) {
          // SASL (SCRAM-SHA-256)
          scramClientNonce = randomBytes(18).toString('base64');
          scramClientFirstBare = `n=,r=${scramClientNonce}`;
          const clientFirst = `n,,${scramClientFirstBare}`;
          const mech = encodeCString('SCRAM-SHA-256');
          const clientFirstBuf = Buffer.from(clientFirst, 'utf8');
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeInt32BE(clientFirstBuf.length, 0);
          sock.write(buildTaggedMessage('p', Buffer.concat([mech, lenBuf, clientFirstBuf])));
        } else if (authType === 11) {
          // AuthenticationSASLContinue
          const serverFirst = body.subarray(4).toString('utf8');
          const attrs = parseScramAttrs(serverFirst);
          const nonce = attrs.r ?? '';
          const saltB64 = attrs.s ?? '';
          const iterations = Number(attrs.i ?? '0');
          if (
            !nonce.startsWith(scramClientNonce) ||
            !saltB64 ||
            !Number.isInteger(iterations) ||
            iterations < 1 ||
            iterations > 600_000
          ) {
            sock.destroy(new Error('PG_NOTIFY_SCRAM_CHALLENGE_INVALID'));
            return;
          }
          const saltedPassword = pbkdf2Sync(password, Buffer.from(saltB64, 'base64'), iterations, 32, 'sha256');
          const clientKey = createHmac('sha256', saltedPassword).update('Client Key').digest();
          const storedKey = createHash('sha256').update(clientKey).digest();
          const clientFinalWithoutProof = `c=biws,r=${nonce}`;
          const authMessage = `${scramClientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
          const clientSignature = createHmac('sha256', storedKey).update(authMessage, 'utf8').digest();
          const clientProof = xorBuffers(clientKey, clientSignature).toString('base64');
          const serverKey = createHmac('sha256', saltedPassword).update('Server Key').digest();
          scramServerSignature = createHmac('sha256', serverKey).update(authMessage, 'utf8').digest('base64');
          const clientFinal = `${clientFinalWithoutProof},p=${clientProof}`;
          sock.write(buildTaggedMessage('p', Buffer.from(clientFinal, 'utf8')));
        } else if (authType === 12) {
          // AuthenticationSASLFinal
          const serverFinal = body.subarray(4).toString('utf8');
          const attrs = parseScramAttrs(serverFinal);
          const actualSig = Buffer.from(attrs.v ?? '', 'utf8');
          const expectedSig = Buffer.from(scramServerSignature, 'utf8');
          if (
            actualSig.length === 0 ||
            actualSig.length !== expectedSig.length ||
            !timingSafeEqual(actualSig, expectedSig)
          ) {
            sock.destroy(new Error('PG_NOTIFY_SCRAM_SIGNATURE_MISMATCH'));
          }
        } else {
          sock.destroy(new Error(`PG_NOTIFY_UNSUPPORTED_AUTH:${authType}`));
        }
      } else if (tag === 0x5a) {
        // 'Z' ReadyForQuery
        if (!listeningSent) {
          listeningSent = true;
          this.attempt = 0;
          sock.write(buildQueryMessage(`LISTEN ${this.channel}`));
        } else if (!readyNotified) {
          readyNotified = true;
          this.options.onReady?.();
        }
      } else if (tag === 0x41) {
        // 'A' NotificationResponse: int32 pid, cstring channel, cstring payload
        if (body.length < 4) {
          sock.destroy(new Error('PG_NOTIFY_FRAME_TRUNCATED'));
          return;
        }
        const processId = body.readInt32BE(0);
        const firstZero = body.indexOf(0, 4);
        if (firstZero < 0) return;
        const channel = body.subarray(4, firstZero).toString('utf8');
        const secondZero = body.indexOf(0, firstZero + 1);
        const payload =
          secondZero > firstZero
            ? body.subarray(firstZero + 1, secondZero).toString('utf8')
            : body.subarray(firstZero + 1).toString('utf8');
        this.options.onNotification({ processId, channel, payload });
      } else if (tag === 0x45) {
        // 'E' ErrorResponse
        const message = body.toString('utf8').replace(/\0/gu, ' ').trim().slice(0, 200);
        this.options.onError?.(new Error(`PG_NOTIFY_ERROR:${message}`));
      }
    };

    const maxFrameBytes = 1024 * 1024;
    sock.on('data', (chunk) => {
      if (buf.length + chunk.length > maxFrameBytes) {
        sock.destroy(new Error('PG_NOTIFY_FRAME_TOO_LARGE'));
        return;
      }
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 5) {
        const tag = buf[0]!;
        const len = buf.readInt32BE(1);
        if (len < 4 || len > maxFrameBytes) {
          sock.destroy(new Error('PG_NOTIFY_FRAME_INVALID'));
          return;
        }
        if (buf.length < 1 + len) break;
        const body = buf.subarray(5, 1 + len);
        buf = buf.subarray(1 + len);
        try {
          handleMessage(tag, body);
        } catch (err) {
          sock.destroy(err instanceof Error ? err : new Error(String(err)));
          return;
        }
      }
    });

    sock.on('error', (err) => {
      this.options.onError?.(err);
    });

    sock.on('close', () => {
      if (this.socket === sock) {
        this.socket = undefined;
        this.scheduleReconnect();
      }
    });
  }
}
