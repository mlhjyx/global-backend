import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CompanyDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Shenzhen Acme Tech Co.' })
  name!: string;

  @ApiPropertyOptional({ nullable: true, example: 'https://acme-tech.com' })
  website!: string | null;

  @ApiProperty({ enum: ['DRAFT', 'ENRICHING', 'ACTIVE'] })
  status!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  static from(c: {
    id: string;
    name: string;
    website: string | null;
    status: string;
    createdAt: Date;
  }): CompanyDto {
    return {
      id: c.id,
      name: c.name,
      website: c.website,
      status: c.status,
      createdAt: c.createdAt.toISOString(),
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
