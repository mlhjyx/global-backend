import { Injectable, Module } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";
import { PrismaAgentDecisionTraceStore } from "./agent-decision-trace.store";
import { RunTraceController } from "./run-trace.controller";
import { RunTraceService } from "./run-trace.service";

/**
 * M2 步 9b 多 agent 编排 v0：agent 注册表 ops 面（执行侧解析/轨迹在 agent-runtime / agent-resolver /
 * agent-decision-trace.store）；9b-4 起提供 run 决策轨迹的租户只读端点。
 */

/** DI 壳：轨迹 store 的构造参数是 Pick<PrismaService>，Nest 无法按类型注入，这里收窄成 PrismaService。 */
@Injectable()
class InjectableAgentDecisionTraceStore extends PrismaAgentDecisionTraceStore {
  constructor(prisma: PrismaService) {
    super(prisma);
  }
}

@Module({
  controllers: [AgentsController, RunTraceController],
  providers: [
    AgentsService,
    RunTraceService,
    { provide: PrismaAgentDecisionTraceStore, useClass: InjectableAgentDecisionTraceStore },
  ],
})
export class AgentsModule {}
