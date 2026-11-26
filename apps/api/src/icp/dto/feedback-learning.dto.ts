import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

export const FEEDBACK_OUTCOMES = [
  'rejected',
  'replied_positive',
  'booked_meeting',
  'opt_out',
  'wrong_contact',
  'bounced',
] as const;

export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

export const FEEDBACK_REJECTION_REASONS = [
  'wrong_role_peer',
  'wrong_industry',
  'too_small',
  'wrong_country',
  'dead_company',
  'bounced_unreachable',
] as const;

export type FeedbackRejectionReason = (typeof FEEDBACK_REJECTION_REASONS)[number];

export class RecordIcpFeedbackDto {
  @ApiPropertyOptional({ type: 'string', format: 'uuid', description: '关联的线索 ID（可选，服务端可自动补齐公司信息）' })
  @IsOptional()
  @IsUUID()
  leadId?: string;

  @ApiPropertyOptional({ type: 'string', format: 'uuid', description: '关联的规范公司 ID（可选）' })
  @IsOptional()
  @IsUUID()
  companyId?: string;

  @ApiPropertyOptional({ maxLength: 255, description: '公司域名或官网地址（服务端自动规范化去 www.）' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  domain?: string;

  @ApiPropertyOptional({ maxLength: 200, description: '公司名称（可选；若提供 companyId/leadId 可自动回填）' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  companyName?: string;

  @ApiPropertyOptional({ maxLength: 120, description: '公司所属行业（可选，用于反例上下文与排除沉淀）' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  industry?: string;

  @ApiProperty({ enum: [...FEEDBACK_OUTCOMES], description: '真实外联或人工审核结果类型' })
  @IsIn(FEEDBACK_OUTCOMES)
  outcome!: FeedbackOutcome;

  @ApiPropertyOptional({
    enum: [...FEEDBACK_REJECTION_REASONS],
    description: '当 outcome 为 rejected 时的结构化驳回原因',
  })
  @IsOptional()
  @IsIn(FEEDBACK_REJECTION_REASONS)
  rejectionReason?: FeedbackRejectionReason;

  @ApiPropertyOptional({
    type: [String],
    maxItems: 10,
    description: '可选：补充沉淀到 peer_exclusions.excluded_keywords 的排除关键词',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @Length(1, 80, { each: true })
  excludedKeywords?: string[];

  @ApiPropertyOptional({ maxLength: 500, description: '可选人工备注（写入反例前会自动脱敏去除个人邮箱与电话）' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export const FEEDBACK_SUMMARY_SCHEMA = {
  type: 'object',
  required: [
    'icpId',
    'icpName',
    'icpVersion',
    'excludedDomains',
    'excludedKeywords',
    'excludedBusinessModels',
    'counterExamples',
    'positiveExamples',
    'stats',
  ],
  properties: {
    icpId: { type: 'string', format: 'uuid' },
    icpName: { type: 'string' },
    icpVersion: { type: 'integer' },
    excludedDomains: { type: 'array', items: { type: 'string' } },
    excludedKeywords: { type: 'array', items: { type: 'string' } },
    excludedBusinessModels: { type: 'array', items: { type: 'string' } },
    counterExamples: {
      type: 'array',
      items: {
        type: 'object',
        required: ['domain', 'companyName', 'industry', 'outcome', 'reason', 'note', 'recordedAt'],
        properties: {
          domain: { type: 'string', nullable: true },
          companyName: { type: 'string', nullable: true },
          industry: { type: 'string', nullable: true },
          outcome: { type: 'string', enum: [...FEEDBACK_OUTCOMES] },
          reason: { type: 'string', enum: [...FEEDBACK_REJECTION_REASONS, 'unspecified'] },
          note: { type: 'string', nullable: true },
          recordedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    positiveExamples: {
      type: 'array',
      items: {
        type: 'object',
        required: ['domain', 'companyName', 'industry', 'outcome', 'recordedAt'],
        properties: {
          domain: { type: 'string', nullable: true },
          companyName: { type: 'string', nullable: true },
          industry: { type: 'string', nullable: true },
          outcome: { type: 'string', enum: ['replied_positive', 'booked_meeting'] },
          recordedAt: { type: 'string', format: 'date-time' },
        },
      },
    },
    stats: {
      type: 'object',
      required: ['totalRecorded', 'outcomeCounts', 'rejectionReasonCounts', 'lastRecordedAt'],
      properties: {
        totalRecorded: { type: 'integer' },
        outcomeCounts: { type: 'object', additionalProperties: { type: 'integer' } },
        rejectionReasonCounts: { type: 'object', additionalProperties: { type: 'integer' } },
        lastRecordedAt: { type: 'string', format: 'date-time', nullable: true },
      },
    },
  },
} as const;

export const RECORD_FEEDBACK_RESPONSE_SCHEMA = {
  type: 'object',
  required: ['icpId', 'icpVersion', 'recorded', 'appliedRules', 'summary'],
  properties: {
    icpId: { type: 'string', format: 'uuid' },
    icpVersion: { type: 'integer' },
    recorded: {
      type: 'object',
      required: ['outcome', 'rejectionReason', 'domain', 'companyId', 'leadId', 'recordedAt'],
      properties: {
        outcome: { type: 'string', enum: [...FEEDBACK_OUTCOMES] },
        rejectionReason: { type: 'string', enum: [...FEEDBACK_REJECTION_REASONS], nullable: true },
        domain: { type: 'string', nullable: true },
        companyId: { type: 'string', format: 'uuid', nullable: true },
        leadId: { type: 'string', format: 'uuid', nullable: true },
        recordedAt: { type: 'string', format: 'date-time' },
      },
    },
    appliedRules: {
      type: 'object',
      required: ['addedExcludedDomain', 'addedExcludedKeywords', 'addedCounterExample'],
      properties: {
        addedExcludedDomain: { type: 'string', nullable: true },
        addedExcludedKeywords: { type: 'array', items: { type: 'string' } },
        addedCounterExample: { type: 'boolean' },
      },
    },
    summary: FEEDBACK_SUMMARY_SCHEMA,
  },
} as const;
