import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const ICP_STATUSES = ['DRAFT', 'HYPOTHESIS', 'VALIDATING', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED'];

export class PersonaDto {
  @ApiProperty() title!: string;
  @ApiProperty({ type: [String] }) goals!: unknown;
  @ApiProperty({ type: [String] }) painPoints!: unknown;
}

export class BuyingRoleDto {
  @ApiProperty({ example: 'decision_maker' }) role!: string;
  @ApiPropertyOptional({ type: String, nullable: true }) title!: string | null;
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
  rules?: {
    id: string;
    kind: string;
    field: string;
    operator: string;
    value: unknown;
    weight: number;
    rationale: string | null;
  }[];
}

export class IcpRuleDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['MUST_HAVE', 'NICE_TO_HAVE', 'EXCLUSION'] }) kind!: string;
  @ApiProperty() field!: string;
  @ApiProperty() operator!: string;
  @ApiProperty({ description: '操作数：标量或数组', oneOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: {} }] }) value!: unknown;
  @ApiProperty() weight!: number;
  @ApiPropertyOptional({ type: String, nullable: true }) rationale!: string | null;
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
  @ApiProperty({ type: [IcpRuleDto], description: '机器可评估的验证规则（LED-003）' })
  rules!: IcpRuleDto[];
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
      rules: (icp.rules ?? []).map((r) => ({
        id: r.id,
        kind: r.kind,
        field: r.field,
        operator: r.operator,
        value: r.value,
        weight: r.weight,
        rationale: r.rationale,
      })),
      createdAt: icp.createdAt.toISOString(),
    };
  }
}
