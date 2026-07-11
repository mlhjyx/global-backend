import { Global, Module } from '@nestjs/common';
import { DataRightsService } from './data-rights.service';
import { DeletionController } from './deletion.controller';
import { DeletionService } from './deletion.service';

/**
 * 收口⑥ 存储侧合规模块：DataRightsService（判定引擎 + jurisdiction_policy 启动 seed + policy_decision_log）
 * + DeletionService/DeletionController（PR-B 删除编排 GDPR Art.17：受理请求 + 事务性 outbox 触发 deletionWorkflow）。
 * PrismaService 由全局 PrismaModule 提供；TemporalClient（全局）由 relay dispatch 用于起 workflow。PII 加密走 pii-crypto 扩展。
 */
@Global() // 跨切合规服务（同本仓全局 PrismaModule 惯例）：消费方无需逐一 import 即可注入 exports
@Module({
  controllers: [DeletionController],
  providers: [DataRightsService, DeletionService],
  exports: [DataRightsService, DeletionService],
})
export class ComplianceModule {}
