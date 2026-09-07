import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { RuntimeAdmissionService } from './runtime-admission';
import { RuntimeReadinessService } from '../health/runtime-readiness.service';
import { Reflector } from '@nestjs/core';
import { READ_ONLY_CONTROL_PLANE_METADATA } from './read-only-control-plane.decorator';

const MUTATING_HTTP_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Managed runtime may expose health diagnostics while unready, but it must not
 * admit any HTTP operation that can create or mutate product work. Applying
 * this globally prevents an individual controller from bypassing admission.
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
    if (
      readOnlyControlPlane ||
      !MUTATING_HTTP_METHODS.has(method) ||
      (this.admission.current().admitted &&
        this.readiness.current().status === 'ready')
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
