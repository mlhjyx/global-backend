import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsUUID,
} from 'class-validator';

export class RecomputeUnderstandingDto {
  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description: '可选：限定只重算指定的 ready 文档 id 列表',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsUUID(undefined, { each: true })
  documentIds?: string[];

  @ApiPropertyOptional({
    default: false,
    description: '为 true 时强制重新扫描已提取过的 ready 文档（facts_extracted_at 非空）',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}

export class RecomputeUnderstandingResponseDto {
  @ApiProperty({ format: 'uuid' })
  companyId!: string;

  @ApiProperty({ enum: ['DRAFT', 'ENRICHING', 'REVIEW', 'ACTIVE'] })
  status!: string;

  @ApiProperty({ type: 'integer', minimum: 0 })
  documentsScanned!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  draftsCreated!: number;

  @ApiProperty({ type: 'integer', minimum: 0 })
  profileDraftsCreated!: number;
}
