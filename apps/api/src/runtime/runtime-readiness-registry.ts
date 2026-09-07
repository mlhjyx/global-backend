import { Injectable } from '@nestjs/common';
import {
  platformAutomationAggregateFromHealthProjection,
  projectPlatformAutomationReadinessForHealth,
  tryProjectPlatformAutomationReadinessForHealth,
  type PlatformAutomationHealthProjection,
} from '../platform-authority/platform-automation-readiness-health';

export type RuntimeComponentStatus =
  | Readonly<{ status: 'ok' }>
  | Readonly<{ status: 'failed'; code: string }>
  | Readonly<{ status: 'not_proven'; code: string }>;

export type RuntimeReadinessContributor = () =>
  | (RuntimeComponentStatus & Readonly<{ platformAutomation?: unknown }>)
  | Promise<RuntimeComponentStatus & Readonly<{ platformAutomation?: unknown }>>;

export type RuntimePlatformAutomationSnapshot = Readonly<{
  component: RuntimeComponentStatus;
  platformAutomation: PlatformAutomationHealthProjection;
}>;

function boundedComponent(value: unknown): RuntimeComponentStatus | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const status = descriptors.status;
    const code = descriptors.code;
    if (
      !status?.enumerable ||
      !Object.hasOwn(status, 'value') ||
      status.get !== undefined ||
      status.set !== undefined
    ) {
      return null;
    }
    if (status.value === 'ok') return Object.freeze({ status: 'ok' });
    if (
      (status.value === 'failed' || status.value === 'not_proven') &&
      code?.enumerable &&
      Object.hasOwn(code, 'value') &&
      code.get === undefined &&
      code.set === undefined &&
      typeof code.value === 'string' &&
      /^[A-Z][A-Z0-9_]{1,127}$/.test(code.value)
    ) {
      return Object.freeze({ status: status.value, code: code.value });
    }
  } catch {
    // Hostile values collapse to the bounded failed status below.
  }
  return null;
}

function platformAutomationValue(value: unknown): unknown {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }
    const descriptor = Object.getOwnPropertyDescriptor(
      value,
      'platformAutomation',
    );
    return descriptor?.enumerable &&
      Object.hasOwn(descriptor, 'value') &&
      descriptor.get === undefined &&
      descriptor.set === undefined
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function sameComponent(
  left: RuntimeComponentStatus,
  right: RuntimeComponentStatus,
): boolean {
  return (
    left.status === right.status &&
    (left.status === 'ok' ||
      (right.status !== 'ok' && left.code === right.code))
  );
}

@Injectable()
export class RuntimeReadinessContributorRegistry {
  private readonly contributors = new Map<string, RuntimeReadinessContributor>();

  register(name: string, contributor: RuntimeReadinessContributor): () => void {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) {
      throw new Error('readiness contributor name is invalid');
    }
    if (this.contributors.has(name)) {
      throw new Error(`readiness contributor ${name} is already registered`);
    }
    this.contributors.set(name, contributor);
    let registered = true;
    return () => {
      if (!registered) return;
      registered = false;
      if (this.contributors.get(name) === contributor) {
        this.contributors.delete(name);
      }
    };
  }

  async check(name: string): Promise<RuntimeComponentStatus> {
    const contributor = this.contributors.get(name);
    if (!contributor) {
      return { status: 'failed', code: 'READINESS_CONTRIBUTOR_MISSING' };
    }
    try {
      const result = await contributor();
      const component = boundedComponent(result);
      if (component) return component;
    } catch {
      // The public readiness report carries bounded codes only.
    }
    return { status: 'failed', code: 'READINESS_CONTRIBUTOR_FAILED' };
  }

  async checkPlatformAutomation(
    name: 'platform_budget_authority',
  ): Promise<RuntimePlatformAutomationSnapshot> {
    const contributor = this.contributors.get(name);
    if (!contributor) {
      return Object.freeze({
        component: {
          status: 'failed',
          code: 'READINESS_CONTRIBUTOR_MISSING',
        },
        platformAutomation:
          projectPlatformAutomationReadinessForHealth(undefined),
      });
    }
    try {
      const result = await contributor();
      const component = boundedComponent(result);
      const platformAutomation =
        tryProjectPlatformAutomationReadinessForHealth(
          platformAutomationValue(result),
        );
      if (
        !component ||
        !platformAutomation ||
        !sameComponent(
          component,
          platformAutomationAggregateFromHealthProjection(platformAutomation),
        )
      ) {
        return Object.freeze({
          component: {
            status: 'failed',
            code: 'READINESS_CONTRIBUTOR_FAILED',
          },
          platformAutomation:
            projectPlatformAutomationReadinessForHealth(undefined),
        });
      }
      return Object.freeze({
        component,
        platformAutomation,
      });
    } catch {
      return Object.freeze({
        component: {
          status: 'failed',
          code: 'READINESS_CONTRIBUTOR_FAILED',
        },
        platformAutomation:
          projectPlatformAutomationReadinessForHealth(undefined),
      });
    }
  }
}
