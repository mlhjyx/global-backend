import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length } from 'class-validator';

export class UpdateWorkspaceDto {
  @ApiProperty({ example: 'Acme Export Co.', minLength: 1, maxLength: 128 })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 128)
  name!: string;
}

export class WorkspaceDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  name!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;

  static from(row: {
    id: string;
    name: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): WorkspaceDto {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

export class WorkspaceCompaniesUsageDto {
  @ApiProperty() total!: number;
  @ApiProperty() draft!: number;
  @ApiProperty() enriching!: number;
  @ApiProperty() review!: number;
  @ApiProperty() active!: number;
}

export class WorkspaceSellerDocumentQuotaDto {
  @ApiProperty() maxPerWorkspace!: number;
  @ApiProperty() maxPerCompany!: number;
  @ApiProperty() maxBytesPerWorkspace!: number;
}

export class WorkspaceSellerDocumentsUsageDto {
  @ApiProperty() total!: number;
  @ApiProperty() ready!: number;
  @ApiProperty() pendingUpload!: number;
  @ApiProperty() processing!: number;
  @ApiProperty() failed!: number;
  @ApiProperty() totalBytes!: number;
  @ApiProperty() readyBytes!: number;
  @ApiProperty() pendingUploadBytes!: number;
  @ApiProperty({ type: WorkspaceSellerDocumentQuotaDto })
  quota!: WorkspaceSellerDocumentQuotaDto;
}

export class WorkspaceIcpsUsageDto {
  @ApiProperty() total!: number;
}

export class WorkspaceDiscoveryRunsUsageDto {
  @ApiProperty() total!: number;
  @ApiProperty() running!: number;
  @ApiProperty() completed!: number;
  @ApiProperty() failed!: number;
}

export class WorkspaceCanonicalCompaniesUsageDto {
  @ApiProperty() total!: number;
  @ApiProperty() suppressed!: number;
}

export class WorkspaceCanonicalContactsUsageDto {
  @ApiProperty() total!: number;
}

export class WorkspaceSiteAssetsUsageDto {
  @ApiProperty() total!: number;
  @ApiProperty() totalBytes!: number;
  @ApiProperty() variants!: number;
  @ApiProperty() variantBytes!: number;
}

export class WorkspaceSiteReleasesUsageDto {
  @ApiProperty() total!: number;
  @ApiProperty() ready!: number;
}

export class WorkspaceOperationArtifactsUsageDto {
  @ApiProperty() total!: number;
  @ApiProperty() totalBytes!: number;
  @ApiProperty() personalDataCount!: number;
  @ApiProperty() personalDataBytes!: number;
}

export class WorkspaceUsageSummaryDto {
  @ApiProperty({ format: 'uuid' })
  workspaceId!: string;

  @ApiProperty({ type: WorkspaceCompaniesUsageDto })
  companies!: WorkspaceCompaniesUsageDto;

  @ApiProperty({ type: WorkspaceSellerDocumentsUsageDto })
  sellerDocuments!: WorkspaceSellerDocumentsUsageDto;

  @ApiProperty({ type: WorkspaceIcpsUsageDto })
  icps!: WorkspaceIcpsUsageDto;

  @ApiProperty({ type: WorkspaceDiscoveryRunsUsageDto })
  discoveryRuns!: WorkspaceDiscoveryRunsUsageDto;

  @ApiProperty({ type: WorkspaceCanonicalCompaniesUsageDto })
  canonicalCompanies!: WorkspaceCanonicalCompaniesUsageDto;

  @ApiProperty({ type: WorkspaceCanonicalContactsUsageDto })
  canonicalContacts!: WorkspaceCanonicalContactsUsageDto;

  @ApiProperty({ type: WorkspaceSiteAssetsUsageDto })
  siteAssets!: WorkspaceSiteAssetsUsageDto;

  @ApiProperty({ type: WorkspaceSiteReleasesUsageDto })
  siteReleases!: WorkspaceSiteReleasesUsageDto;

  @ApiProperty({ type: WorkspaceOperationArtifactsUsageDto })
  operationArtifacts!: WorkspaceOperationArtifactsUsageDto;
}
