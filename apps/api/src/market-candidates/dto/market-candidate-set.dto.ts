import 'reflect-metadata';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsDefined, IsIn, IsInt, IsString,
  IsUUID, Length, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested,
} from 'class-validator';

export const KNOWLEDGE_STATES = ['SELLER_ASSERTION', 'REVIEWED_SOURCE_FACT', 'INFERENCE', 'CONFLICT', 'UNKNOWN'] as const;
export const SOURCE_KINDS = ['OFFERING', 'CLAIM', 'EVIDENCE', 'SELLER_DOCUMENT', 'SELLER_DOCUMENT_CHUNK'] as const;
export const FEEDBACK_ACTIONS = ['CONFIRM', 'CORRECT', 'KEEP_PENDING', 'REJECT'] as const;
export const FEEDBACK_STATES = ['PENDING', 'CONFIRMED', 'CORRECTED', 'PENDING_EVIDENCE', 'REJECTED'] as const;
export const RECOMMENDATIONS = ['COMPARABLE', 'CONDITIONAL', 'INSUFFICIENT_EVIDENCE', 'NOT_RECOMMENDED'] as const;
export const GENERATION_OUTCOMES = ['CANDIDATES_PROPOSED', 'COMPLETED_EMPTY'] as const;
export const MAX_DOCUMENT_BYTES = 256 * 1024;

export class MarketCandidateSourceReferenceDto {
  @ApiProperty({ enum: SOURCE_KINDS }) @IsIn(SOURCE_KINDS) kind!: typeof SOURCE_KINDS[number];
  @ApiProperty({ format: 'uuid' }) @IsUUID() sourceId!: string;
}

export class MarketCandidateStatementDto {
  @ApiProperty({ maxLength: 2000 }) @IsString() @Length(1, 2000) @Matches(/\S/u) text!: string;
  @ApiProperty({ enum: KNOWLEDGE_STATES, description: '资料事实不等于独立验证认证、采购关系或真实市场效果。' })
  @IsIn(KNOWLEDGE_STATES) knowledgeState!: typeof KNOWLEDGE_STATES[number];
  @ApiProperty({ type: [String], maxItems: 200, description: '指向同一依据快照的 kind:UUID 键；空数组明确无记录依据。' })
  @IsArray() @ArrayMaxSize(200) @ArrayUnique() @IsString({ each: true }) @MaxLength(80, { each: true }) basisKeys!: string[];
  @ApiProperty({ maxLength: 2000 }) @IsString() @Length(1, 2000) @Matches(/\S/u) impact!: string;
}

export class MarketCandidateSupplyDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() offeringId!: string;
  @ApiProperty({ maxLength: 2000 }) @IsString() @Length(1, 2000) @Matches(/\S/u) description!: string;
}

export class MarketCandidateRecommendationDto {
  @ApiProperty({ enum: RECOMMENDATIONS }) @IsIn(RECOMMENDATIONS) status!: typeof RECOMMENDATIONS[number];
  @ApiProperty({ maxLength: 2000 }) @IsString() @Length(1, 2000) @Matches(/\S/u) reason!: string;
}

export class MarketCandidateProposalDto {
  @ApiProperty({ type: MarketCandidateSupplyDto }) @IsDefined() @ValidateNested() @Type(() => MarketCandidateSupplyDto) supplyOrCapability!: MarketCandidateSupplyDto;
  @ApiProperty({ type: String, nullable: true, pattern: '^[A-Z]{2}$' })
  @ValidateIf((_, v) => v !== null) @Matches(/^[A-Z]{2}$/u) buyerOrganizationCountry!: string | null;
  @ApiProperty({ type: String, nullable: true, pattern: '^[A-Z]{2}$' })
  @ValidateIf((_, v) => v !== null) @Matches(/^[A-Z]{2}$/u) projectCountry!: string | null;
  @ApiProperty({ type: MarketCandidateStatementDto }) @IsDefined() @ValidateNested() @Type(() => MarketCandidateStatementDto) application!: MarketCandidateStatementDto;
  @ApiProperty({ type: MarketCandidateStatementDto }) @IsDefined() @ValidateNested() @Type(() => MarketCandidateStatementDto) organizationRole!: MarketCandidateStatementDto;
  @ApiProperty({ type: MarketCandidateStatementDto }) @IsDefined() @ValidateNested() @Type(() => MarketCandidateStatementDto) fitExplanation!: MarketCandidateStatementDto;
  @ApiProperty({ type: [MarketCandidateStatementDto], maxItems: 200 })
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => MarketCandidateStatementDto) entryConditions!: MarketCandidateStatementDto[];
  @ApiProperty({ type: [MarketCandidateStatementDto], maxItems: 200 })
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => MarketCandidateStatementDto) support!: MarketCandidateStatementDto[];
  @ApiProperty({ type: [MarketCandidateStatementDto], maxItems: 200 })
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => MarketCandidateStatementDto) counterEvidence!: MarketCandidateStatementDto[];
  @ApiProperty({ type: [MarketCandidateStatementDto], maxItems: 200 })
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => MarketCandidateStatementDto) gaps!: MarketCandidateStatementDto[];
  @ApiProperty({ type: MarketCandidateRecommendationDto }) @IsDefined() @ValidateNested() @Type(() => MarketCandidateRecommendationDto) recommendation!: MarketCandidateRecommendationDto;
  @ApiProperty({ type: [String], maxItems: 200 })
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @Length(1, 2000, { each: true }) nextVerification!: string[];
}

export class MarketCandidateCorrectionDto {
  @ApiPropertyOptional({ maxLength: 2000 }) @ValidateIf((_, v) => v !== undefined) @IsString() @Length(1, 2000) @Matches(/\S/u) supplyDescription?: string;
  @ApiPropertyOptional({ type: String, nullable: true, pattern: '^[A-Z]{2}$' })
  @ValidateIf((_, v) => v !== undefined && v !== null) @Matches(/^[A-Z]{2}$/u) buyerOrganizationCountry?: string | null;
  @ApiPropertyOptional({ type: String, nullable: true, pattern: '^[A-Z]{2}$' })
  @ValidateIf((_, v) => v !== undefined && v !== null) @Matches(/^[A-Z]{2}$/u) projectCountry?: string | null;
  @ApiPropertyOptional({ maxLength: 2000 }) @ValidateIf((_, v) => v !== undefined) @IsString() @Length(1, 2000) @Matches(/\S/u) application?: string;
  @ApiPropertyOptional({ maxLength: 2000 }) @ValidateIf((_, v) => v !== undefined) @IsString() @Length(1, 2000) @Matches(/\S/u) organizationRole?: string;
  @ApiPropertyOptional({ maxLength: 2000 }) @ValidateIf((_, v) => v !== undefined) @IsString() @Length(1, 2000) @Matches(/\S/u) fitExplanation?: string;
  @ApiPropertyOptional({ type: [String], maxItems: 200 }) @ValidateIf((_, v) => v !== undefined)
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @Length(1, 2000, { each: true }) entryConditions?: string[];
  @ApiPropertyOptional({ type: [String], maxItems: 200 }) @ValidateIf((_, v) => v !== undefined)
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @Length(1, 2000, { each: true }) gaps?: string[];
  @ApiPropertyOptional({ type: [String], maxItems: 200 }) @ValidateIf((_, v) => v !== undefined)
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) @Length(1, 2000, { each: true }) nextVerification?: string[];
}

export class MarketCandidateDraftDto {
  @ApiProperty({ type: MarketCandidateProposalDto }) @IsDefined() @ValidateNested() @Type(() => MarketCandidateProposalDto) proposal!: MarketCandidateProposalDto;
}

export class MarketCandidateSetDraftV1Dto {
  @ApiProperty({ enum: GENERATION_OUTCOMES }) @IsIn(GENERATION_OUTCOMES) generationOutcome!: typeof GENERATION_OUTCOMES[number];
  @ApiProperty({ type: [MarketCandidateSourceReferenceDto], maxItems: 200 })
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => MarketCandidateSourceReferenceDto) sources!: MarketCandidateSourceReferenceDto[];
  @ApiProperty({ type: [MarketCandidateDraftDto], maxItems: 100 })
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => MarketCandidateDraftDto) candidates!: MarketCandidateDraftDto[];
}

export class MarketCandidateCompanyBasisDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() companyId!: string;
  @ApiProperty({ minimum: 1, type: 'integer' }) @IsInt() @Min(1) version!: number;
}

export class MarketCandidateSourcePositionDto {
  @ApiProperty({ type: 'integer', nullable: true, minimum: 0 }) @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) seq!: number | null;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 1 }) @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) page!: number | null;
  @ApiProperty({ type: String, nullable: true, maxLength: 2000 }) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(2000) section!: string | null;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 0 }) @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) quoteStart!: number | null;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 0 }) @ValidateIf((_, v) => v !== null) @IsInt() @Min(0) quoteEnd!: number | null;
}

export class MarketCandidateSourceSnapshotDto extends MarketCandidateSourceReferenceDto {
  @ApiProperty({ maxLength: 80 }) @IsString() @Length(1, 80) key!: string;
  @ApiProperty({ type: 'integer', nullable: true, minimum: 1 }) @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) version!: number | null;
  @ApiProperty({ type: String, nullable: true, maxLength: 80 }) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(80) status!: string | null;
  @ApiProperty({ pattern: '^[a-f0-9]{64}$' }) @Matches(/^[a-f0-9]{64}$/u) digest!: string;
  @ApiProperty({ type: String, nullable: true, pattern: '^[a-f0-9]{64}$' }) @ValidateIf((_, v) => v !== null) @Matches(/^[a-f0-9]{64}$/u) contentHash!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) @ValidateIf((_, v) => v !== null) @IsUUID() parentId!: string | null;
  @ApiProperty({ type: String, nullable: true, pattern: '^[a-f0-9]{64}$' }) @ValidateIf((_, v) => v !== null) @Matches(/^[a-f0-9]{64}$/u) parentContentHash!: string | null;
  @ApiProperty({ type: MarketCandidateSourcePositionDto, nullable: true }) @ValidateIf((_, v) => v !== null)
  @IsDefined() @ValidateNested() @Type(() => MarketCandidateSourcePositionDto) position!: MarketCandidateSourcePositionDto | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' }) @ValidateIf((_, v) => v !== null) @IsString() @MaxLength(40) sourceDate!: string | null;
}

export class MarketCandidateBasisSnapshotDto {
  @ApiProperty({ type: MarketCandidateCompanyBasisDto }) @IsDefined() @ValidateNested() @Type(() => MarketCandidateCompanyBasisDto) company!: MarketCandidateCompanyBasisDto;
  @ApiProperty({ type: [MarketCandidateSourceSnapshotDto], maxItems: 200 })
  @IsArray() @ArrayMaxSize(200) @ValidateNested({ each: true }) @Type(() => MarketCandidateSourceSnapshotDto) sources!: MarketCandidateSourceSnapshotDto[];
}

export class MarketCandidateDto extends MarketCandidateDraftDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() candidateId!: string;
  @ApiProperty({ type: MarketCandidateCorrectionDto, description: '用户主张覆盖层；不修改原 proposal 或卖方 SoR。' })
  @IsDefined() @ValidateNested() @Type(() => MarketCandidateCorrectionDto) corrections!: MarketCandidateCorrectionDto;
  @ApiProperty({ enum: FEEDBACK_STATES }) @IsIn(FEEDBACK_STATES) feedback!: typeof FEEDBACK_STATES[number];
  @ApiProperty() @IsBoolean() needsReassessment!: boolean;
  @ApiProperty({ enum: ['NONE', 'UNKNOWN'] }) @IsIn(['NONE', 'UNKNOWN']) impactScope!: 'NONE' | 'UNKNOWN';
}

export class MarketCandidateSetV1Dto {
  @ApiProperty({ enum: ['market-candidate-set/v1'] }) @IsIn(['market-candidate-set/v1']) schemaVersion!: 'market-candidate-set/v1';
  @ApiProperty({ format: 'uuid' }) @IsUUID() setId!: string;
  @ApiProperty({ format: 'uuid' }) @IsUUID() companyId!: string;
  @ApiProperty({ type: 'integer', minimum: 1 }) @IsInt() @Min(1) revision!: number;
  @ApiProperty({ type: MarketCandidateBasisSnapshotDto }) @IsDefined() @ValidateNested() @Type(() => MarketCandidateBasisSnapshotDto) basisSnapshot!: MarketCandidateBasisSnapshotDto;
  @ApiProperty({ enum: GENERATION_OUTCOMES }) @IsIn(GENERATION_OUTCOMES) generationOutcome!: typeof GENERATION_OUTCOMES[number];
  @ApiProperty({ type: [MarketCandidateDto], maxItems: 100 })
  @IsArray() @ArrayMaxSize(100) @ValidateNested({ each: true }) @Type(() => MarketCandidateDto) candidates!: MarketCandidateDto[];
}

export class MarketCandidateFeedbackInputDto {
  @ApiProperty({ type: 'integer', minimum: 1, maximum: 2147483647 }) @IsInt() @Min(1) @Max(2147483647) expectedRevision!: number;
  @ApiProperty({ enum: FEEDBACK_ACTIONS }) @IsIn(FEEDBACK_ACTIONS) action!: typeof FEEDBACK_ACTIONS[number];
  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 2000 })
  @ValidateIf((_, v) => v !== undefined && v !== null) @IsString() @MaxLength(2000) reason?: string | null;
  @ApiPropertyOptional({ type: MarketCandidateCorrectionDto, description: '仅 CORRECT 接受非空且有实质变更的白名单补丁。' })
  @ValidateIf((_, v) => v !== undefined) @IsDefined() @ValidateNested() @Type(() => MarketCandidateCorrectionDto) correction?: MarketCandidateCorrectionDto;
}

export class MarketCandidateBasisAvailabilityDto {
  @ApiProperty() key!: string;
  @ApiProperty({ enum: ['CURRENT', 'CHANGED', 'UNAVAILABLE', 'UNKNOWN'] }) status!: 'CURRENT' | 'CHANGED' | 'UNAVAILABLE' | 'UNKNOWN';
  @ApiProperty({ enum: ['MATCHED', 'VERSION_OR_DIGEST_CHANGED', 'SOURCE_UNAVAILABLE', 'FINGERPRINT_UNKNOWN'] }) reason!: string;
}

export class MarketCandidateRevisionDto {
  @ApiProperty({ type: MarketCandidateSetV1Dto }) document!: MarketCandidateSetV1Dto;
  @ApiProperty({ pattern: '^[a-f0-9]{64}$' }) documentHash!: string;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() historical!: boolean;
  @ApiProperty({ type: [MarketCandidateBasisAvailabilityDto] }) basisAvailability!: MarketCandidateBasisAvailabilityDto[];
}

export class MarketCandidateLatestDto {
  @ApiProperty({ enum: ['NOT_ANALYZED', 'AVAILABLE'], description: 'NOT_ANALYZED 仅表示本能力没有可读候选文档，不代表没有市场机会。' }) status!: 'NOT_ANALYZED' | 'AVAILABLE';
  @ApiProperty({ type: MarketCandidateRevisionDto, nullable: true }) result!: MarketCandidateRevisionDto | null;
}

export class MarketCandidateRevisionSummaryDto {
  @ApiProperty({ type: 'integer', minimum: 1 }) revision!: number;
  @ApiProperty({ pattern: '^[a-f0-9]{64}$' }) documentHash!: string;
  @ApiProperty({ format: 'uuid' }) createdBy!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class MarketCandidateRevisionPageDto {
  @ApiProperty({ type: [MarketCandidateRevisionSummaryDto] }) revisions!: MarketCandidateRevisionSummaryDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}

export class MarketCandidateFeedbackResultDto {
  @ApiProperty({ format: 'uuid' }) feedbackId!: string;
  @ApiProperty({ format: 'uuid' }) setId!: string;
  @ApiProperty({ format: 'uuid' }) candidateId!: string;
  @ApiProperty({ type: 'integer', minimum: 2 }) recordedRevision!: number;
  @ApiProperty({ pattern: '^[a-f0-9]{64}$' }) documentHash!: string;
  @ApiProperty({ enum: FEEDBACK_ACTIONS }) action!: typeof FEEDBACK_ACTIONS[number];
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: MarketCandidateCorrectionDto, nullable: true }) correction!: MarketCandidateCorrectionDto | null;
  @ApiProperty({ type: MarketCandidateDto }) before!: MarketCandidateDto;
  @ApiProperty({ type: MarketCandidateDto }) after!: MarketCandidateDto;
  @ApiProperty({ format: 'uuid' }) actorId!: string;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty() replayed!: boolean;
  @ApiProperty({ type: [MarketCandidateBasisAvailabilityDto] }) basisAvailability!: MarketCandidateBasisAvailabilityDto[];
}
