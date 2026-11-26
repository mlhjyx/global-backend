import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import {
  DATA_EXPORT_FORMATS,
  DATA_EXPORT_SCOPES,
  DATA_EXPORT_STATUSES,
  type DataExportFormat,
  type DataExportJobRecord,
  type DataExportScope,
  type DataExportStatus,
} from '../data-exports.types';

export class CreateDataExportDto {
  @ApiProperty({ enum: DATA_EXPORT_SCOPES, example: 'leads' })
  @IsIn(DATA_EXPORT_SCOPES as unknown as string[])
  scope!: DataExportScope;

  @ApiProperty({ enum: DATA_EXPORT_FORMATS, example: 'csv' })
  @IsIn(DATA_EXPORT_FORMATS as unknown as string[])
  format!: DataExportFormat;
}

export class DataExportJobDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  workspaceId!: string;

  @ApiProperty({ format: 'uuid' })
  requestedBy!: string;

  @ApiProperty({ enum: DATA_EXPORT_SCOPES })
  scope!: DataExportScope;

  @ApiProperty({ enum: DATA_EXPORT_FORMATS })
  format!: DataExportFormat;

  @ApiProperty({ enum: DATA_EXPORT_STATUSES })
  status!: DataExportStatus;

  @ApiProperty({ type: String, nullable: true })
  contentType!: string | null;

  @ApiProperty({ type: String, nullable: true })
  filename!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  byteSize!: number | null;

  @ApiProperty({ type: Number, nullable: true })
  rowCount!: number | null;

  @ApiProperty({ type: String, nullable: true })
  errorCode!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  expiresAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  static from(row: DataExportJobRecord): DataExportJobDto {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      requestedBy: row.requestedBy,
      scope: row.scope,
      format: row.format,
      status: row.status,
      contentType: row.contentType,
      filename: row.filename,
      byteSize: row.byteSize !== null ? Number(row.byteSize) : null,
      rowCount: row.rowCount,
      errorCode: row.errorCode,
      expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
