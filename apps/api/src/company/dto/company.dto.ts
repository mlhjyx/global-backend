import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class PublicContactDto {
  @ApiProperty({ enum: ['email', 'phone', 'social'] })
  type!: string;

  @ApiProperty({ example: 'sales@acme-tech.com' })
  value!: string;

  @ApiProperty({ description: '该联系方式被发现的页面 URL（溯源）' })
  sourceUrl!: string;
}

export class CompanyDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Shenzhen Acme Tech Co.' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'https://acme-tech.com' })
  website!: string | null;

  @ApiProperty({ enum: ['DRAFT', 'ENRICHING', 'REVIEW', 'ACTIVE'] })
  status!: string;

  @ApiPropertyOptional({ nullable: true, description: '行业（理解工作流回填）' })
  industry!: string | null;

  @ApiPropertyOptional({ nullable: true, description: '企业简介（抽取，可人工修正）' })
  summary!: string | null;

  @ApiProperty({
    type: [PublicContactDto],
    description: '官网确定性抽取的公开联系方式/社媒（正则命中，非 AI 生成，逐条带来源页）',
  })
  publicContacts!: PublicContactDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  static from(c: {
    id: string;
    name: string;
    website: string | null;
    status: string;
    industry?: string | null;
    summary?: string | null;
    publicContacts?: unknown;
    createdAt: Date;
  }): CompanyDto {
    return {
      id: c.id,
      name: c.name,
      website: c.website,
      status: c.status,
      industry: c.industry ?? null,
      summary: c.summary ?? null,
      publicContacts: Array.isArray(c.publicContacts) ? (c.publicContacts as PublicContactDto[]) : [],
      createdAt: c.createdAt.toISOString(),
    };
  }
}

export class OfferingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'CNC 精密加工件' })
  name!: string;

  @ApiPropertyOptional({ nullable: true })
  description!: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '结构化属性（moq/lead_time/materials/params/certifications…，仅来源文本明确出现的）',
  })
  attributes!: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true, description: '溯源：来自哪个页面' })
  sourceUrl!: string | null;

  @ApiPropertyOptional({ nullable: true, description: '来源页原文片段' })
  evidence!: string | null;

  @ApiPropertyOptional({ nullable: true })
  confidence!: number | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  static from(o: {
    id: string;
    name: string;
    description: string | null;
    attributes: unknown;
    sourceUrl: string | null;
    evidence: string | null;
    confidence: number | null;
    createdAt: Date;
  }): OfferingDto {
    return {
      id: o.id,
      name: o.name,
      description: o.description,
      attributes: (o.attributes as Record<string, unknown>) ?? null,
      sourceUrl: o.sourceUrl,
      evidence: o.evidence,
      confidence: o.confidence,
      createdAt: o.createdAt.toISOString(),
    };
  }
}

export class PageDto {
  @ApiPropertyOptional({ nullable: true, description: '下一页游标；null 表示到底' })
  nextCursor!: string | null;

  @ApiProperty()
  hasMore!: boolean;
}

export class CompanyListDto {
  @ApiProperty({ type: [CompanyDto] })
  data!: CompanyDto[];

  @ApiProperty({ type: PageDto })
  page!: PageDto;
}
