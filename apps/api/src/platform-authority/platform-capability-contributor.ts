import {
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { RuntimeReadinessContributorRegistry } from "../runtime/runtime-readiness-registry";
import { RuntimeReleaseIdentityService } from "../runtime/runtime-release-identity";
import { RuntimeAdmissionService } from "../runtime/runtime-admission";
import {
  startCapabilityRuntime,
  type CapabilityRuntime,
} from "./platform-capability-runtime";

@Injectable()
export class PlatformCapabilityContributor
  implements OnModuleInit, OnModuleDestroy
{
  private runtime: CapabilityRuntime | undefined;
  constructor(
    private readonly registry: RuntimeReadinessContributorRegistry,
    private readonly release: RuntimeReleaseIdentityService,
    private readonly admission: RuntimeAdmissionService,
  ) {}
  onModuleInit(): void {
    if (this.runtime) return;
    const identity = this.release.current();
    this.runtime = startCapabilityRuntime({
      registry: this.registry,
      identity,
      admitted: () => {
        const current = this.release.current();
        return (
          this.admission.current().admitted &&
          identity.attested &&
          current.attested &&
          current.build_sha === identity.build_sha &&
          current.artifact_digest === identity.artifact_digest &&
          current.image_digest === identity.image_digest
        );
      },
    });
  }
  onModuleDestroy(): void {
    this.runtime?.stop();
    this.runtime = undefined;
  }
}
