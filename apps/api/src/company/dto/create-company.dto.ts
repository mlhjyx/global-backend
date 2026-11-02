import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * 建档入参（D7/D16/D17，2026-11-02）：注册引导的六项事实直接落到 CompanyProfile。
 * - `website` 变为可选：无官网的公司凭 `name` + 行业/产品/目标市场也能建档（理解不触发）。
 * - `products` 落 Offering（source=onboarding）；`industry`/`targetMarkets`/`businessEmail` 落 CompanyProfile。
 * - 至少提供 `website` 或 `name`，否则 400 VALIDATION_ERROR。
 */
export class CreateCompanyDto {
  @ApiPropertyOptional({
    example: 'https://acme-tech.com',
    description: '企业官网 URL（可选；缺省时不会触发官网理解）',
  })
  @IsOptional()
  @IsUrl()
  website?: string;

  @ApiPropertyOptional({
    example: 'Shenzhen Acme Tech Co.',
    description: '企业名称（可选；有官网未填则先用域名占位，理解后回填；无官网时必填其一）',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({
    example: 'isic-2813',
    description: '所属行业（taxonomy id 或自由文本，注册引导必填项之一）',
  })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  industry?: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['DE', 'US'],
    description: '目标市场（ISO 3166-1 alpha-2，大写；最多 20 个）',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(/^[A-Z]{2}$/, { each: true })
  targetMarkets?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: '主营产品关键词 1~5 个（落 Offering，source=onboarding）',
    minItems: 1,
    maxItems: 5,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Length(1, 120, { each: true })
  products?: string[];

  @ApiPropertyOptional({
    example: 'sales@acme-tech.com',
    description: '业务邮箱（公司级询盘接收缺省值）',
  })
  @IsOptional()
  @IsEmail()
  businessEmail?: string;
}
