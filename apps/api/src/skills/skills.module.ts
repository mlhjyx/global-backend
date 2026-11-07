import { Module } from "@nestjs/common";
import { SkillsController } from "./skills.controller";
import { SkillsService } from "./skills.service";

/** S0 Skill Runtime：技能注册表 ops 面（执行侧解析/快照在 skill-runtime / skill-resolver）。 */
@Module({
  controllers: [SkillsController],
  providers: [SkillsService],
})
export class SkillsModule {}
