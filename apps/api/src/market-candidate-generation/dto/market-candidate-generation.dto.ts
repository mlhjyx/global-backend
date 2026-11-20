import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  generationCanonicalJson,
  invalidGenerationInput,
} from "../generation-basis";

export const GENERATION_PHASES = [
  "PREPARED",
  "RUNNING",
  "RESULT_UNKNOWN",
  "RESULT_READY",
  "PERSISTED",
  "FAILED",
  "NOT_APPLIED",
] as const;
export const GENERATION_REASONS = [
  "BASIS_UNAVAILABLE",
  "BASIS_CHANGED",
  "SUPERSEDED",
  "VERSION_CONFLICT",
  "OUTPUT_INVALID",
  "EXECUTION_REJECTED",
  "EXECUTION_FAILED",
  "RESULT_UNKNOWN",
  "RESULT_NOT_FOUND",
  "SAVE_PENDING",
] as const;
export class MarketCandidateGenerationPrepareDto {
  @ApiProperty({
    type: String,
    format: "uuid",
    description: "明确意图的幂等 UUID；同一意图重试必须沿用。",
  })
  intentId!: string;
  @ApiPropertyOptional({
    type: [String],
    description:
      "可选 Offering UUID；省略读取当前合法结构化依据，服务端归一并去重后与 Claim 合计最多200项。",
  })
  offeringIds?: string[];
  @ApiPropertyOptional({
    type: [String],
    description:
      "可选已审批 Claim UUID；显式空选择不等于省略，不会静默补充或删除选中来源。",
  })
  claimIds?: string[];
}
export class MarketCandidateGenerationExecuteDto {
  @ApiProperty({
    type: String,
    pattern: "^[0-9a-f]{64}$",
    description: "prepare 持久返回的不可变意图摘要，不是客户端授权。",
  })
  intentDigest!: string;
}
export class MarketCandidateGenerationSetReferenceDto {
  @ApiProperty({ type: String, format: "uuid" }) setId!: string;
  @ApiProperty({ type: Number, enum: [1] }) revision!: 1;
  @ApiProperty({ type: String, pattern: "^[0-9a-f]{64}$" })
  documentHash!: string;
}
export class MarketCandidateGenerationExecutionReferenceDto {
  @ApiProperty({ type: String, format: "uuid" }) operationId!: string;
  @ApiProperty({ type: String, enum: ["market-candidates-generation/v1"] })
  resultSchema!: string;
  @ApiProperty({ type: String, pattern: "^[0-9a-f]{64}$" })
  resultDigest!: string;
  @ApiProperty({ type: String, pattern: "^[0-9a-f]{64}$" }) ackId!: string;
}
export class MarketCandidateGenerationDto {
  @ApiProperty({ type: String, format: "uuid" }) generationId!: string;
  @ApiProperty({ type: String, format: "uuid" }) companyId!: string;
  @ApiProperty({ type: String, format: "uuid" }) intentId!: string;
  @ApiProperty({ type: String, pattern: "^[0-9a-f]{64}$" })
  intentDigest!: string;
  @ApiProperty({ type: String, enum: GENERATION_PHASES })
  phase!: (typeof GENERATION_PHASES)[number];
  @ApiProperty({ type: String, enum: GENERATION_REASONS, nullable: true })
  reasonCode!: (typeof GENERATION_REASONS)[number] | null;
  @ApiProperty({ type: String, format: "date-time" }) preparedAt!: string;
  @ApiProperty({ type: String, format: "date-time" }) updatedAt!: string;
  @ApiProperty({
    type: MarketCandidateGenerationSetReferenceDto,
    nullable: true,
    description:
      "仅在准确 ACK 与域终态提交且 B1 初始修订权威冷读成功后返回。NOT_APPLIED 永不返回候选集合。",
  })
  set!: MarketCandidateGenerationSetReferenceDto | null;
  @ApiProperty({
    type: MarketCandidateGenerationExecutionReferenceDto,
    nullable: true,
  })
  execution!: MarketCandidateGenerationExecutionReferenceDto | null;
}
export function generationExecuteBody(value: unknown): {
  intentDigest: string;
} {
  const body = JSON.parse(generationCanonicalJson(value)) as Record<
    string,
    unknown
  >;
  if (
    !body ||
    Array.isArray(body) ||
    Object.keys(body).length !== 1 ||
    typeof body.intentDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(body.intentDigest)
  )
    invalidGenerationInput();
  return { intentDigest: body.intentDigest };
}
export function generationRecoverBody(value: unknown): void {
  if (value !== undefined && generationCanonicalJson(value) !== "{}")
    invalidGenerationInput();
}
