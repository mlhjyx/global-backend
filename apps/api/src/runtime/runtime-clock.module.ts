import { Module } from "@nestjs/common";
import { RuntimeClockController } from "./runtime-clock.controller";
import { RuntimeClockService } from "./runtime-clock.service";
import { RuntimeAdmissionService } from "./runtime-admission";
import { RuntimeReleaseIdentityService } from "./runtime-release-identity";

@Module({
  controllers: [RuntimeClockController],
  providers: [
    {
      provide: RuntimeClockService,
      inject: [RuntimeAdmissionService, RuntimeReleaseIdentityService],
      useFactory: (
        admission: RuntimeAdmissionService,
        identity: RuntimeReleaseIdentityService,
      ) => new RuntimeClockService(admission, identity),
    },
  ],
})
export class RuntimeClockModule {}
