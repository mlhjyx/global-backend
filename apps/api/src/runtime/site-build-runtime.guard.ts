import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { RuntimeReadinessService } from "../health/runtime-readiness.service";

@Injectable()
export class SiteBuildRuntimeGuard {
  constructor(private readonly readiness: RuntimeReadinessService) {}

  async assertReady(input: { paidReachable: boolean }): Promise<void> {
    // Paid admission uses one report that refreshes hard components and the
    // settlement capability together. Two separate reports create a TOCTOU
    // window when a dependency changes between probes.
    const report = input.paidReachable
      ? await this.readiness.checkSiteBuilderPaidCapability()
      : await this.readiness.checkHardComponents();
    const failedComponents = Object.entries(report.components)
      .filter(([, component]) => component.status !== "ok")
      .map(([component, status]) => ({ component, code: status.code }));
    let failedCapabilities: Array<{ capability: string; code: string }> = [];
    if (input.paidReachable) {
      const settlement =
        report.capabilities.site_builder_model_settlement_readback;
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
