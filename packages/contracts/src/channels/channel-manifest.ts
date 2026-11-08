/**
 * channel-manifest/v1 契约（GainOS 深化计划 v3.0 第 6 章 §6.3.3）。
 *
 * 这里是渠道 manifest 的 JSON Schema 单一真值（code-first，draft 2020-12）：服务端用 Ajv 校验、
 * 集成方（gain-saas 运营台、脚本导入）共用同一份文档。章节规定该 schema 落 contracts 并在 CI
 * 校验；以 TS 常量导出（而不是 .schema.json 文件）是为了让 CJS 构建与消费端拿到的字节完全一致。
 *
 * 约定：
 *   - 顶层只认 meta/transport/auth/pagination/rateLimit/records/crawl/fieldMapping/transforms/
 *     governance/healthcheck，additionalProperties=false；
 *   - `governance` 不是必填——没有治理块的 manifest 可以保存，但渠道启用仍被既有治理闸门拦住；
 *   - 语义校验（例如 headers 不得携带 Authorization/Cookie、联系人字段只能走详情页）不在 JSON
 *     Schema 里表达，见 apps/api/src/channels/connector/channel-manifest.ts 的 parseChannelManifest。
 */

export const CHANNEL_MANIFEST_VERSION = 'channel-manifest/v1' as const;

/** 与既有 channel-config.ts 的 CHANNEL_FIELD_KEYS 保持一致（契约层的镜像，测试钉住）。 */
export const CHANNEL_MANIFEST_FIELD_KEYS = [
  'name',
  'website',
  'country',
  'industry',
  'products',
  'keywords',
  'contactName',
  'contactTitle',
  'email',
  'phone',
] as const;

export const CHANNEL_MANIFEST_CONTACT_FIELD_KEYS = [
  'contactName',
  'contactTitle',
  'email',
  'phone',
] as const;

export const CHANNEL_MANIFEST_CATEGORIES = [
  'trade_fair',
  'customs',
  'association',
  'directory',
  'tender',
  'other',
] as const;

const httpsUrl = { type: 'string', maxLength: 2048, pattern: '^https://' } as const;
const boundedString = { type: 'string', minLength: 1, maxLength: 512 } as const;
const jsonPath = {
  type: 'string',
  maxLength: 256,
  description: '受控 JSONPath 子集：$.a.b[0].c / $.a[*].b；不支持函数与过滤表达式',
} as const;
const selector = {
  type: 'string',
  maxLength: 200,
  description: 'html-select 子集：tag/.class/#id/tag.class/[attr=value]/后代组合，可带 ::attr()/::text',
} as const;
// 引用形状 `channel/<slug>/<keyName>`（章节 §6.3.4）：两段路径分量，各段 [A-Za-z0-9_.-]。
// 章节原文的 pattern 只允许一个斜杠，与其自身示例（channel/companies-house/api-key）矛盾，
// 这里按引用模型修正（代码分割校验见 secret-resolver 的 CHANNEL_SECRET_REF_PATTERN）。
const secretRef = { type: 'string', maxLength: 200, pattern: '^channel/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' } as const;

const fieldMappingProperties = Object.fromEntries(
  CHANNEL_MANIFEST_FIELD_KEYS.map((key) => [key, { $ref: '#/definitions/jsonPath' }]),
);

const crawlDetailFieldProperties = Object.fromEntries(
  CHANNEL_MANIFEST_FIELD_KEYS.map((key) => [key, { $ref: '#/definitions/selector' }]),
);

export const CHANNEL_MANIFEST_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://gainos.local/schemas/channel-manifest/v1',
  title: 'channel-manifest/v1',
  type: 'object',
  additionalProperties: false,
  required: ['meta', 'transport'],
  allOf: [
    {
      if: { properties: { transport: { properties: { responseType: { const: 'json' } } } }, required: ['transport'] },
      then: { required: ['records'] },
    },
    {
      if: { properties: { transport: { properties: { responseType: { const: 'html' } } } }, required: ['transport'] },
      then: { required: ['crawl'] },
    },
  ],
  definitions: {
    httpsUrl,
    boundedString,
    jsonPath,
    selector,
    secretRef,
  },
  properties: {
    meta: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'version', 'category'],
      properties: {
        name: { $ref: '#/definitions/boundedString' },
        version: { type: 'integer', minimum: 1 },
        category: { enum: [...CHANNEL_MANIFEST_CATEGORIES] },
        docsUrl: { $ref: '#/definitions/httpsUrl' },
        description: { type: 'string', maxLength: 2000 },
      },
    },
    transport: {
      type: 'object',
      additionalProperties: false,
      required: ['baseUrl', 'responseType'],
      properties: {
        baseUrl: { $ref: '#/definitions/httpsUrl' },
        method: { enum: ['GET', 'POST'], default: 'GET' },
        responseType: { enum: ['json', 'html'] },
        queryDefaults: { type: 'object', additionalProperties: { type: 'string', maxLength: 512 } },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string', maxLength: 512 },
          description: '静态头白名单；禁止 Authorization/Cookie（认证走 auth）',
        },
        timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000, default: 15000 },
        maxResponseBytes: { type: 'integer', minimum: 1024, maximum: 5242880, default: 5242880 },
        allowedHosts: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: { type: 'string', pattern: '^[a-z0-9.*-]+$' },
          description: '出网域名白名单（含子域通配 *.example.com）；与 source_policy 派生联动',
        },
      },
    },
    auth: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: { type: { const: 'none' } },
        },
        {
          // apiKey：in=header 时 name 默认 Authorization；in=query 时 name 必填（语义校验把关）。
          // bearer：Authorization: Bearer <value>；header：自定义头名注入（task 明确支持的第四形态）。
          type: 'object',
          additionalProperties: false,
          required: ['type', 'secretRef'],
          properties: {
            type: { enum: ['apiKey', 'bearer', 'header'] },
            secretRef: { $ref: '#/definitions/secretRef' },
            in: { enum: ['header', 'query'], default: 'header' },
            name: { type: 'string', maxLength: 64, default: 'Authorization' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'usernameRef', 'passwordRef'],
          properties: {
            type: { const: 'basic' },
            usernameRef: { $ref: '#/definitions/secretRef' },
            passwordRef: { $ref: '#/definitions/secretRef' },
          },
        },
        {
          // v1 只接受保存、不执行（运行时明确 CHANNEL_AUTH_UNSUPPORTED，见连接器错误词表）。
          type: 'object',
          additionalProperties: false,
          required: ['type', 'tokenUrl', 'clientIdRef', 'clientSecretRef'],
          properties: {
            type: { const: 'oauth2_client_credentials' },
            tokenUrl: { $ref: '#/definitions/httpsUrl' },
            clientIdRef: { $ref: '#/definitions/secretRef' },
            clientSecretRef: { $ref: '#/definitions/secretRef' },
            scope: { type: 'string', maxLength: 200 },
          },
        },
      ],
    },
    pagination: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['type'],
          properties: { type: { const: 'none' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'pageParam', 'startPage', 'maxPages'],
          properties: {
            type: { const: 'page' },
            pageParam: { type: 'string', maxLength: 32 },
            startPage: { type: 'integer', minimum: 0, maximum: 1, default: 1 },
            maxPages: { type: 'integer', minimum: 1, maximum: 100 },
            sizeParam: { type: 'string', maxLength: 32 },
            pageSize: { type: 'integer', minimum: 1, maximum: 1000 },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'offsetParam', 'limitParam', 'maxPages'],
          properties: {
            type: { const: 'offset' },
            offsetParam: { type: 'string', maxLength: 32 },
            limitParam: { type: 'string', maxLength: 32 },
            pageSize: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
            maxPages: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'cursorParam', 'cursorPath'],
          properties: {
            type: { const: 'cursor' },
            cursorParam: { type: 'string', maxLength: 32 },
            cursorPath: { $ref: '#/definitions/jsonPath' },
            maxPages: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['type', 'nextLinkPath'],
          properties: {
            type: { const: 'link' },
            nextLinkPath: { $ref: '#/definitions/jsonPath' },
            maxPages: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
          },
        },
      ],
    },
    rateLimit: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rps: { type: 'number', minimum: 0.05, maximum: 50, default: 0.5 },
        burst: { type: 'integer', minimum: 1, maximum: 100, default: 2 },
        concurrency: { type: 'integer', minimum: 1, maximum: 8, default: 1 },
        dailyRequests: { type: 'integer', minimum: 1, maximum: 100000, default: 500 },
        respectRetryAfter: { type: 'boolean', default: true },
        perDomainDelayMs: { type: 'integer', minimum: 0, maximum: 60000, default: 2000 },
      },
    },
    records: {
      type: 'object',
      additionalProperties: false,
      required: ['itemsPath'],
      properties: {
        itemsPath: { $ref: '#/definitions/jsonPath', description: 'html 模式用 crawl.list.itemSelector 代替' },
        detail: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: false },
            urlPath: { $ref: '#/definitions/jsonPath' },
            urlTemplate: { type: 'string', maxLength: 2048 },
          },
        },
      },
    },
    crawl: {
      type: 'object',
      additionalProperties: false,
      required: ['list'],
      description:
        'responseType=html 时必填：复用现有 CrawlListConfig/CrawlDetailConfig 语义（channel-config.ts），只是收进 manifest 统一结构',
      properties: {
        list: {
          type: 'object',
          additionalProperties: false,
          required: ['itemSelector'],
          properties: {
            url: { type: 'string', maxLength: 2048, description: '缺省用 transport.baseUrl；含 {page} 占位符或配合 pageParam' },
            itemSelector: { $ref: '#/definitions/selector' },
            itemUrlSelector: { $ref: '#/definitions/selector' },
            pageParam: { type: 'string', maxLength: 32 },
            maxPages: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
        detail: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: false },
            fields: {
              type: 'object',
              additionalProperties: false,
              properties: crawlDetailFieldProperties,
            },
          },
        },
      },
    },
    fieldMapping: {
      type: 'object',
      additionalProperties: false,
      properties: fieldMappingProperties,
      description: '键集合必须落在 CHANNEL_FIELD_KEYS 内；联系人四字段只允许 detail.enabled=true 时启用',
    },
    transforms: {
      type: 'object',
      additionalProperties: false,
      properties: {
        trim: { type: 'boolean', default: true },
        emailLowercase: { type: 'boolean', default: true },
        websiteHttps: { type: 'boolean', default: true },
        countryIso: { type: 'boolean', default: true },
        regexStrip: {
          type: 'array',
          maxItems: 10,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['pattern'],
            properties: {
              pattern: { type: 'string', maxLength: 200 },
              flags: { type: 'string', maxLength: 4 },
            },
          },
        },
      },
    },
    governance: {
      type: 'object',
      additionalProperties: false,
      required: ['license', 'tosUrl', 'robotsPolicy'],
      properties: {
        license: { type: 'string', maxLength: 200 },
        tosUrl: { $ref: '#/definitions/httpsUrl' },
        robotsPolicy: { enum: ['A', 'B', 'C'] },
        personalData: { type: 'boolean', default: false },
        allowedPurpose: {
          type: 'array',
          items: { enum: ['discovery', 'enrichment', 'intent'] },
          minItems: 1,
        },
        retentionDays: { type: 'integer', minimum: 30, maximum: 1095, default: 365 },
      },
    },
    healthcheck: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', maxLength: 1024 },
        expectStatus: { type: 'integer', minimum: 100, maximum: 599, default: 200 },
        maxLatencyMs: { type: 'integer', minimum: 100, maximum: 30000, default: 5000 },
      },
    },
  },
} as const;

export type ChannelManifestCategory = (typeof CHANNEL_MANIFEST_CATEGORIES)[number];

export interface ChannelManifestDocument {
  meta: {
    name: string;
    version: number;
    category: ChannelManifestCategory;
    docsUrl?: string;
    description?: string;
  };
  transport: {
    baseUrl: string;
    method?: 'GET' | 'POST';
    responseType: 'json' | 'html';
    queryDefaults?: Record<string, string>;
    headers?: Record<string, string>;
    timeoutMs?: number;
    maxResponseBytes?: number;
    allowedHosts?: string[];
  };
  auth?:
    | { type: 'none' }
    | {
        type: 'apiKey' | 'bearer' | 'header';
        secretRef: string;
        in?: 'header' | 'query';
        name?: string;
      }
    | { type: 'basic'; usernameRef: string; passwordRef: string }
    | {
        type: 'oauth2_client_credentials';
        tokenUrl: string;
        clientIdRef: string;
        clientSecretRef: string;
        scope?: string;
      };
  pagination?:
    | { type: 'none' }
    | {
        type: 'page';
        pageParam: string;
        startPage: number;
        maxPages: number;
        sizeParam?: string;
        pageSize?: number;
      }
    | {
        type: 'offset';
        offsetParam: string;
        limitParam: string;
        pageSize?: number;
        maxPages: number;
      }
    | { type: 'cursor'; cursorParam: string; cursorPath: string; maxPages?: number }
    | { type: 'link'; nextLinkPath: string; maxPages?: number };
  rateLimit?: {
    rps?: number;
    burst?: number;
    concurrency?: number;
    dailyRequests?: number;
    respectRetryAfter?: boolean;
    perDomainDelayMs?: number;
  };
  records?: {
    itemsPath: string;
    detail?: { enabled?: boolean; urlPath?: string; urlTemplate?: string };
  };
  crawl?: {
    list: {
      url?: string;
      itemSelector: string;
      itemUrlSelector?: string;
      pageParam?: string;
      maxPages?: number;
    };
    detail?: { enabled?: boolean; fields?: Partial<Record<(typeof CHANNEL_MANIFEST_FIELD_KEYS)[number], string>> };
  };
  fieldMapping?: Partial<Record<(typeof CHANNEL_MANIFEST_FIELD_KEYS)[number], string>>;
  transforms?: {
    trim?: boolean;
    emailLowercase?: boolean;
    websiteHttps?: boolean;
    countryIso?: boolean;
    regexStrip?: Array<{ pattern: string; flags?: string }>;
  };
  governance?: {
    license: string;
    tosUrl: string;
    robotsPolicy: 'A' | 'B' | 'C';
    personalData?: boolean;
    allowedPurpose?: Array<'discovery' | 'enrichment' | 'intent'>;
    retentionDays?: number;
  };
  healthcheck?: { path?: string; expectStatus?: number; maxLatencyMs?: number };
}
