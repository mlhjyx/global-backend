import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 契约不变式：任一操作内的 header 参数名去大小写后必须唯一。
 *
 * HTTP header 名按 RFC 7230 大小写不敏感，oasdiff 亦如此归一。一旦同一操作出现两个
 * 仅大小写不同的 header 参数（如 `@Headers('idempotency-key')` 推断出的 `idempotency-key`
 * 与 `@ApiHeader({ name: 'Idempotency-Key' })` 显式声明的 `Idempotency-Key`），oasdiff
 * 会把契约**与其自身**误判为破坏性变更（new-required-request-parameter + request-parameter-removed），
 * 令所有「未改契约」的 PR 在 breaking 门无端翻红。
 *
 * 修法：`@ApiHeader` 的 name 必须与 `@Headers('…')` 推断名精确一致（含大小写），二者才会
 * 合并成单个参数（见 company.controller / builds.controller 同款约定）。
 *
 * 对 #98（builds 端点引入大小写重复 header）RED；修复后 GREEN。
 */

/** 从 cwd 向上找 monorepo 内的导出契约（vitest 从 apps/api 跑；从仓根跑也能找到）。 */
function openapiPath(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const p = path.join(dir, "packages/contracts/openapi/openapi.json");
    if (fs.existsSync(p)) return p;
    dir = path.dirname(dir);
  }
  throw new Error(
    "openapi.json not found — 契约文件缺失，请先 node dist/main.js --export-openapi",
  );
}

interface OpenApiParameter {
  name?: string;
  in?: string;
  $ref?: string;
  required?: boolean;
  schema?: {
    type?: string;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
  };
}

interface OpenApiSchema {
  type?: string;
  enum?: string[];
  properties?: Record<string, OpenApiSchema>;
}

interface OpenApiResponse {
  content?: Record<string, { schema?: OpenApiSchema }>;
}

interface OpenApiSpec {
  paths: Record<
    string,
    Record<
      string,
      {
        parameters?: OpenApiParameter[];
        responses?: Record<string, OpenApiResponse>;
      }
    >
  >;
  components?: {
    schemas?: Record<
      string,
      {
        required?: string[];
        properties?: Record<
          string,
          {
            enum?: string[];
            type?: string;
            format?: string;
            nullable?: boolean;
          }
        >;
      }
    >;
  };
}

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
  "trace",
]);

/** 返回每个操作内「去大小写后重名」的 header 参数，形如 `POST /x → idempotency-key: [idempotency-key, Idempotency-Key]`。 */
function findDuplicateHeaderParams(spec: OpenApiSpec): string[] {
  const offenders: string[] = [];
  for (const [route, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method) || !op?.parameters) continue;
      const byLowerName = new Map<string, string[]>();
      for (const param of op.parameters) {
        // 仅内联 header 参数参与判定（$ref 参数跳过；query/path 大小写敏感不在此列）
        if (param.$ref || param.in !== "header" || !param.name) continue;
        const key = param.name.toLowerCase();
        byLowerName.set(key, [...(byLowerName.get(key) ?? []), param.name]);
      }
      for (const [key, names] of byLowerName) {
        if (names.length > 1) {
          offenders.push(
            `${method.toUpperCase()} ${route} → "${key}": [${names.join(", ")}]`,
          );
        }
      }
    }
  }
  return offenders;
}

describe("OpenAPI header 参数大小写唯一性（oasdiff 破坏性门防误红）", () => {
  it("任一操作内 header 参数名去大小写后不得重复", () => {
    const spec = JSON.parse(
      fs.readFileSync(openapiPath(), "utf8"),
    ) as OpenApiSpec;
    const offenders = findDuplicateHeaderParams(spec);
    expect(
      offenders,
      `发现大小写重复的 header 参数（会令 oasdiff 误报破坏性变更）：\n${offenders.join("\n")}\n` +
        "修法：让 @ApiHeader 的 name 与 @Headers(...) 推断名精确一致（含大小写）以合并为单参数。",
    ).toEqual([]);
  });

  it("intake 暴露唯一可选 idempotency-key，响应为 siteId/buildId/generating_demo 且无 mode", () => {
    const spec = JSON.parse(
      fs.readFileSync(openapiPath(), "utf8"),
    ) as OpenApiSpec;
    const operation = spec.paths["/api/v1/site-builder/intake"]?.post;
    expect(
      operation,
      "OpenAPI 缺 POST /api/v1/site-builder/intake",
    ).toBeDefined();

    const headers = (operation?.parameters ?? []).filter(
      (parameter) =>
        parameter.in === "header" &&
        parameter.name?.toLowerCase() === "idempotency-key",
    );
    expect(headers).toEqual([
      expect.objectContaining({
        name: "idempotency-key",
        in: "header",
        required: false,
        schema: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          pattern: "^[A-Za-z0-9._:-]+$",
        },
      }),
    ]);

    const result = spec.components?.schemas?.IntakeResultDto;
    expect(new Set(result?.required)).toEqual(
      new Set(["siteId", "buildId", "status"]),
    );
    expect(result?.properties).toEqual({
      siteId: expect.objectContaining({}),
      buildId: expect.objectContaining({}),
      status: expect.objectContaining({ enum: ["generating_demo"] }),
    });
    expect(result?.properties).not.toHaveProperty("mode");

    expect(
      spec.components?.schemas?.IntakeCompanyDto?.properties?.nameEn,
    ).toMatchObject({
      type: "string",
      nullable: true,
    });
    expect(
      spec.components?.schemas?.IntakeDto?.properties?.websiteUrl,
    ).toMatchObject({
      type: "string",
      format: "uri",
      nullable: true,
    });

    const errorCodes = (status: string) =>
      operation?.responses?.[status]?.content?.["application/json"]?.schema
        ?.properties?.error?.properties?.code?.enum;
    expect(errorCodes("400")).toEqual([
      "INVALID_IDEMPOTENCY_KEY",
      "VALIDATION_ERROR",
    ]);
    expect(errorCodes("409")).toEqual([
      "IDEMPOTENCY_KEY_REUSED",
      "SITE_LIMIT_REACHED",
    ]);
    expect(errorCodes("502")).toEqual(["DEMO_LAUNCH_UNAVAILABLE"]);
  });
});
