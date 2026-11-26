import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

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

  @ApiPropertyOptional({
    enum: ['direct', 'multipart'],
    description: '推荐上传通道：配置独立公网对象存储时为 direct，其余环境推荐 multipart 分片上传',
  })
  uploadMode?: 'direct' | 'multipart';

  @ApiPropertyOptional({
    description: '是否支持浏览器直传 presigned uploadUrl（本地/内网穿透环境为 false）',
  })
  directUploadSupported?: boolean;

  @ApiPropertyOptional({
    description: '推荐分片大小（字节，S3/MinIO 协议下限 5 MiB）',
    example: 5_242_880,
  })
  partSizeBytes?: number;
}

export class InitSellerDocumentMultipartResponseDto {
  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty({ description: 'S3 Multipart UploadId，供后续分片上传与合并使用' })
  uploadId!: string;

  @ApiProperty({ description: '推荐分片大小（字节，默认 5 MiB）', example: 5_242_880 })
  partSizeBytes!: number;
}

export class UploadSellerDocumentPartResponseDto {
  @ApiProperty({ minimum: 1, maximum: 100 })
  partNumber!: number;

  @ApiProperty({ description: '对象存储返回的分片 ETag' })
  etag!: string;
}

export class MultipartCompletedPartDto {
  @ApiProperty({ minimum: 1, maximum: 100 })
  @IsInt()
  @Min(1)
  @Max(100)
  partNumber!: number;

  @ApiProperty({ description: '分片上传返回的 ETag' })
  @IsString()
  @Length(1, 200)
  etag!: string;
}

export class CompleteSellerDocumentMultipartDto {
  @ApiProperty({ description: 'multipart/init 返回的 uploadId' })
  @IsString()
  @Length(1, 512)
  uploadId!: string;

  @ApiProperty({ type: [MultipartCompletedPartDto], description: '已上传分片清单' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => MultipartCompletedPartDto)
  parts!: MultipartCompletedPartDto[];
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

  @ApiPropertyOptional({ type: 'object', additionalProperties: true, nullable: true })
  parsedMeta?: Record<string, unknown> | null;

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
    parsedMeta?: unknown;
    factsExtractedAt: Date | null;
    createdAt: Date;
  }): SellerDocumentDto {
    const parsedMeta =
      row.parsedMeta && typeof row.parsedMeta === 'object' && !Array.isArray(row.parsedMeta)
        ? (row.parsedMeta as Record<string, unknown>)
        : null;
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
      ...(parsedMeta ? { parsedMeta } : {}),
      factsExtractedAt: row.factsExtractedAt ? row.factsExtractedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
