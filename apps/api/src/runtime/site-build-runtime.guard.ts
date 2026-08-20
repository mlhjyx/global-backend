import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { RuntimeReadinessService } from '../health/runtime-readiness.service';

@Injectable()
export class SiteBuildRuntimeGuard {
  constructor(private readonly readiness: RuntimeReadinessService) {}

  async assertReady(): Promise<void> {
    const report = await this.readiness.checkHardComponents();
    if (report.status === 'ready') return;
    const failedComponents = Object.entries(report.components)
      .filter(([, component]) => component.status !== 'ok')
      .map(([component, status]) => ({
        component,
        code: status.code,
      }));
    throw new ServiceUnavailableException({
      error: {
        code: 'SITE_BUILD_RUNTIME_NOT_READY',
        message: 'site build runtime is not ready',
        details: { failedComponents },
      },
    });
  }
}
