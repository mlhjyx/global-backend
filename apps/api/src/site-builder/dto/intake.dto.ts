import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsUrl,
  Length,
  Matches,
  ValidateNested,
} from "class-validator";
import type { IntakeResult } from "../intake.service";

export class IntakeCompanyDto {
  @ApiProperty({ description: "公司中文名" })
  @IsString()
  @Length(1, 200)
  nameZh!: string;

  @ApiPropertyOptional({
    type: String,
    description: "公司英文名（缺省时系统转写并让用户确认，M1）",
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Length(1, 200)
  nameEn?: string | null;
}

/** 注册引导 6 项必填（01 §3.1）。 */
export class IntakeDto {
  @ApiProperty({ type: IntakeCompanyDto })
  @ValidateNested()
  @Type(() => IntakeCompanyDto)
  company!: IntakeCompanyDto;

  @ApiProperty({
    description: "所属行业（taxonomy id，级联细分）",
    example: "isic-2813",
  })
  @IsString()
  @Length(1, 120)
  industry!: string;

  @ApiProperty({
    type: [String],
    description: "主营产品关键词 1~5 个",
    minItems: 1,
    maxItems: 5,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(5)
  @IsString({ each: true })
  @Length(1, 120, { each: true })
  products!: string[];

  @ApiProperty({
    type: [String],
    description: "目标市场（ISO 3166-1 alpha-2，大写）",
    example: ["DE", "US"],
  })
  @IsArray()
  @ArrayMinSize(1)
  @Matches(/^[A-Z]{2}$/, { each: true })
  targetMarkets!: string[];

  @ApiProperty({
    description: "海外是否已有独立站（仅作品牌理解背景，不控制流程或栏目）",
  })
  @IsBoolean()
  hasWebsite!: boolean;

  @ApiPropertyOptional({
    type: String,
    format: "uri",
    description: "hasWebsite=true 时必填",
    nullable: true,
  })
  @IsOptional()
  @IsUrl({ require_protocol: true, protocols: ["https", "http"] })
  websiteUrl?: string | null;

  @ApiProperty({ description: "业务邮箱（兼作询盘接收缺省值）" })
  @IsEmail()
  businessEmail!: string;
}

export class IntakeResultDto {
  @ApiProperty({ format: "uuid" }) siteId!: string;
  @ApiProperty({ format: "uuid", description: "本次 demo v0 构建记录" })
  buildId!: string;
  @ApiProperty({
    enum: ["generating_demo"],
    description: "demo v0 已确认进入编排",
  })
  status!: "generating_demo";

  static from(result: IntakeResult): IntakeResultDto {
    return Object.assign(new IntakeResultDto(), result);
  }
}
