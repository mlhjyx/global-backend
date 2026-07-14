import { Global, Module } from '@nestjs/common';
import { SanctionsScreeningService } from './sanctions-screening.service';

/**
 * 制裁筛查模块（Qualify 第五门）。@Global（同 PrismaModule/ComplianceModule 惯例）：LeadService 等消费方
 * 无需逐一 import 即可注入 `SanctionsScreeningService`（进程内内存索引 + screen）。
 * 名单刷新走 Temporal 活动（worker 手工构造 SanctionsRefreshService，非本模块）。
 */
@Global()
@Module({
  providers: [SanctionsScreeningService],
  exports: [SanctionsScreeningService],
})
export class SanctionsModule {}
