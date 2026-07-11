import { Module } from '@nestjs/common';
import { DataRightsService } from './data-rights.service';

/**
 * 收口⑥ 存储侧合规模块：DataRightsService（判定引擎 + jurisdiction_policy 启动 seed + policy_decision_log）。
 * PrismaService 由全局 PrismaModule 提供。删除编排（PR-B）、PII 加密服务后续并入本模块。
 */
@Module({
  providers: [DataRightsService],
  exports: [DataRightsService],
})
export class ComplianceModule {}
