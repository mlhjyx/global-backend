import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const CLAIM_STATUSES = ['INGESTED', 'EXTRACTED', 'NEEDS_REVIEW', 'APPROVED', 'EXPIRED', 'REVOKED'];

export class ClaimEvidenceDto {
  @ApiProperty({ type: String, nullable: true, description: '来源 URL' })
  sourceUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, description: '来源原文片段' })
  snippet!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  confidence!: number | null;
}

interface ClaimRow {
  id: string;
  companyId: string;
  type: string;
  factKey: string | null;
  statement: string;
  status: string;
  confidence: number | null;
  version: number;
  createdAt: Date;
  evidence?: { sourceUrl: string | null; snippet: string | null; confidence: number | null }[];
}

export class ClaimDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  companyId!: string;

  @ApiProperty({ example: 'certification' })
  type!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: '机器投影 Claim 的规范化事实键；手工或历史 Claim 为 null',
    example: 'quality_certifications',
  })
  factKey!: string | null;

  @ApiProperty({ example: '产品通过 ISO 9001 与 CE 认证' })
  statement!: string;

  @ApiProperty({ enum: CLAIM_STATUSES })
  status!: string;

  @ApiProperty({ type: Number, nullable: true, example: 0.95 })
  confidence!: number | null;

  @ApiProperty({ description: '乐观锁版本' })
  version!: number;

  @ApiProperty({ type: [ClaimEvidenceDto], description: '溯源证据（来源 URL + 原文片段）' })
  evidence!: ClaimEvidenceDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  static from(c: ClaimRow): ClaimDto {
    return {
      id: c.id,
      companyId: c.companyId,
      type: c.type,
      factKey: c.factKey,
      statement: c.statement,
      status: c.status,
      confidence: c.confidence,
      version: c.version,
      evidence: (c.evidence ?? []).map((e) => ({
        sourceUrl: e.sourceUrl,
        snippet: e.snippet,
        confidence: e.confidence,
      })),
      createdAt: c.createdAt.toISOString(),
    };
  }
}
