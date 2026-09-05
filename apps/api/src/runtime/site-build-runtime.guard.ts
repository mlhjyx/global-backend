import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { RuntimeReadinessService } from "../health/runtime-readiness.service";

@Injectable()
export class SiteBuildRuntimeGuard {
  constructor(private readonly readiness: RuntimeReadinessService) {}

  async assertReady(input: { paidReachable: boolean }): Promise<void> {
    const report = await this.readiness.checkHardComponents();
    const failedComponents = Object.entries(report.components)
      .filter(([, component]) => component.status !== "ok")
      .map(([component, status]) => ({ component, code: status.code }));
    let failedCapabilities: Array<{ capability: string; code: string }> = [];
    if (report.status === "ready" && input.paidReachable) {
      const paid = await this.readiness.checkSiteBuilderPaidCapability();
      const settlement =
        paid.capabilities.site_builder_model_settlement_readback;
      if (settlement.status !== "ok") {
        failedCapabilities = [
          {
            capability: "site_builder_model_settlement_readback",
            code: settlement.code,
          },
        ];
      }
    }
    if (
      report.status === "ready" &&
      (!input.paidReachable || failedCapabilities.length === 0)
    ) {
      return;
    }
    throw new ServiceUnavailableException({
      error: {
        code: "SITE_BUILD_RUNTIME_NOT_READY",
        message: "site build runtime is not ready",
        details: { failedComponents, failedCapabilities },
      },
    });
  }
}
