import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';

export class PresignSellerDocumentDto {
  @ApiProperty({ example: '产品目录-2026.pdf' })
  @IsString()
  @Length(1, 255)
  filename!: string;

  @ApiProperty({
    example: 'application/pdf',
    description: 'pdf / docx / pptx / xlsx / text/plain / text/markdown',
  })
  @IsString()
  @Length(1, 120)
  mime!: string;

  @ApiProperty({ description: '字节数（≤50MB，txt/md ≤10MB）', minimum: 1, maximum: 52_428_800 })
  @IsInt()
  @Min(1)
  @Max(52_428_800)
  size!: number;
}

export class PresignSellerDocumentResponseDto {
  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty({ format: 'uri' })
  uploadUrl!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiresAt!: Date;
}

export class SellerDocumentDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  companyId!: string;

  @ApiProperty()
  filename!: string;

  @ApiProperty()
  mime!: string;

  @ApiProperty({ description: '字节数（字符串表示，避免 JSON 大整数截断）' })
  sizeBytes!: string;

  @ApiProperty({ enum: ['pdf', 'docx', 'pptx', 'txt', 'md', 'other'] })
  kind!: string;

  @ApiProperty({
    enum: ['pending_upload', 'committing', 'queued', 'processing', 'ready', 'failed_terminal', 'rejected', 'deleted'],
  })
  status!: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  processingErrorCode!: string | null;

  @ApiProperty()
  chunkCount!: number;

  @ApiPropertyOptional({ type: String, format: 'date-time', nullable: true })
  factsExtractedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  static from(row: {
    id: string;
    companyId: string;
    filename: string;
    mime: string;
    sizeBytes: bigint;
    kind: string;
    status: string;
    processingErrorCode: string | null;
    chunkCount: number;
    factsExtractedAt: Date | null;
    createdAt: Date;
  }): SellerDocumentDto {
    return {
      id: row.id,
      companyId: row.companyId,
      filename: row.filename,
      mime: row.mime,
      sizeBytes: row.sizeBytes.toString(),
      kind: row.kind,
      status: row.status,
      processingErrorCode: row.processingErrorCode,
      chunkCount: row.chunkCount,
      factsExtractedAt: row.factsExtractedAt ? row.factsExtractedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
