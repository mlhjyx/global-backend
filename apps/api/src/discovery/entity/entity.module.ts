import { Module } from '@nestjs/common';
import { CompanyLegalLinksController } from './company-legal-links.controller';
import { LegalLinksService } from './legal-links.service';

/**
 * 获客挖掘 vNext W2：实体级消歧与公司图谱（PrismaService 来自全局 PrismaModule）。
 * VIES 校验器经 LEGAL_LINK_VAT_VALIDATOR 令牌可选注入；默认不提供 → VAT 命中落 review、不出网。
 */
@Module({
  controllers: [CompanyLegalLinksController],
  providers: [LegalLinksService],
})
export class EntityModule {}
