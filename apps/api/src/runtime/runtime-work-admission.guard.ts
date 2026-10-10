import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RuntimeAdmissionService } from './runtime-admission';
import { RuntimeReadinessService } from '../health/runtime-readiness.service';
import { Reflector } from '@nestjs/core';
import { customerWriteAdmission } from './customer-write-admission';
import { READ_ONLY_CONTROL_PLANE_METADATA } from './read-only-control-plane.decorator';
import { RECOVERY_CONTROL_PLANE_METADATA, PLATFORM_REVOCATION_RECOVERY } from './recovery-control-plane.decorator';

const MUTATING_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Managed runtime may expose health diagnostics while unready, but it must not
 * admit any HTTP operation that can create or mutate product work. Applying
 * this globally prevents an individual controller from bypassing admission.
 * Customer writes are judged against the customer dependency set
 * (customerWriteAdmission), not aggregate readiness: an absent or not-yet-READY
 * platform worker keeps /health/ready at 503 but does not close them.
 */
@Injectable()
export class RuntimeWorkAdmissionGuard implements CanActivate {
  constructor(
    private readonly admission: RuntimeAdmissionService,
    private readonly readiness: RuntimeReadinessService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const method = String(
      context.switchToHttp().getRequest<{ method?: string }>().method ?? '',
    ).toUpperCase();
    const readOnlyControlPlane =
      method === 'POST' &&
      this.reflector.getAllAndOverride<boolean>(
        READ_ONLY_CONTROL_PLANE_METADATA,
        [context.getHandler(), context.getClass()],
      ) === true;
    const recoveryControlPlane = method === 'POST' &&
      this.reflector.get<string>(RECOVERY_CONTROL_PLANE_METADATA, context.getHandler()) === PLATFORM_REVOCATION_RECOVERY &&
      this.admission.current().admitted;
    if (
      readOnlyControlPlane ||
      recoveryControlPlane ||
      !MUTATING_HTTP_METHODS.has(method) ||
      (this.admission.current().admitted &&
        customerWriteAdmission(this.readiness.current()).open)
    ) {
      return true;
    }
    throw new ServiceUnavailableException({
      message: 'RUNTIME_ADMISSION_CLOSED',
      error: {
        code: 'RUNTIME_ADMISSION_CLOSED',
        message: 'managed runtime is not ready to accept new work',
      },
    });
  }
}
