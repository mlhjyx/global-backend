import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";

/** 权威方（gain-saas）平台运行 Grant 的 mTLS 客户端。
 *
 * 契约（gain-saas `platform-grant.controller.ts`）：
 *  - POST PLATFORM_GRANT_ENDPOINT（mTLS 18448），content-type JSON
 *  - 请求恰好 8 个字符串字段；响应 { token, expiresAt }，token 是 compact JWS
 *  - 客户端证书用平台 worker 已有的 MACHINE_BOOTSTRAP_* 三件套；服务端只认该 CN
 *
 * 这里只做传输与形状校验；Grant 的密码学与 claims 验证由
 * ExecutionBudgetGrantVerifier 在同一次 admission 里完成（platform-grant-admission.ts）。
 */

export const PLATFORM_GRANT_PATH =
  "/api/internal/v1/platform-schedule-grants";

export class PlatformGrantClientError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PlatformGrantClientError";
  }
}

export interface PlatformGrantWireRequest {
  readonly scheduleId: string;
  readonly purpose: string;
  readonly workflowId: string;
  readonly workflowRunId: string;
  readonly scheduleRequestSha256: string;
  readonly technicalPolicyRevision: string;
  readonly capPerRunMicrousd: string;
  readonly campaignCapMicrousd: string;
}

export interface PlatformGrantWireResponse {
  readonly token: string;
  readonly expiresAt: number;
}

const MAX_RESPONSE_BYTES = 64 * 1024;

function unavailable(message: string): never {
  throw new PlatformGrantClientError("PLATFORM_GRANT_UNAVAILABLE", message);
}

function readMaterial(env: NodeJS.ProcessEnv): {
  endpoint: URL;
  ca: Buffer;
  cert: Buffer;
  key: Buffer;
} {
  const endpoint = env.PLATFORM_GRANT_ENDPOINT;
  if (!endpoint) unavailable("未配置 PLATFORM_GRANT_ENDPOINT");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return unavailable("PLATFORM_GRANT_ENDPOINT 不是合法 URL");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== PLATFORM_GRANT_PATH
  )
    unavailable("PLATFORM_GRANT_ENDPOINT 必须是该端点的 https URL");
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

export class PlatformGrantClient {
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

  async issue(
    request: PlatformGrantWireRequest,
    deadlineMs = 10_000,
  ): Promise<PlatformGrantWireResponse> {
    const material = this.material;
    if (!material) unavailable("平台 Grant 端点未配置");
    const body = Buffer.from(JSON.stringify(request), "utf8");
    return new Promise<PlatformGrantWireResponse>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          requestObject.destroy(
            new PlatformGrantClientError("PLATFORM_GRANT_UNAVAILABLE", "签发超时"),
          ),
        deadlineMs,
      );
      timer.unref();
      const requestObject = httpsRequest(
        material.endpoint,
        {
          method: "POST",
          agent: false,
          ca: material.ca,
          cert: material.cert,
          key: material.key,
          rejectUnauthorized: true,
          minVersion: "TLSv1.2",
          headers: {
            accept: "application/json",
            "content-type": "application/json",
            "content-length": String(body.byteLength),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > MAX_RESPONSE_BYTES) response.destroy();
            else chunks.push(chunk);
          });
          response.on("error", () =>
            reject(new PlatformGrantClientError("PLATFORM_GRANT_UNAVAILABLE", "响应读取失败")),
          );
          response.on("end", () => {
            clearTimeout(timer);
            if (response.statusCode !== 200 || bytes > MAX_RESPONSE_BYTES) {
              reject(
                new PlatformGrantClientError(
                  "PLATFORM_GRANT_UNAVAILABLE",
                  `签发端点返回 ${response.statusCode}`,
                ),
              );
              return;
            }
            try {
              const parsed = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              ) as Partial<PlatformGrantWireResponse>;
              if (
                typeof parsed.token !== "string" ||
                parsed.token.split(".").length !== 3 ||
                typeof parsed.expiresAt !== "number" ||
                !Number.isSafeInteger(parsed.expiresAt)
              ) {
                reject(
                  new PlatformGrantClientError("PLATFORM_GRANT_UNAVAILABLE", "签发响应形状非法"),
                );
                return;
              }
              resolve({ token: parsed.token, expiresAt: parsed.expiresAt });
            } catch {
              reject(
                new PlatformGrantClientError("PLATFORM_GRANT_UNAVAILABLE", "签发响应不是 JSON"),
              );
            }
          });
        },
      );
      requestObject.on("error", () => {
        clearTimeout(timer);
        reject(new PlatformGrantClientError("PLATFORM_GRANT_UNAVAILABLE", "签发请求失败"));
      });
      requestObject.end(body);
    });
  }
}
