import { request } from "node:https";
import type { ClientRequest } from "node:http";
import { randomBytes } from "node:crypto";
import {
  verifyMachineTokenResponse,
  type MachineTokenTrust,
  type VerifiedMachineToken,
} from "./machine-token-verifier";
import { createStrictJwtPrimitives } from "./strict-jwt-primitives";

export interface MachineTokenClientConfiguration extends Omit<
  MachineTokenTrust,
  "jwks"
> {
  readonly endpoint: string;
  readonly jwksUri: string;
  readonly ca: Buffer;
  readonly certificate: Buffer;
  readonly privateKey: Buffer;
  readonly runtimeIdentity: string;
}

export class MachineTokenUnavailableError extends Error {
  constructor() {
    super("PLATFORM_MACHINE_TOKEN_UNAVAILABLE");
  }
}

export class MachineTokenClient {
  private readonly config: MachineTokenClientConfiguration | null;
  private cached: VerifiedMachineToken | undefined;
  private pending: Promise<VerifiedMachineToken> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private expiryTimer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<
    (credential: VerifiedMachineToken | null) => void
  >();
  private closed = false;
  private lastObservedSecond = 0;
  private readonly requests = new Set<ClientRequest>();

  constructor(
    config: MachineTokenClientConfiguration,
    private readonly now: () => number = Date.now,
  ) {
    let configured: MachineTokenClientConfiguration | null = null;
    try {
      const endpoint = checkedUrl(config.endpoint);
      checkedUrl(config.jwksUri);
      if (
        endpoint.pathname !== "/api/internal/v1/platform-machine-tokens" ||
        !/^[0-9a-f]{64}$/u.test(config.runtimeIdentity) ||
        !/^[0-9a-f]{64}$/u.test(config.configurationRevision) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(config.subject) ||
        !config.issuer ||
        !config.audience ||
        ![
          "capability-request",
          "temporal-platform-worker",
          "temporal-customer-worker",
          "temporal-customer-client",
        ].includes(config.profile) ||
        [config.ca, config.certificate, config.privateKey].some(
          (bytes) =>
            !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 65536,
        )
      )
        throw new MachineTokenUnavailableError();
      configured = Object.freeze({
        ...config,
        ca: Buffer.from(config.ca),
        certificate: Buffer.from(config.certificate),
        privateKey: Buffer.from(config.privateKey),
      });
    } catch {
      /* Invalid configuration exposes no credential and never falls back. */
    }
    this.config = configured;
  }

  async getToken(): Promise<string> {
    if (this.closed || !this.config) throw new MachineTokenUnavailableError();
    const now = this.seconds();
    if (this.cached && now >= this.cached.expiresAt) this.invalidate();
    if (this.cached && this.cached.expiresAt - now > 60)
      return this.cached.token;
    try {
      return (await this.refresh()).token;
    } catch {
      if (!this.closed && this.cached && this.seconds() < this.cached.expiresAt)
        return this.cached.token;
      throw new MachineTokenUnavailableError();
    }
  }

  currentToken(): string {
    if (this.closed || !this.config) throw new MachineTokenUnavailableError();
    if (this.cached && this.seconds() < this.cached.expiresAt)
      return this.cached.token;
    this.invalidate();
    throw new MachineTokenUnavailableError();
  }

  subscribe(
    listener: (credential: VerifiedMachineToken | null) => void,
  ): () => void {
    if (this.closed || !this.config) throw new MachineTokenUnavailableError();
    this.listeners.add(listener);
    try {
      const value =
        this.cached && this.seconds() < this.cached.expiresAt
          ? this.cached
          : null;
      listener(value);
    } catch {
      this.close();
      throw new MachineTokenUnavailableError();
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cached = undefined;
    clearTimeout(this.timer);
    clearTimeout(this.expiryTimer);
    this.emit(null);
    this.listeners.clear();
    for (const active of this.requests)
      active.destroy(new MachineTokenUnavailableError());
    this.requests.clear();
    this.config?.privateKey.fill(0);
  }

  private invalidate(): void {
    if (!this.cached) return;
    this.cached = undefined;
    clearTimeout(this.expiryTimer);
    this.emit(null);
  }

  private emit(credential: VerifiedMachineToken | null): void {
    let failed = false;
    for (const listener of [...this.listeners]) {
      if (credential && this.closed) break;
      try {
        listener(credential);
      } catch {
        failed = true;
      }
    }
    if (failed && credential) this.close();
  }

  private seconds(): number {
    const now = this.now();
    if (!Number.isFinite(now) || now < 0) {
      this.close();
      throw new MachineTokenUnavailableError();
    }
    const seconds = Math.floor(now / 1000);
    if (seconds < this.lastObservedSecond) {
      this.close();
      throw new MachineTokenUnavailableError();
    }
    this.lastObservedSecond = seconds;
    return seconds;
  }

  private refresh(): Promise<VerifiedMachineToken> {
    if (this.closed || !this.config)
      return Promise.reject(new MachineTokenUnavailableError());
    if (this.pending) return this.pending;
    this.pending = this.acquire()
      .then((token) => {
        if (this.closed || this.seconds() >= token.expiresAt)
          throw new MachineTokenUnavailableError();
        this.cached = token;
        clearTimeout(this.expiryTimer);
        this.expiryTimer = setTimeout(
          () => this.invalidate(),
          Math.max(1, token.expiresAt * 1000 - this.now()),
        );
        this.expiryTimer.unref();
        this.emit(token);
        if (this.closed) throw new MachineTokenUnavailableError();
        this.schedule(
          Math.max(1, token.expiresAt - this.seconds() - 60) * 1000,
        );
        return token;
      })
      .catch(() => {
        if (!this.closed) this.schedule(10_000);
        throw new MachineTokenUnavailableError();
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }

  private schedule(milliseconds: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.refresh().catch(() => undefined);
    }, milliseconds);
    this.timer.unref();
  }

  private async acquire(): Promise<VerifiedMachineToken> {
    const config = this.config!;
    const deadline = performance.now() + 2000;
    const nonce = randomBytes(16).toString("hex");
    const body = Buffer.from(
      JSON.stringify({ profile: config.profile, nonce }),
    );
    if (body.byteLength > 1024) throw new MachineTokenUnavailableError();
    const response = await this.exchange(
      config.endpoint,
      "POST",
      body,
      24 * 1024,
      deadline,
    );
    const keyBytes = await this.exchange(
      config.jwksUri,
      "GET",
      undefined,
      32 * 1024,
      deadline,
    );
    const { ClosedJwtObjectParser: Parser, strictUtf8 } =
      createStrictJwtPrimitives(
        MachineTokenUnavailableError,
        MachineTokenUnavailableError,
      );
    const jwks = new Parser(strictUtf8(keyBytes)).parseJwks();
    const token = await verifyMachineTokenResponse(
      response,
      nonce,
      { ...config, jwks },
      this.seconds(),
    );
    if (
      performance.now() >= deadline ||
      this.closed ||
      this.seconds() >= token.expiresAt
    )
      throw new MachineTokenUnavailableError();
    return token;
  }

  private exchange(
    url: string,
    method: "GET" | "POST",
    body: Buffer | undefined,
    maximum: number,
    deadline: number,
  ): Promise<Buffer> {
    const config = this.config!;
    return new Promise((resolve, reject) => {
      const remaining = deadline - performance.now();
      if (remaining <= 0 || this.closed) {
        reject(new MachineTokenUnavailableError());
        return;
      }
      let active: ClientRequest | undefined;
      let settled = false;
      const finish = (bytes?: Buffer) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (active) this.requests.delete(active);
        if (bytes) resolve(bytes);
        else {
          active?.destroy();
          reject(new MachineTokenUnavailableError());
        }
      };
      const timer = setTimeout(() => finish(), remaining);
      timer.unref();
      try {
        active = request(
          checkedUrl(url),
          {
            method,
            agent: false,
            ca: config.ca,
            cert: config.certificate,
            key: config.privateKey,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
            headers: {
              accept: "application/json",
              ...(body
                ? {
                    "content-type": "application/json",
                    "content-length": String(body.byteLength),
                  }
                : {}),
            },
          },
          (response) => {
            if (
              response.statusCode !== 200 ||
              !/^application\/json(?:;\s*charset=utf-8)?$/iu.test(
                response.headers["content-type"] ?? "",
              ) ||
              response.headers["content-encoding"] !== undefined ||
              response.headers["set-cookie"] !== undefined
            ) {
              response.destroy();
              finish();
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > maximum) {
                response.destroy();
                finish();
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => finish(Buffer.concat(chunks)));
            response.on("error", () => finish());
            response.on("aborted", () => finish());
          },
        );
        this.requests.add(active);
        active.on("error", () => finish());
        active.end(body);
      } catch {
        finish();
      }
    });
  }
}

function checkedUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.href !== value ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new MachineTokenUnavailableError();
  return url;
}
