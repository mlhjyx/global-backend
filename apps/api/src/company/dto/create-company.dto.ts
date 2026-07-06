import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';

export class CreateCompanyDto {
  @ApiProperty({ example: 'https://acme-tech.com', description: '企业官网 URL' })
  @IsUrl()
  website!: string;

  @ApiPropertyOptional({
    example: 'Shenzhen Acme Tech Co.',
    description: '企业名称（可选；未填则先用域名占位，理解后回填）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;
}
