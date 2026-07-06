import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const CLAIM_STATUSES = ['INGESTED', 'EXTRACTED', 'NEEDS_REVIEW', 'APPROVED', 'EXPIRED', 'REVOKED'];

export class ClaimDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  companyId!: string;

  @ApiProperty({ example: 'certification' })
  type!: string;

  @ApiProperty({ example: '产品通过 ISO 9001 与 CE 认证' })
  statement!: string;

  @ApiProperty({ enum: CLAIM_STATUSES })
  status!: string;

  @ApiPropertyOptional({ nullable: true, example: 0.95 })
  confidence!: number | null;

  @ApiProperty({ description: '乐观锁版本' })
  version!: number;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  static from(c: {
    id: string;
    companyId: string;
    type: string;
    statement: string;
    status: string;
    confidence: number | null;
    version: number;
    createdAt: Date;
  }): ClaimDto {
    return {
      id: c.id,
      companyId: c.companyId,
      type: c.type,
      statement: c.statement,
      status: c.status,
      confidence: c.confidence,
      version: c.version,
      createdAt: c.createdAt.toISOString(),
    };
  }
}
