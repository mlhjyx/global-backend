import { request } from "node:https";
import type { ClientRequest } from "node:http";
import { createHash, createPublicKey } from "node:crypto";
import type { JSONWebKeySet, JWK } from "jose";
import { createStrictJwtPrimitives } from "./strict-jwt-primitives";

export const CAPABILITY_PATH =
  "/api/internal/v1/platform-automation/capabilities";
class Unavailable extends Error {
  constructor() {
    super("PLATFORM_CAPABILITY_UNAVAILABLE");
  }
}
const strict = createStrictJwtPrimitives(Unavailable, Unavailable);
export function capabilityHttpsUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      value.length > 2048 ||
      url.protocol !== "https:" ||
      url.href !== value ||
      url.username ||
      url.password ||
      value.includes("?") ||
      value.includes("#") ||
      url.port === "0" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url;
  } catch {
    throw new Unavailable();
  }
}
function fingerprint(key: JWK) {
  return createHash("sha256")
    .update(
      createPublicKey({
        key: { kty: "RSA", n: key.n!, e: key.e! },
        format: "jwk",
      }).export({ format: "der", type: "spki" }),
    )
    .digest("hex");
}
/** Fixed-purpose Node HTTPS transport. Explicit CA, no ambient proxy/fetch and no redirects. */
export class CapabilityHttpsClient {
  readonly endpoint: string;
  private readonly ca: Buffer;
  private readonly identityUri: string;
  private readonly capabilityUri: string;
  private closed = false;
  private readonly active = new Set<ClientRequest>();
  constructor(input: {
    origin: string;
    ca: Buffer;
    identityJwksUri: string;
    capabilityJwksUri: string;
  }) {
    const origin = capabilityHttpsUrl(input.origin);
    if (
      origin.pathname !== "/" ||
      !Buffer.isBuffer(input.ca) ||
      input.ca.length < 1 ||
      input.ca.length > 65536
    )
      throw new Unavailable();
    this.endpoint = new URL(CAPABILITY_PATH, origin).href;
    this.identityUri = capabilityHttpsUrl(input.identityJwksUri).href;
    this.capabilityUri = capabilityHttpsUrl(input.capabilityJwksUri).href;
    if (
      this.identityUri === this.capabilityUri ||
      [this.identityUri, this.capabilityUri].includes(this.endpoint)
    )
      throw new Unavailable();
    this.ca = Buffer.from(input.ca);
  }
  async loadKeys(signal: AbortSignal): Promise<JSONWebKeySet> {
    try {
      const documents = await Promise.all(
        [this.identityUri, this.capabilityUri].map(async (uri) => {
          const response = await this.exchange(
            uri,
            { method: "GET", signal },
            65536,
            "application/json",
          );
          const bytes = Buffer.from(await response.arrayBuffer());
          return strict.validJwksDocument(
            new strict.ClosedJwtObjectParser(
              strict.strictUtf8(bytes),
            ).parseJwks(),
          );
        }),
      );
      if (this.closed || signal.aborted) throw new Unavailable();
      const kids = new Set<string>(),
        keys = new Set<string>();
      for (const document of documents)
        for (const key of document.keys) {
          const spki = fingerprint(key);
          if (kids.has(key.kid!) || keys.has(spki)) throw new Unavailable();
          kids.add(key.kid!);
          keys.add(spki);
        }
      return { keys: [...documents[1].keys] };
    } catch {
      throw new Unavailable();
    }
  }
  readonly fetch: typeof fetch = async (input, init) => {
    if (
      typeof input !== "string" ||
      input !== this.endpoint ||
      init?.method !== "POST" ||
      typeof init.body !== "string" ||
      Buffer.byteLength(init.body) > 4096 ||
      !init.signal
    )
      throw new Unavailable();
    return this.exchange(input, init, 16384, "application/jose");
  };
  private exchange(
    url: string,
    init: RequestInit,
    maximum: number,
    type: string,
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      if (this.closed || init.signal?.aborted) {
        reject(new Unavailable());
        return;
      }
      let settled = false;
      const body = typeof init.body === "string" ? init.body : undefined;
      const headers = Object.fromEntries(new Headers(init.headers).entries());
      if (body !== undefined)
        headers["content-length"] = String(Buffer.byteLength(body));
      const req = request(
        url,
        {
          method: init.method,
          ca: this.ca,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          agent: false,
          maxHeaderSize: 8192,
          headers,
        },
        (res) => {
          const types = res.headers["content-type"],
            encoding = res.headers["content-encoding"],
            length = res.headers["content-length"];
          const allowedTypes =
            type === "application/json"
              ? ["application/json", "application/jwk-set+json"]
              : [type];
          if (
            res.statusCode !== 200 ||
            typeof types !== "string" ||
            !allowedTypes.some((value) =>
              [value, value + "; charset=utf-8"].includes(types.toLowerCase()),
            ) ||
            encoding !== undefined ||
            (length !== undefined &&
              (!/^[1-9][0-9]{0,5}$/.test(length) || Number(length) > maximum))
          ) {
            fail();
            return;
          }
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > maximum) {
              fail();
              return;
            }
            chunks.push(Buffer.from(chunk));
          });
          res.on("error", fail);
          res.on("aborted", fail);
          res.on("end", () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(
              new Response(Buffer.concat(chunks, size), {
                status: 200,
                headers: { "content-type": types },
              }),
            );
          });
        },
      );
      const cleanup = () => {
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", fail);
        this.active.delete(req);
      };
      const fail = () => {
        if (settled) return;
        settled = true;
        cleanup();
        req.destroy();
        reject(new Unavailable());
      };
      const timer = setTimeout(fail, 3000);
      timer.unref();
      this.active.add(req);
      req.once("error", fail);
      init.signal?.addEventListener("abort", fail, { once: true });
      if (this.closed || init.signal?.aborted) {
        fail();
        return;
      }
      req.end(body);
    });
  }
  close(): void {
    this.closed = true;
    for (const req of this.active) req.destroy(new Unavailable());
    this.active.clear();
    this.ca.fill(0);
  }
}
