export const DATA_EXPORT_SCOPES = [
  'leads',
  'companies',
  'contacts',
  'outreach',
  'full_archive',
] as const;

export type DataExportScope = (typeof DATA_EXPORT_SCOPES)[number];

export const DATA_EXPORT_FORMATS = ['csv', 'jsonl'] as const;

export type DataExportFormat = (typeof DATA_EXPORT_FORMATS)[number];

export const DATA_EXPORT_STATUSES = [
  'pending',
  'processing',
  'ready',
  'failed',
  'expired',
] as const;

export type DataExportStatus = (typeof DATA_EXPORT_STATUSES)[number];

export interface DataExportJobRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly requestedBy: string;
  readonly scope: DataExportScope;
  readonly format: DataExportFormat;
  readonly status: DataExportStatus;
  readonly objectKey: string | null;
  readonly contentType: string | null;
  readonly filename: string | null;
  readonly byteSize: bigint | null;
  readonly rowCount: number | null;
  readonly errorCode: string | null;
  readonly expiresAt: Date | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DataExportWorkflowInput {
  readonly workspaceId: string;
  readonly exportId: string;
}

export interface DataExportWorkflowResult {
  readonly status: DataExportStatus;
  readonly rowCount: number;
  readonly byteSize: number;
}
