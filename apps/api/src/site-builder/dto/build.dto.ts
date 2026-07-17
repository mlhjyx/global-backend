import { BadRequestException } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';
import {
  SITE_SPEC_IDENTIFIER_PATTERN_SOURCE,
  SITE_SPEC_STYLE_PRESETS,
} from '@global/contracts';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const IDENTIFIER = new RegExp(`^${SITE_SPEC_IDENTIFIER_PATTERN_SOURCE}$`);
const BCP47_SHAPE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const BUILD_OPTION_KEYS = new Set(['stylePreset', 'pages', 'locales']);
const BUILD_REQUEST_KEYS = new Set(['scope', 'targetId', 'options']);

@ValidatorConstraint({ name: 'knownBuildOptionKeys', async: false })
class KnownBuildOptionKeys implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return (
      value === undefined ||
      (typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.keys(value).every((key) => BUILD_OPTION_KEYS.has(key)))
    );
  }

  defaultMessage(): string {
    return 'options contains an unknown field';
  }
}

export class BuildOptionsDto {
  @ApiPropertyOptional({ enum: [...SITE_SPEC_STYLE_PRESETS] })
  @IsOptional()
  @IsIn(SITE_SPEC_STYLE_PRESETS)
  stylePreset?: string;

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: 32,
    uniqueItems: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(32)
  @ArrayUnique()
  @Matches(IDENTIFIER, { each: true })
  pages?: string[];

  @ApiPropertyOptional({
    type: [String],
    minItems: 1,
    maxItems: 8,
    uniqueItems: true,
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(BCP47_SHAPE, { each: true })
  locales?: string[];
}

export class CreateBuildDto {
  @ApiProperty({ enum: ['site', 'page', 'section'] })
  @Transform(({ value, obj }: { value: unknown; obj: object }) => {
    if (Object.keys(obj).some((key) => !BUILD_REQUEST_KEYS.has(key))) {
      throw new BadRequestException({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'build request contains an unknown field',
        },
      });
    }
    return value;
  })
  @IsIn(['site', 'page', 'section'])
  scope!: 'site' | 'page' | 'section';

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 128,
    pattern: `^${SITE_SPEC_IDENTIFIER_PATTERN_SOURCE}$`,
    description: 'SiteSpec page/block identifier；page/section 暂未开放执行',
  })
  @IsOptional()
  @Matches(IDENTIFIER)
  targetId?: string;

  @ApiPropertyOptional({ type: () => BuildOptionsDto })
  @IsOptional()
  @Validate(KnownBuildOptionKeys)
  @ValidateNested()
  @Type(() => BuildOptionsDto)
  options?: BuildOptionsDto;
}
