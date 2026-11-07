import { Module } from "@nestjs/common";
import { PackStudioService } from "./pack-studio.service";
import { PacksController } from "./packs.controller";

/** S1 Pack Studio：草稿/校验/试跑/评测/发布/激活/灰度/启停（引擎 ops 面）。 */
@Module({
  controllers: [PacksController],
  providers: [PackStudioService],
})
export class PacksModule {}
