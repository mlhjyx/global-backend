import { SetMetadata } from '@nestjs/common';

export const RECOVERY_CONTROL_PLANE_METADATA = 'runtime:recovery-control-plane' as const;
export const PLATFORM_REVOCATION_RECOVERY = 'platform-authority-revocation' as const;

/** Exact signed revocation recovery, not a read-only or general mutation bypass.
 * The handler must independently authenticate the command, bound its resources,
 * and enforce the durable fence. Release admission is never waived. */
export function PlatformRevocationRecovery(): MethodDecorator {
  return SetMetadata(RECOVERY_CONTROL_PLANE_METADATA, PLATFORM_REVOCATION_RECOVERY);
}
