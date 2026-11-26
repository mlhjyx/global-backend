import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Matches,
} from 'class-validator';
import {
  WORKSPACE_PURGE_STATUSES,
  type WorkspacePurgeReceiptRecord,
  type WorkspacePurgeStatus,
} from '../workspace-purge.types';

// eslint-disable-next-line no-control-regex -- reject ASCII control characters at HTTP boundary
const NO_CONTROL_CHARS = /^[^\u0000-\u001f\u007f]*$/u;

export class RequestWorkspacePurgeDto {
  @ApiProperty({ example: 'purge-ws-20261126-001', minLength: 1, maxLength: 128 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 128)
  @Matches(NO_CONTROL_CHARS, { message: 'idempotencyKey must not contain control characters' })
  idempotencyKey!: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('all')
  requestedBy?: string;

  @ApiPropertyOptional({ type: [String], format: 'uuid', maxItems: 100 })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('all', { each: true })
  campaignPlanJobIds?: string[];
}

export class WorkspacePurgeReceiptDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  workspaceId!: string;

  @ApiProperty()
  idempotencyKey!: string;

  @ApiProperty({ enum: WORKSPACE_PURGE_STATUSES })
  status!: WorkspacePurgeStatus;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  requestedBy!: string | null;

  @ApiProperty({ type: Object })
  cleanupManifest!: Record<string, unknown>;

  @ApiProperty({ type: Object, nullable: true })
  dbRowsDeleted!: Record<string, number> | null;

  @ApiProperty({ type: Object, nullable: true })
  minioObjectsDeleted!: {
    sellerDocuments: number;
    siteBuilder: number;
    operationArtifacts: number;
  } | null;

  @ApiProperty()
  redisKeysDeleted!: number;

  @ApiProperty()
  temporalWorkflowsCancelled!: number;

  @ApiProperty({ type: String, nullable: true })
  errorCode!: string | null;

  @ApiProperty()
  ruleVersion!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  startedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  completedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  static from(row: WorkspacePurgeReceiptRecord): WorkspacePurgeReceiptDto {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      idempotencyKey: row.idempotencyKey,
      status: row.status,
      requestedBy: row.requestedBy,
      cleanupManifest: row.cleanupManifest,
      dbRowsDeleted: row.dbRowsDeleted,
      minioObjectsDeleted: row.minioObjectsDeleted,
      redisKeysDeleted: row.redisKeysDeleted,
      temporalWorkflowsCancelled: row.temporalWorkflowsCancelled,
      errorCode: row.errorCode,
      ruleVersion: row.ruleVersion,
      startedAt: row.startedAt ? row.startedAt.toISOString() : null,
      completedAt: row.completedAt ? row.completedAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
