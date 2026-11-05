import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { createHash } from "node:crypto";

/** P4-P4c：权威方（gain-saas）渠道抓取 Grant 的 mTLS 客户端。
 *
 * 契约（gain-saas `platform-crawl-grant.controller.ts`）：
 *  - POST PLATFORM_CHANNEL_CRAWL_GRANT_ENDPOINT（mTLS 18448），content-type JSON
 *  - 请求恰好 8 个字符串字段；响应 { token, expiresAt }
 *  - 客户端证书用平台 worker 已有的 MACHINE_BOOTSTRAP_* 三件套；服务端只认该 CN
 */

export const PLATFORM_CHANNEL_CRAWL_GRANT_PATH =
  "/api/internal/v1/platform-channel-crawl-grants";

export class PlatformCrawlGrantClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PlatformCrawlGrantClientError";
  }
}

export interface PlatformCrawlGrantWireRequest {
  readonly channelId: string;
  readonly mode: string;
  readonly pageCap: string;
  readonly crawlRunId: string;
  readonly requestSha256: string;
  readonly technicalPolicyRevision: string;
  readonly capPerRunMicrousd: string;
  readonly campaignCapMicrousd: string;
}

export interface PlatformCrawlGrantWireResponse {
  readonly token: string;
  readonly expiresAt: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * request_sha256 的规范预像：键排序的紧凑 JSON，UTF-8 无换行。
 * 与 gain-saas `channelCrawlRequestSha256` 逐字节一致（跨仓向量
 * 870844370d9ae83fd096ab4c199376a53cda2cb5e87e32fc092dec00c4cae17d）。
 */
export function channelCrawlRequestSha256(
  channelId: string,
  mode: string,
  pageCap: string,
): string {
  const canonical = `{"channelId":${JSON.stringify(channelId)},"mode":${JSON.stringify(mode)},"pageCap":${JSON.stringify(pageCap)}}`;
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function unavailable(message: string): never {
  throw new PlatformCrawlGrantClientError("PLATFORM_GRANT_UNAVAILABLE", message);
}

function readMaterial(env: NodeJS.ProcessEnv): {
  endpoint: URL;
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
} {
  const endpoint = env.PLATFORM_CHANNEL_CRAWL_GRANT_ENDPOINT;
  if (!endpoint) unavailable("未配置 PLATFORM_CHANNEL_CRAWL_GRANT_ENDPOINT");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return unavailable("PLATFORM_CHANNEL_CRAWL_GRANT_ENDPOINT 不是合法 URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== PLATFORM_CHANNEL_CRAWL_GRANT_PATH
  )
    unavailable("PLATFORM_CHANNEL_CRAWL_GRANT_ENDPOINT 必须是该端点的 https URL");
  const read = (key: string): Buffer => {
    const path = env[key];
    if (!path) return unavailable(`缺少 ${key}`);
    try {
      return readFileSync(path);
    } catch {
      return unavailable(`${key} 不可读`);
    }
  };
  return {
    endpoint: url,
    ca: read("MACHINE_BOOTSTRAP_CA_FILE"),
    cert: read("MACHINE_BOOTSTRAP_CERT_FILE"),
    key: read("MACHINE_BOOTSTRAP_KEY_FILE"),
  };
}

export class PlatformCrawlGrantClient {
  private readonly material?: ReturnType<typeof readMaterial>;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    try {
      this.material = readMaterial(env);
    } catch {
      this.material = undefined;
    }
  }

  get configured(): boolean {
    return this.material !== undefined;
  }

  async requestChannelCrawlGrant(
    body: PlatformCrawlGrantWireRequest,
  ): Promise<PlatformCrawlGrantWireResponse> {
    if (!this.material) unavailable("渠道抓取 Grant 客户端未配置");
    const payload = JSON.stringify(body);
    if (Buffer.byteLength(payload, "utf8") > 16 * 1024)
      unavailable("渠道抓取 Grant 请求过大");
    return await new Promise<PlatformCrawlGrantWireResponse>(
      (resolve, reject) => {
        const request = httpsRequest(
          this.material!.endpoint,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload, "utf8"),
            },
            ca: this.material!.ca,
            cert: this.material!.cert,
            key: this.material!.key,
            rejectUnauthorized: true,
            minVersion: "TLSv1.2",
            agent: false,
            timeout: 10_000,
          },
          (response) => {
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on("data", (chunk: Buffer) => {
              bytes += chunk.byteLength;
              if (bytes > MAX_RESPONSE_BYTES) {
                request.destroy();
                reject(
                  new PlatformCrawlGrantClientError(
                    "PLATFORM_GRANT_RESPONSE_INVALID",
                    "响应过大",
                  ),
                );
                return;
              }
              chunks.push(chunk);
            });
            response.on("end", () => {
              if (response.statusCode !== 200) {
                reject(
                  new PlatformCrawlGrantClientError(
                    "PLATFORM_GRANT_REJECTED",
                    `权威方拒绝签发（${response.statusCode}）`,
                  ),
                );
                return;
              }
              let decoded: unknown;
              try {
                decoded = JSON.parse(
                  Buffer.concat(chunks).toString("utf8"),
                ) as unknown;
              } catch {
                return reject(
                  new PlatformCrawlGrantClientError(
                    "PLATFORM_GRANT_RESPONSE_INVALID",
                    "响应不是 JSON",
                  ),
                );
              }
              const candidate = decoded as {
                token?: unknown;
                expiresAt?: unknown;
              };
              if (
                typeof candidate?.token !== "string" ||
                candidate.token.length === 0 ||
                typeof candidate.expiresAt !== "number" ||
                !Number.isFinite(candidate.expiresAt)
              ) {
                return reject(
                  new PlatformCrawlGrantClientError(
                    "PLATFORM_GRANT_RESPONSE_INVALID",
                    "响应缺少 token/expiresAt",
                  ),
                );
              }
              resolve({
                token: candidate.token,
                expiresAt: candidate.expiresAt,
              });
            });
          },
        );
        request.on("timeout", () => {
          request.destroy();
          reject(
            new PlatformCrawlGrantClientError(
              "PLATFORM_GRANT_UNAVAILABLE",
              "渠道抓取 Grant 请求超时",
            ),
          );
        });
        request.on("error", (error) => {
          reject(
            new PlatformCrawlGrantClientError(
              "PLATFORM_GRANT_UNAVAILABLE",
              error instanceof Error ? error.message : String(error),
            ),
          );
        });
        request.end(payload);
      },
    );
  }
}
