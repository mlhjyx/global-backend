import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { Site } from '@prisma/client';

export class SiteDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ description: '预览子域 slug' }) slug!: string;
  @ApiProperty({ enum: ['builder', 'diagnosis'] }) mode!: string;
  @ApiProperty({ enum: ['draft', 'building', 'ready', 'published', 'setup_failed'] }) status!: string;
  @ApiPropertyOptional({ nullable: true }) stylePreset!: string | null;
  @ApiProperty({ type: [String] }) locales!: unknown;
  @ApiPropertyOptional({ format: 'uuid', nullable: true }) activeVersionId!: string | null;
  @ApiPropertyOptional({ nullable: true, description: '预览地址（demo 就绪后非空）' })
  previewUrl!: string | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;

  static from(row: Site, previewUrl: string | null): SiteDto {
    const dto = new SiteDto();
    dto.id = row.id;
    dto.name = row.name;
    dto.slug = row.slug;
    dto.mode = row.mode;
    dto.status = row.status;
    dto.stylePreset = row.stylePreset;
    dto.locales = row.locales;
    dto.activeVersionId = row.activeVersionId;
    dto.previewUrl = previewUrl;
    dto.createdAt = row.createdAt;
    dto.updatedAt = row.updatedAt;
    return dto;
  }
}
