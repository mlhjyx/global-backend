import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  Length,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * 注册引导完成（注册即建档第 1 步，2026-11-10）：把客户在理解预览里勾选的事实
 * 写回同一份档案。与 CreateCompanyDto 同构，减去 website（官网在预览启动时就已确定）。
 *
 * 允许在 DRAFT（无官网/理解失败后手填）与 REVIEW（预览就绪）写入；ENRICHING 拒绝，
 * 避免理解回填稍后覆盖客户选择。本端点只写卖家事实，零模型调用，不消费 Grant。
 */
export class OnboardingFactsDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200, description: '企业名称' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({
    example: 'isic-2813',
    description: '所属行业（自由文本；给出 industryCode 时可省略，由词表标签回填）',
  })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  industry?: string;

  @ApiPropertyOptional({
    example: '25',
    description: '受控行业码（canonical_taxonomy kind=industry 的 ISIC code）',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9.-]{0,31}$/u, { message: 'industryCode 格式不合法' })
  industryCode?: string;

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
  @MaxLength(320)
  businessEmail?: string;
}
