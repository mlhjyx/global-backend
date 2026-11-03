import {
  Body,
  Controller,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequireScopes } from '../auth/require-scopes.decorator';
import type { RequestContext } from '../auth/request-context';
import { ScopesGuard } from '../auth/scopes.guard';
import { ApiEnvelope } from '../common/api-envelope.decorator';
import { envelope, type Enveloped } from '../common/envelope';
import {
  MAX_EMAIL_GUESS_CONTACTS,
  MAX_EMAIL_PROBE_CANDIDATES,
} from '../discovery/execution-envelope';
import {
  WORKSPACE_EXECUTION_QUOTE_OPERATIONS,
} from './workspace-technical-budget-envelope';
import type {
  GuessEmailsHttpRequestBody,
  VerifyContactPointHttpRequestBody,
  WorkspaceExecutionBudgetRequest,
} from './execution-budget-request-scope';
import {
  WORKSPACE_TECHNICAL_BUDGET_QUOTE_SCHEMA,
  WorkspaceTechnicalBudgetQuoteError,
  WorkspaceTechnicalBudgetQuoteService,
  type WorkspaceTechnicalBudgetQuote,
} from './workspace-technical-budget-quote';

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// eslint-disable-next-line no-control-regex -- public boundary rejects ASCII control characters.
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/u;
const LAWFUL_BASES = new Set([
  'legitimate_interest',
  'consent',
  'contract',
  'legal_obligation',
]);

class WorkspaceTechnicalBudgetQuoteResponseDto {
  @ApiProperty({ enum: [WORKSPACE_TECHNICAL_BUDGET_QUOTE_SCHEMA] })
  schemaVersion!: typeof WORKSPACE_TECHNICAL_BUDGET_QUOTE_SCHEMA;

  @ApiProperty({ enum: ['WORKSPACE_GRANT'] })
  authorityKind!: 'WORKSPACE_GRANT';

  @ApiProperty({ enum: WORKSPACE_EXECUTION_QUOTE_OPERATIONS })
  operation!: WorkspaceExecutionBudgetRequest['operation'];

  @ApiProperty({ format: 'uuid' })
  workspaceId!: string;

  @ApiProperty({
    enum: [
      'understanding.run',
      'icp.design',
      'icp.query_plan',
      'discovery.run',
      'contact.verify',
      'outreach.draft',
    ],
  })
  purpose!: WorkspaceTechnicalBudgetQuote['purpose'];

  @ApiProperty({ enum: ['company', 'icp', 'discovery_run', 'contact_point', 'lead'] })
  subjectType!: string;

  @ApiProperty({ minLength: 1, maxLength: 200 })
  subjectId!: string;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  requestSha256!: string;

  @ApiProperty({ enum: ['USD'] })
  currency!: 'USD';

  @ApiProperty({ enum: ['microusd'] })
  unit!: 'microusd';

  @ApiProperty({ pattern: '^[1-9][0-9]*$' })
  requiredCapMicrousd!: string;

  @ApiProperty({ pattern: '^[0-9a-f]{64}$' })
  policyRevision!: string;

  @ApiProperty({ format: 'date-time' })
  expiresAt!: string;
}

function invalid(): never {
  throw new WorkspaceTechnicalBudgetQuoteError(
    'EXECUTION_BUDGET_QUOTE_INVALID',
  );
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    invalid();
  }
}

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) invalid();
  return value;
}

function optionalText(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    value.length > maxLength ||
    !NO_CONTROL_CHARS.test(value)
  ) {
    invalid();
  }
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') invalid();
  return value;
}

function optionalBoundedInteger(
  value: unknown,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    invalid();
  }
  return value as number;
}

function complianceBody(
  value: unknown,
  includeGuessBounds: boolean,
): GuessEmailsHttpRequestBody | VerifyContactPointHttpRequestBody | undefined {
  if (value === undefined) return undefined;
  const input = record(value);
  const baseKeys = [
    'lawfulBasis',
    'lawfulBasisRef',
    'lawfulBasisNote',
    'allowPersonalWithoutBasis',
  ];
  exactKeys(
    input,
    [],
    includeGuessBounds ? [...baseKeys, 'maxContacts', 'maxProbe'] : baseKeys,
  );
  if (
    input.lawfulBasis !== undefined &&
    (typeof input.lawfulBasis !== 'string' ||
      !LAWFUL_BASES.has(input.lawfulBasis))
  ) {
    invalid();
  }
  return Object.freeze({
    ...(input.lawfulBasis === undefined
      ? {}
      : { lawfulBasis: input.lawfulBasis as string }),
    ...(input.lawfulBasisRef === undefined
      ? {}
      : { lawfulBasisRef: optionalText(input.lawfulBasisRef, 512) }),
    ...(input.lawfulBasisNote === undefined
      ? {}
      : { lawfulBasisNote: optionalText(input.lawfulBasisNote, 1_000) }),
    ...(input.allowPersonalWithoutBasis === undefined
      ? {}
      : {
          allowPersonalWithoutBasis: optionalBoolean(
            input.allowPersonalWithoutBasis,
          ),
        }),
    ...(includeGuessBounds && input.maxContacts !== undefined
      ? {
          maxContacts: optionalBoundedInteger(
            input.maxContacts,
            MAX_EMAIL_GUESS_CONTACTS,
          ),
        }
      : {}),
    ...(includeGuessBounds && input.maxProbe !== undefined
      ? {
          maxProbe: optionalBoundedInteger(
            input.maxProbe,
            MAX_EMAIL_PROBE_CANDIDATES,
          ),
        }
      : {}),
  });
}

function parseRequest(value: unknown): WorkspaceExecutionBudgetRequest {
  const input = record(value);
  if (
    typeof input.operation !== 'string' ||
    !WORKSPACE_EXECUTION_QUOTE_OPERATIONS.includes(
      input.operation as WorkspaceExecutionBudgetRequest['operation'],
    )
  ) {
    invalid();
  }
  switch (input.operation) {
    case 'POST /site-builder/intake': {
      exactKeys(input, ['operation', 'body']);
      const body = record(input.body);
      exactKeys(body, ['requestHash']);
      if (
        typeof body.requestHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(body.requestHash)
      ) {
        invalid();
      }
      return Object.freeze({
        operation: input.operation,
        body: Object.freeze({ requestHash: body.requestHash }),
      });
    }
    case 'POST /companies': {
      exactKeys(input, ['operation', 'body']);
      const body = record(input.body);
      exactKeys(body, [], [
        'website',
        'name',
        'industry',
        'targetMarkets',
        'products',
        'businessEmail',
      ]);
      const websiteOk =
        body.website === undefined ||
        (typeof body.website === 'string' && body.website.length >= 1);
      const nameOk =
        body.name === undefined ||
        (typeof body.name === 'string' && body.name.length <= 200);
      const industryOk =
        body.industry === undefined ||
        (typeof body.industry === 'string' &&
          body.industry.length >= 1 &&
          body.industry.length <= 120);
      const marketsOk =
        body.targetMarkets === undefined ||
        (Array.isArray(body.targetMarkets) &&
          body.targetMarkets.length <= 20 &&
          body.targetMarkets.every(
            (market) =>
              typeof market === 'string' && /^[A-Z]{2}$/.test(market),
          ));
      const productsOk =
        body.products === undefined ||
        (Array.isArray(body.products) &&
          body.products.length >= 1 &&
          body.products.length <= 5 &&
          body.products.every(
            (product) =>
              typeof product === 'string' &&
              product.length >= 1 &&
              product.length <= 120,
          ));
      const businessEmailOk =
        body.businessEmail === undefined ||
        (typeof body.businessEmail === 'string' &&
          body.businessEmail.length <= 254 &&
          /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.businessEmail));
      if (
        !websiteOk ||
        !nameOk ||
        !industryOk ||
        !marketsOk ||
        !productsOk ||
        !businessEmailOk ||
        (body.website === undefined && body.name === undefined)
      ) {
        invalid();
      }
      return Object.freeze({
        operation: input.operation,
        body: Object.freeze({
          ...(body.website === undefined
            ? {}
            : { website: body.website as string }),
          ...(body.name === undefined ? {} : { name: body.name as string }),
          ...(body.industry === undefined
            ? {}
            : { industry: body.industry as string }),
          ...(body.targetMarkets === undefined
            ? {}
            : { targetMarkets: body.targetMarkets as string[] }),
          ...(body.products === undefined
            ? {}
            : { products: body.products as string[] }),
          ...(body.businessEmail === undefined
            ? {}
            : { businessEmail: body.businessEmail as string }),
        }),
      });
    }
    case 'POST /companies/:companyId/icps':
      exactKeys(input, ['operation', 'companyId']);
      return Object.freeze({
        operation: input.operation,
        companyId: uuid(input.companyId),
      });
    case 'POST /companies/:companyId/understanding/retry': {
      exactKeys(input, ['operation', 'companyId', 'body']);
      const body = input.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return invalid();
      }
      const record = body as Record<string, unknown>;
      exactKeys(record, ['attemptId']);
      return Object.freeze({
        operation: input.operation,
        companyId: uuid(input.companyId),
        body: Object.freeze({ attemptId: uuid(record.attemptId) }),
      });
    }
    case 'POST /icps/:icpId/query-plans':
      exactKeys(input, ['operation', 'icpId']);
      return Object.freeze({
        operation: input.operation,
        icpId: uuid(input.icpId),
      });
    case 'POST /query-plans/:planId/execute':
      exactKeys(input, ['operation', 'planId']);
      return Object.freeze({
        operation: input.operation,
        planId: uuid(input.planId),
      });
    case 'POST /canonical-companies/:id/discover-contacts': {
      exactKeys(input, ['operation', 'companyId'], ['body']);
      const companyId = uuid(input.companyId);
      if (input.body === undefined) {
        return Object.freeze({ operation: input.operation, companyId });
      }
      const bodyRecord = record(input.body);
      exactKeys(bodyRecord, ['attemptId']);
      return Object.freeze({
        operation: input.operation,
        companyId,
        body: Object.freeze({ attemptId: uuid(bodyRecord.attemptId) }),
      });
    }
    case 'POST /canonical-companies/:id/guess-emails':
      exactKeys(input, ['operation', 'companyId'], ['body']);
      return Object.freeze({
        operation: input.operation,
        companyId: uuid(input.companyId),
        ...(input.body === undefined
          ? {}
          : { body: complianceBody(input.body, true) }),
      });
    case 'POST /contact-points/:pointId/verify':
      exactKeys(input, ['operation', 'pointId'], ['body']);
      return Object.freeze({
        operation: input.operation,
        pointId: uuid(input.pointId),
        ...(input.body === undefined
          ? {}
          : { body: complianceBody(input.body, false) }),
      });
    case 'POST /leads/:leadId/outreach-drafts':
      exactKeys(input, ['operation', 'leadId']);
      return Object.freeze({
        operation: input.operation,
        leadId: uuid(input.leadId),
      });
    default:
      return invalid();
  }
}

function errorSchema(codes: readonly string[]) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'message'],
        properties: {
          code: { type: 'string', enum: [...codes] },
          message: { type: 'string' },
        },
      },
    },
  };
}

const COMPLIANCE_BODY_OPENAPI_PROPERTIES = {
  lawfulBasis: {
    type: 'string',
    enum: [...LAWFUL_BASES],
  },
  lawfulBasisRef: { type: 'string', maxLength: 512 },
  lawfulBasisNote: { type: 'string', maxLength: 1_000 },
  allowPersonalWithoutBasis: { type: 'boolean' },
} as const;

function operationVariant(
  operation: WorkspaceExecutionBudgetRequest['operation'],
  properties: Record<string, unknown>,
  required: readonly string[],
) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['operation', ...required],
    properties: {
      operation: { type: 'string', enum: [operation] },
      ...properties,
    },
  };
}

const WORKSPACE_QUOTE_REQUEST_SCHEMAS = [
  operationVariant(
    'POST /companies',
    {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          website: { type: 'string', minLength: 1 },
          name: { type: 'string', maxLength: 200 },
          industry: { type: 'string', minLength: 1, maxLength: 120 },
          targetMarkets: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string', pattern: '^[A-Z]{2}$' },
          },
          products: {
            type: 'array',
            minItems: 1,
            maxItems: 5,
            items: { type: 'string', minLength: 1, maxLength: 120 },
          },
          businessEmail: { type: 'string', maxLength: 254 },
        },
      },
    },
    ['body'],
  ),
  operationVariant(
    'POST /companies/:companyId/icps',
    { companyId: { type: 'string', format: 'uuid' } },
    ['companyId'],
  ),
  operationVariant(
    'POST /companies/:companyId/understanding/retry',
    {
      companyId: { type: 'string', format: 'uuid' },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['attemptId'],
        properties: { attemptId: { type: 'string', format: 'uuid' } },
      },
    },
    ['companyId', 'body'],
  ),
  operationVariant(
    'POST /icps/:icpId/query-plans',
    { icpId: { type: 'string', format: 'uuid' } },
    ['icpId'],
  ),
  operationVariant(
    'POST /query-plans/:planId/execute',
    { planId: { type: 'string', format: 'uuid' } },
    ['planId'],
  ),
  operationVariant(
    'POST /canonical-companies/:id/discover-contacts',
    {
      companyId: { type: 'string', format: 'uuid' },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['attemptId'],
        properties: { attemptId: { type: 'string', format: 'uuid' } },
      },
    },
    ['companyId'],
  ),
  operationVariant(
    'POST /canonical-companies/:id/guess-emails',
    {
      companyId: { type: 'string', format: 'uuid' },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...COMPLIANCE_BODY_OPENAPI_PROPERTIES,
          maxContacts: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_EMAIL_GUESS_CONTACTS,
          },
          maxProbe: {
            type: 'integer',
            minimum: 1,
            maximum: MAX_EMAIL_PROBE_CANDIDATES,
          },
        },
      },
    },
    ['companyId'],
  ),
  operationVariant(
    'POST /contact-points/:pointId/verify',
    {
      pointId: { type: 'string', format: 'uuid' },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: COMPLIANCE_BODY_OPENAPI_PROPERTIES,
      },
    },
    ['pointId'],
  ),
  operationVariant(
    'POST /leads/:leadId/outreach-drafts',
    { leadId: { type: 'string', format: 'uuid' } },
    ['leadId'],
  ),
  operationVariant(
    'POST /site-builder/intake',
    {
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['requestHash'],
        properties: {
          requestHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
        },
      },
    },
    ['body'],
  ),
] as const;

@ApiTags('ExecutionBudget')
@ApiBearerAuth()
@Controller('execution-budget')
@UseGuards(AuthGuard, ScopesGuard)
@RequireScopes('acquisition:write')
export class WorkspaceTechnicalBudgetQuoteController {
  constructor(private readonly quotes: WorkspaceTechnicalBudgetQuoteService) {}

  @Post('workspace-technical-quote')
  @HttpCode(200)
  @ApiOperation({
    summary:
      '计算 Workspace operation 的平台内部执行安全包络；不构成客户价格、余额或额度',
  })
  @ApiBody({
    schema: {
      oneOf: [...WORKSPACE_QUOTE_REQUEST_SCHEMAS],
    },
  })
  @ApiEnvelope(WorkspaceTechnicalBudgetQuoteResponseDto)
  @ApiResponse({
    status: 400,
    schema: errorSchema(['EXECUTION_BUDGET_QUOTE_INVALID']),
  })
  @ApiResponse({
    status: 503,
    schema: errorSchema([
      'EXECUTION_BUDGET_QUOTE_UNAVAILABLE',
      'EXECUTION_BUDGET_POLICY_DRIFT',
    ]),
  })
  quote(
    @Ctx() ctx: RequestContext,
    @Body() raw: unknown,
  ): Enveloped<WorkspaceTechnicalBudgetQuote> {
    return envelope(this.quotes.quote(ctx, parseRequest(raw)));
  }
}
