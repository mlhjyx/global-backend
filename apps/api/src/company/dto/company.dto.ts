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

  @ApiProperty({ type: String, nullable: true, example: 'https://acme-tech.com' })
  website!: string | null;

  @ApiProperty({ enum: ['DRAFT', 'ENRICHING', 'REVIEW', 'ACTIVE'] })
  status!: string;

  @ApiProperty({ type: String, nullable: true, description: '行业（注册引导填写或理解工作流回填）' })
  industry!: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '受控行业码（canonical_taxonomy kind=industry 的 ISIC code；自由文本行业时为空）',
  })
  industryCode!: string | null;

  @ApiPropertyOptional({
    type: [String],
    description: '目标市场（ISO 3166-1 alpha-2；注册引导填写，卖家事实 SoR）',
  })
  targetMarkets!: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: '业务邮箱（公司级询盘接收缺省值；注册引导填写）',
  })
  businessEmail!: string | null;

  @ApiProperty({ type: String, nullable: true, description: '企业简介（抽取，可人工修正）' })
  summary!: string | null;

  @ApiProperty({
    type: [PublicContactDto],
    description: '官网确定性抽取的公开联系方式/社媒（正则命中，非 AI 生成，逐条带来源页）',
  })
  publicContacts!: PublicContactDto[];

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    required: false,
    description: '最近一次理解失败的时间；非空且状态为 DRAFT 时表示可以重试（老响应没有该字段时视为未知）',
  })
  understandingFailedAt!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    required: false,
    description: '最近一次理解失败的错误标签（stage:ErrorType，如 extract:ProviderHttpError）',
  })
  understandingLastError!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiPropertyOptional({
    enum: ['started', 'not_started'],
    description:
      '仅创建响应携带：理解是否已触发；无官网时恒为 not_started（D17），档案字段仍已保存',
  })
  understanding?: 'started' | 'not_started';

  static from(
    c: {
      id: string;
      name: string;
      website: string | null;
      status: string;
      industry?: string | null;
      industryCode?: string | null;
      targetMarkets?: string[];
      businessEmail?: string | null;
      summary?: string | null;
      publicContacts?: unknown;
      understandingFailedAt?: Date | null;
      understandingLastError?: string | null;
      createdAt: Date;
      understanding?: 'started' | 'not_started';
    },
  ): CompanyDto {
    return {
      id: c.id,
      name: c.name,
      website: c.website,
      status: c.status,
      industry: c.industry ?? null,
      industryCode: c.industryCode ?? null,
      targetMarkets: c.targetMarkets ?? [],
      businessEmail: c.businessEmail ?? null,
      summary: c.summary ?? null,
      publicContacts: Array.isArray(c.publicContacts) ? (c.publicContacts as PublicContactDto[]) : [],
      understandingFailedAt: c.understandingFailedAt ? c.understandingFailedAt.toISOString() : null,
      understandingLastError: c.understandingLastError ?? null,
      createdAt: c.createdAt.toISOString(),
      ...(c.understanding === undefined ? {} : { understanding: c.understanding }),
    };
  }
}

export class OfferingDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'CNC 精密加工件' })
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description: '结构化属性（moq/lead_time/materials/params/certifications…，仅来源文本明确出现的）',
  })
  attributes!: Record<string, unknown> | null;

  @ApiProperty({ type: String, nullable: true, description: '溯源：来自哪个页面' })
  sourceUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, description: '来源页原文片段' })
  evidence!: string | null;

  @ApiProperty({ type: Number, nullable: true })
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
