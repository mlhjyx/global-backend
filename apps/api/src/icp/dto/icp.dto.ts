import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const ICP_STATUSES = ['DRAFT', 'HYPOTHESIS', 'VALIDATING', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED'];

export class PersonaDto {
  @ApiProperty() title!: string;
  @ApiProperty({ type: [String] }) goals!: unknown;
  @ApiProperty({ type: [String] }) painPoints!: unknown;
}

export class BuyingRoleDto {
  @ApiProperty({ example: 'decision_maker' }) role!: string;
  @ApiPropertyOptional({ nullable: true }) title!: string | null;
  @ApiProperty({ type: [String] }) concerns!: unknown;
}

interface IcpRow {
  id: string;
  companyId: string;
  name: string;
  status: string;
  companyAttributes: unknown;
  painPoints: unknown;
  triggerSignals: unknown;
  exclusions: unknown;
  valueProps: unknown;
  targetMarkets: unknown;
  version: number;
  createdAt: Date;
  personas?: { title: string; goals: unknown; painPoints: unknown }[];
  roles?: { role: string; title: string | null; concerns: unknown }[];
}

export class IcpDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) companyId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ICP_STATUSES }) status!: string;
  @ApiProperty({ description: '目标公司属性：行业/规模/地区/技术等' }) companyAttributes!: unknown;
  @ApiProperty({ type: [String] }) painPoints!: unknown;
  @ApiProperty({ type: [String] }) triggerSignals!: unknown;
  @ApiProperty({ type: [String] }) exclusions!: unknown;
  @ApiProperty({ type: [String] }) valueProps!: unknown;
  @ApiProperty({ type: [String] }) targetMarkets!: unknown;
  @ApiProperty() version!: number;
  @ApiProperty({ type: [PersonaDto] }) personas!: PersonaDto[];
  @ApiProperty({ type: [BuyingRoleDto] }) buyingCommittee!: BuyingRoleDto[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;

  static from(icp: IcpRow): IcpDto {
    return {
      id: icp.id,
      companyId: icp.companyId,
      name: icp.name,
      status: icp.status,
      companyAttributes: icp.companyAttributes,
      painPoints: icp.painPoints,
      triggerSignals: icp.triggerSignals,
      exclusions: icp.exclusions,
      valueProps: icp.valueProps,
      targetMarkets: icp.targetMarkets,
      version: icp.version,
      personas: (icp.personas ?? []).map((p) => ({
        title: p.title,
        goals: p.goals,
        painPoints: p.painPoints,
      })),
      buyingCommittee: (icp.roles ?? []).map((r) => ({
        role: r.role,
        title: r.title,
        concerns: r.concerns,
      })),
      createdAt: icp.createdAt.toISOString(),
    };
  }
}
