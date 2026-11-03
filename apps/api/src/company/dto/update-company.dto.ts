import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
} from 'class-validator';

/**
 * 公司档案编辑（2026-11-03）：只开放卖家自查事实（D16）与官网。
 * website 仍由服务的 SSRF 守卫校验；products 不在本期（属 Offering 对账，另立变更）。
 */
export class UpdateCompanyDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 200, description: '企业名称' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  name?: string;

  @ApiPropertyOptional({
    format: 'uri',
    maxLength: 2048,
    description: '企业官网（http/https）；补填后将可启动理解',
  })
  @IsOptional()
  @IsString()
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  @Length(1, 2048)
  website?: string;

  @ApiPropertyOptional({ maxLength: 200, description: '所属行业' })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  industry?: string;

  @ApiPropertyOptional({
    type: [String],
    description: '目标市场（ISO 3166-1 alpha-2），最多 30 个',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(30)
  @Matches(/^[A-Z]{2}$/u, { each: true, message: 'targetMarkets 必须是两位大写国家码' })
  targetMarkets?: string[];

  @ApiPropertyOptional({ format: 'email', maxLength: 320, description: '业务邮箱' })
  @IsOptional()
  @IsEmail()
  @Length(1, 320)
  businessEmail?: string;
}
