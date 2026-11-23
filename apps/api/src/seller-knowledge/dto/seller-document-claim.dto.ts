import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsString,
  IsUUID,
  Length,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

const SHA256 = /^[0-9a-f]{64}$/;
const CLAIM_TYPE = /^[A-Za-z0-9._:-]{1,50}$/;

export class DocumentClaimSourceRefDto {
  @ApiProperty({ format: 'uuid', description: '当前可读 ready 文档 id（不得跨公司）' })
  @IsUUID()
  documentId!: string;

  @ApiProperty({ description: '服务端读取端口返回的文档内容 sha256', maxLength: 64 })
  @Matches(SHA256)
  documentContentHash!: string;

  @ApiProperty({ description: '发布的解析修订（读取端口返回）', minimum: 1 })
  @IsInt()
  @Min(1)
  parseRevision!: number;

  @ApiProperty({ description: '分块序号', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(1_000_000)
  chunkSeq!: number;

  @ApiProperty({ description: '分块文本 sha256（读取端口返回）', maxLength: 64 })
  @Matches(SHA256)
  chunkTextHash!: string;

  @ApiProperty({ description: '选区起始字节（UTF-8，服务端核验）', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(4_000_000)
  quoteStartByte!: number;

  @ApiProperty({ description: '选区结束字节（UTF-8，不截断多字节）', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(4_000_000)
  quoteEndByte!: number;
}

export class PreviewDocumentClaimDto {
  @ApiProperty({ type: DocumentClaimSourceRefDto })
  @ValidateNested()
  @Type(() => DocumentClaimSourceRefDto)
  reference!: DocumentClaimSourceRefDto;

  @ApiProperty({ description: 'Claim 类型（1–50，字母数字 ._: -）', maxLength: 50 })
  @IsString()
  @Matches(CLAIM_TYPE)
  type!: string;

  @ApiProperty({ description: '人审陈述（≤4000 字符）', maxLength: 4000 })
  @IsString()
  @Length(1, 4000)
  statement!: string;
}

export class CreateDocumentClaimDraftDto extends PreviewDocumentClaimDto {
  @ApiProperty({ description: 'preview 返回的规范请求摘要；写入口独立重算', maxLength: 64 })
  @Matches(SHA256)
  requestDigest!: string;
}

export class DocumentChunkViewDto {
  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty({ maxLength: 64 })
  documentContentHash!: string;

  @ApiProperty({ minimum: 1 })
  parseRevision!: number;

  @ApiProperty({ minimum: 0 })
  chunkSeq!: number;

  @ApiProperty({ maxLength: 64 })
  chunkTextHash!: string;

  @ApiProperty()
  text!: string;

  @ApiPropertyOptional({ type: Object, nullable: true, description: '页/章节等结构上下文；未知为 null' })
  context!: Record<string, unknown> | null;
}

export class DocumentClaimPreviewDto {
  @ApiProperty({ format: 'uuid' })
  documentId!: string;

  @ApiProperty({ maxLength: 64 })
  documentContentHash!: string;

  @ApiProperty({ minimum: 1 })
  parseRevision!: number;

  @ApiProperty({ minimum: 0 })
  chunkSeq!: number;

  @ApiProperty()
  quote!: string;

  @ApiProperty({ minimum: 0 })
  quoteStartByte!: number;

  @ApiProperty({ minimum: 0 })
  quoteEndByte!: number;

  @ApiProperty({ maxLength: 64 })
  quoteDigest!: string;

  @ApiProperty({ maxLength: 64 })
  statementDigest!: string;

  @ApiProperty({ maxLength: 64 })
  bindingHash!: string;

  @ApiProperty({ maxLength: 64 })
  requestDigest!: string;

  @ApiProperty({ type: Object, nullable: true, description: '页/章节等解释上下文；未知为 null' })
  context!: Record<string, unknown> | null;
}

export class DocumentClaimDraftDto {
  @ApiProperty({ format: 'uuid' })
  claimId!: string;

  @ApiProperty({ format: 'uuid' })
  evidenceId!: string;

  @ApiProperty({ format: 'uuid' })
  referenceId!: string;

  @ApiProperty({ maxLength: 64 })
  bindingHash!: string;

  @ApiProperty({ enum: ['NEEDS_REVIEW', 'APPROVED', 'REJECTED', 'REVOKED'] })
  status!: string;

  @ApiProperty({ minimum: 1 })
  claimVersion!: number;

  @ApiProperty({ description: '同来源/陈述重放返回原件；不重置审批记录' })
  replayed!: boolean;

  @ApiProperty({ description: '当前文档/引用是否仍可读且与绑定一致' })
  available!: boolean;
}
