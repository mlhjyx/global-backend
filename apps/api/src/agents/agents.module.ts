import { Module } from "@nestjs/common";
import { AgentsController } from "./agents.controller";
import { AgentsService } from "./agents.service";

/** M2 步 9b 多 agent 编排 v0：agent 注册表 ops 面（执行侧解析/轨迹在 agent-runtime / agent-resolver / agent-decision-trace.store）。 */
@Module({
  controllers: [AgentsController],
  providers: [AgentsService],
})
export class AgentsModule {}
