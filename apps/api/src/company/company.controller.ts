import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AuthGuard } from '../auth/auth.guard';
import { Ctx } from '../auth/ctx.decorator';
import { RequestContext } from '../auth/request-context';
import { CompanyService } from './company.service';
import { CreateCompanyDto } from './dto/create-company.dto';
import { CompanyDto, CompanyListDto } from './dto/company.dto';

@ApiTags('Companies')
@ApiBearerAuth()
@Controller('companies')
@UseGuards(AuthGuard)
export class CompanyController {
  constructor(private readonly companies: CompanyService) {}

  @Post()
  @HttpCode(202)
  @ApiOperation({ summary: '提交官网，创建企业画像并触发理解（异步）' })
  @ApiCreatedResponse({ type: CompanyDto })
  async create(@Ctx() ctx: RequestContext, @Body() dto: CreateCompanyDto): Promise<CompanyDto> {
    return CompanyDto.from(await this.companies.create(ctx, dto));
  }

  @Get()
  @ApiOperation({ summary: '列出当前 workspace 的企业画像（游标分页）' })
  @ApiOkResponse({ type: CompanyListDto })
  async list(
    @Ctx() ctx: RequestContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<CompanyListDto> {
    const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const r = await this.companies.list(ctx, n, cursor);
    return {
      data: r.data.map(CompanyDto.from),
      page: { nextCursor: r.nextCursor, hasMore: r.hasMore },
    };
  }

  @Get(':companyId')
  @ApiOperation({ summary: '按 id 获取企业画像（跨租户返回 404）' })
  @ApiOkResponse({ type: CompanyDto })
  async get(
    @Ctx() ctx: RequestContext,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ): Promise<CompanyDto> {
    return CompanyDto.from(await this.companies.get(ctx, companyId));
  }
}
