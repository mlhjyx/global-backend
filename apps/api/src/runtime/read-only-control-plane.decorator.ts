import { SetMetadata } from '@nestjs/common';

export const READ_ONLY_CONTROL_PLANE_METADATA =
  'runtime:read-only-control-plane' as const;

/**
 * Marks a code-owned handler as a zero-write control-plane read. The global
 * mutation admission guard may bypass only this static metadata; request data
 * can never opt into the exemption.
 */
export function ReadOnlyControlPlane(): MethodDecorator {
  return SetMetadata(READ_ONLY_CONTROL_PLANE_METADATA, true);
}
